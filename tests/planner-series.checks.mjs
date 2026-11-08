import {simulateMeetingSeries,validateSeriesOptions,allocationMemberBonuses,seriesResponse,withPlannerSeries,SERIES_API} from '../src/planner-series.mjs';
import {allocateTables} from '../src/allocation.mjs';
import {describePrivateResult} from '../src/private-planner.mjs';
const assert=(x,m='Assertion failed')=>{if(!x)throw Error(m);};
const equal=(a,b)=>assert(JSON.stringify(a)===JSON.stringify(b),'Expected '+JSON.stringify(a)+' = '+JSON.stringify(b));
const now=new Date('2026-11-08T12:00:00Z');
export function fixture(){
 const members=['a','b','c','d'].map((id,i)=>({id,name:'Member '+id.toUpperCase(),ratings:{x:'want',y:'want'},priorityGameId:i<2?['x','y'][i]:null,history:[],restrictions:{}}));
 const games=['x','y'].map(id=>({id,title:'Game '+id.toUpperCase(),offers:[{userId:'a',name:'Member A',own:true,teach:true,counts:[4]}]}));
 return {meeting:{id:'2026-11-22',label:'22 November 2026',status:'open',revision:3},input:{members,games,fixedTables:[],tieBreakSeed:'2026-11-22'}};
}
export function fakeDb(s=fixture()){
 let reads=0,writes=0;
 const input=s.input;
 const rows=sql=>{
  if(sql.includes('SELECT id,status,revision,fixed_json'))return [{...s.meeting,fixed_json:JSON.stringify(input.fixedTables)}];
  if(sql.includes('FROM meeting_exclusions'))return [];
  if(sql.includes('SELECT m.user_id AS id'))return input.members.map(m=>({id:m.id,name:m.name,priorityGameId:m.priorityGameId}));
  if(sql.includes('FROM attendance'))return input.members.map(m=>({meeting_id:s.meeting.id,user_id:m.id}));
  if(sql.includes('SELECT id,title,bgg_id FROM games'))return input.games.map(g=>({id:g.id,title:g.title,bgg_id:null}));
  if(sql.includes('SELECT o.*'))return input.games.flatMap(g=>g.offers.map(o=>({game_id:g.id,user_id:o.userId,name:o.name,own:+o.own,teach:+o.teach,counts_json:JSON.stringify(o.counts),pitch:''})));
  if(sql.includes('SELECT user_id,game_id,value'))return input.members.flatMap(m=>Object.entries(m.ratings).map(([game_id,value])=>({user_id:m.id,game_id,value})));
  if(sql.includes('FROM history'))return input.members.flatMap(m=>m.history.map((h,i)=>({meeting_id:'2026-01-'+String(i+1).padStart(2,'0'),user_id:m.id,game_id:h.gameId,rating:h.rating,priority_game_id:h.priorityGameId,priority_feasible:+!!h.priorityFeasible,fixed:+!!h.fixed})));
  throw Error('Unexpected query '+sql);
 };
 return {get reads(){return reads;},get writes(){return writes;},prepare(sql){if(!/^\s*SELECT\b/i.test(sql)){writes++;throw Error('Write attempted');}return {bind(){return this;},async all(){reads++;return {success:true,results:rows(sql),meta:{changes:0}};},async first(){reads++;return rows(sql)[0]??null;},run(){writes++;throw Error('Write attempted');}};},async batch(statements){return Promise.all(statements.map(s=>s.all()));}};
}
export async function runSeriesChecks(){
 const checks=[];
 const test=async(name,work)=>{try{await work();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});}};
 await test('six meetings carry history forward and do not mutate the snapshot',()=>{const s=fixture(),before=JSON.stringify(s),r=simulateMeetingSeries(s,{},now);equal(r.completedMeetings,6);equal(JSON.stringify(s),before);assert(r.rounds[0].people.find(p=>p.priorityTitle&&!p.priorityMet).after.waiting===1);});
 await test('first dummy assignment is exactly the normal private allocation',()=>{const s=fixture(),expected=describePrivateResult(s.meeting,s.input,allocateTables(s.input),now),r=simulateMeetingSeries(s,{},now);equal(r.rounds[0].tables.map(t=>[t.gameId,t.memberIds]),expected.tables.map(t=>[t.gameId,t.memberIds]));equal(r.rounds[0].score,expected.score);});
 await test('qualifying missed priority wins the next contested meeting',()=>{const r=simulateMeetingSeries(fixture(),{meetings:2},now);assert(r.rounds[0].tables[0].gameId!==r.rounds[1].tables[0].gameId);const winner=r.rounds[1].people.find(p=>p.priorityMet);equal(winner.before.waiting,1);equal(winner.after.waiting,0);});
 await test('same inputs repeat without rerolling',()=>equal(simulateMeetingSeries(fixture(),{},now),simulateMeetingSeries(fixture(),{},now)));
 await test('fourth-Sunday dummy dates cross year boundaries',()=>{const s=fixture();s.meeting.id='2026-12-27';const r=simulateMeetingSeries(s,{meetings:3},now);equal(r.rounds.map(x=>x.meeting.date),['2026-12-27','2027-01-24','2027-02-28']);equal(r.rounds.map(x=>x.tieBreak.seed),r.rounds.map(x=>x.meeting.date));});
 await test('clear fulfilled priorities is simulation-only and picks no replacement',()=>{const s=fixture(),r=simulateMeetingSeries(s,{meetings:6,clearFulfilled:true},now);equal(r.totals.filter(m=>m.initialPriority).map(m=>m.priorityMet),[1,1]);assert(r.rounds[2].people.every(p=>!p.priorityTitle));equal(s.input.members[0].priorityGameId,'x');});
 await test('keep-pick option matches live repeated-priority behaviour',()=>{const r=simulateMeetingSeries(fixture(),{meetings:6},now);assert(r.totals.some(t=>t.priorityMet>1));});
 await test('waiting caps at two and infeasible misses earn no waiting credit',()=>{const s=fixture(),m=s.input.members[0];m.history=Array.from({length:4},()=>({gameId:'y',rating:'want',priorityGameId:'x',priorityFeasible:true,fixed:false}));equal(allocationMemberBonuses(m,s.input.games).waiting,2);m.history.forEach(h=>h.priorityFeasible=false);equal(allocationMemberBonuses(m,s.input.games).waiting,0);});
 await test('accommodation counts Will plays and caps at two',()=>{const s=fixture(),m=s.input.members[0];m.history=Array.from({length:4},()=>({gameId:'y',rating:'will',priorityGameId:'x',priorityFeasible:true,fixed:false}));equal(allocationMemberBonuses(m,s.input.games),{accommodation:2,waiting:2,priorityValue:10});});
 await test('explanatory bonuses agree with live solver score',()=>{const s=fixture();s.input.members[2].ratings={x:'will',y:'want'};s.input.members[3].ratings={x:'want',y:'will'};const r=simulateMeetingSeries(s,{meetings:12},now);for(const round of r.rounds){const calculated=round.people.filter(p=>!p.prearranged).reduce((n,p)=>n+(p.priorityMet?p.before.priorityValue:p.preference==='want'?p.before.accommodation:0),0);equal(calculated,round.score.priorityAndFairness);}});
 await test('real reservations apply only to the first dummy meeting',()=>{const s=fixture();s.input.fixedTables=[{gameId:'x',memberIds:['a','b','c','d'],teacherId:'a',copyOwnerId:'a'}];const r=simulateMeetingSeries(s,{meetings:3},now);assert(r.rounds[0].tables[0].fixed);assert(!r.rounds[1].tables.some(t=>t.fixed));equal(r.rounds[0].people.find(p=>p.id==='b').after.waiting,0);});
 await test('partial allocation stops before manufacturing any history',()=>{const s=fixture();s.input.members[3].ratings={x:'pass',y:'pass'};const r=simulateMeetingSeries(s,{},now);equal(r.completedMeetings,0);equal(r.rounds.length,1);assert(r.stoppedReason);for(const p of r.rounds[0].people)equal(p.before,p.after);});
 await test('empty attendance gives a useful empty result',()=>{const s=fixture();s.input.members=[];const r=simulateMeetingSeries(s,{},now);equal(r.rounds,[]);assert(r.stoppedReason);});
 await test('settings reject dates, seeds, roles and out-of-range counts',()=>{for(const value of [[],null,{meetings:1},{meetings:13},{meetings:'6'},{meetings:2.5},{clearFulfilled:'true'},{seed:'reroll'},{role:'admin'},{date:'2027-01-01'},{members:[]}]){let failed=false;try{validateSeriesOptions(value);}catch{failed=true;}assert(failed,JSON.stringify(value));}});
 const makeRequest=(body={},extra={})=>new Request('https://test.example'+SERIES_API,{method:'POST',headers:{Origin:'https://test.example','Content-Type':'application/json',...(extra.headers||{})},body:typeof body==='string'?body:JSON.stringify(body)});
 const allow={async fetch(req){assert(req.method==='HEAD');assert(new URL(req.url).pathname==='/admin/planner-test');return new Response(null,{status:200});}};
 await test('authorised repeated API simulations issue only snapshot reads',async()=>{const db=fakeDb(),env={APP_URL:'https://test.example',DB:db};for(let i=0;i<2;i++){const r=await seriesResponse(makeRequest(),env,{},allow,now);equal(r.status,200);assert(r.headers.get('cache-control').includes('no-store'));equal((await r.json()).completedMeetings,6);}equal(db.reads,16);equal(db.writes,0);});
 await test('anonymous and ordinary members cannot read simulation data',async()=>{for(const code of [401,403]){const db=fakeDb(),r=await seriesResponse(makeRequest(),{APP_URL:'https://test.example',DB:db},{},{fetch:async()=>new Response(null,{status:code})},now);equal(r.status,code);equal(db.reads,0);}});
 await test('cross-origin request is rejected before session or snapshot reads',async()=>{const db=fakeDb(),r=await seriesResponse(makeRequest({}, {headers:{Origin:'https://other.example'}}),{APP_URL:'https://test.example',DB:db},{},{fetch(){throw Error('must not authenticate');}},now);equal(r.status,403);equal(db.reads,0);});
 await test('oversized and invalid request bodies fail without reading meeting data',async()=>{for(const [body,status]of [['x'.repeat(1100),413],['{oops',400],[{meetings:20},400]]){const db=fakeDb(),r=await seriesResponse(makeRequest(body),{APP_URL:'https://test.example',DB:db},{},allow,now);equal(r.status,status);equal(db.reads,0);}});
 await test('GET does not run simulations',async()=>equal((await seriesResponse(new Request('https://test.example'+SERIES_API),{}, {},allow,now)).status,405));
 await test('UI is injected only into authorised private page',async()=>{for(const status of [200,401,403,503]){const base={fetch:async()=>new Response('<html><head></head><body>Private</body></html>',{status,headers:{'Content-Type':'text/html'}})};const app=withPlannerSeries(base,{javascript:'test',css:'test'});const r=await app.fetch(new Request('https://test.example/admin/planner-test'),{},{});equal((await r.text()).includes('planner-series.js'),status===200);}});
 return {passed:checks.every(c=>c.passed),checks,sample:simulateMeetingSeries(fixture(),{},now)};
}
