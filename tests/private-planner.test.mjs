import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {allocateTables} from '../src/allocation.mjs';
import {privateTestResponse,readPrivateInput,readOnlyDatabase,withPrivatePlanner,PRIVATE_API,PRIVATE_PAGE} from '../src/private-planner.mjs';
const NOW=new Date('2026-11-08T01:00:00Z'), ORIGIN='https://collective.test', DATE='2026-11-22';
const authSchema=await readFile(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8');
const appSchema=await readFile(new URL('../migrations/0002_app.sql',import.meta.url),'utf8');
function setup() {
  const sql=new DatabaseSync(':memory:');sql.exec(authSchema+appSchema);
  sql.exec('ALTER TABLE games ADD COLUMN archived_at INTEGER;CREATE TABLE meeting_exclusions(meeting_id TEXT PRIMARY KEY,removed_at INTEGER);');
  const queries=[];
  const DB={prepare(query){queries.push(query);const s=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return s.get(...args)||null;},async all(){return {success:true,results:s.all(...args)};},async raw(){return s.all(...args);},async run(){return {success:true,meta:{changes:s.run(...args).changes}};}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.all());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}},exec(){throw new Error('No exec in fixture adapter');}};
  function member(id,role='member') {
    sql.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id,'Member '+id,id+'@example.test');
    sql.prepare('INSERT INTO members(user_id,role,created_at) VALUES (?,?,0)').run(id,role);
  }
  for(const id of ['a','b','c','d'])member(id,id==='a'?'admin':'member');
  for(const id of ['g1','g2'])sql.prepare('INSERT INTO games(id,title,normalized_title,created_at) VALUES (?,?,?,0)').run(id,id==='g1'?'Ancients':'Friedrich',id);
  for(const [id,game] of [['a','g1'],['c','g2']])sql.prepare('INSERT INTO offers(user_id,game_id,own,teach,counts_json,pitch) VALUES (?,?,1,1,?,?)').run(id,game,'[2]','');
  sql.prepare('INSERT INTO meetings(id,status,revision,plan_json,updated_at) VALUES (?,\'locked\',7,?,1)').run(DATE,JSON.stringify({sentinel:'public plan must survive',tables:[]}));
  for(const id of ['a','b','c','d']) {
    sql.prepare('INSERT INTO attendance(meeting_id,user_id,coming) VALUES (?,?,1)').run(DATE,id);
    sql.prepare('INSERT INTO ratings(user_id,game_id,value,updated_at) VALUES (?,?,?,0)').run(id,['a','b'].includes(id)?'g1':'g2',id==='d'?'will':'want');
  }
  sql.prepare('UPDATE members SET priority_game_id=? WHERE user_id=?').run('g1','a');
  sql.prepare('UPDATE members SET priority_game_id=? WHERE user_id=?').run('g2','c');
  sql.prepare('INSERT INTO notification_outbox(id,user_id,meeting_id,subject,body,created_at) VALUES (\'keep\',\'a\',?,\'keep\',\'keep\',0)').run(DATE);
  const authCalls=[];
  const authenticate=async(request,env)=>{authCalls.push('session');const id=request.headers.get('cookie');return id?{user:{id},session:{id:'fixture-only'}}:null;};
  const base={async fetch(){throw new Error('A private run must not call any public route');}};
  const env={DB,APP_URL:ORIGIN};
  const req=(id='a',body={},options={})=>new Request(ORIGIN+PRIVATE_API,{method:options.method||'POST',headers:{Origin:options.origin??ORIGIN,'Content-Type':options.type||'application/json',...(id?{Cookie:id}:{}),...(options.headers||{})},...(options.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const run=(request=req())=>privateTestResponse(request,env,{waitUntil(){throw new Error('Test must not enqueue work');}},authenticate,NOW);
  const snapshot=()=>JSON.stringify(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,sql.prepare('SELECT * FROM "'+name+'"').all()]));
  return {sql,DB,env,base,authenticate,req,run,queries,authCalls,snapshot,member};
}

test('private run uses the same live solver and meeting tie-break',async()=>{
  const s=setup(), {input}=await readPrivateInput(s.env,NOW), expected=allocateTables(input);
  const r=await s.run();assert.equal(r.status,200);const data=await r.json();
  assert.deepEqual(data.score,expected.score);assert.deepEqual(data.tieBreak,expected.tieBreak);
  assert.deepEqual(data.tables.map(t=>[t.gameId,t.memberIds,t.teacherId,t.copyOwnerId]),expected.tables.map(t=>[t.gameId,t.memberIds,t.teacherId,t.copyOwnerId]));
  assert.equal(data.private,true);assert.equal(data.persisted,false);assert.equal(data.summary.seated,4);
  assert.equal(data.summary.want,3);assert.equal(data.summary.will,1);assert.equal(data.summary.priorityMet,2);
  assert.match(r.headers.get('cache-control'),/private.*no-store/);
});
test('repeated tests leave every database row including published plan and outbox unchanged',async()=>{
  const s=setup(), before=s.snapshot();const a=await(await s.run()).json();const b=await(await s.run()).json();
  assert.deepEqual(a,b);assert.equal(s.snapshot(),before);assert.ok(s.queries.every(q=>/^SELECT\b/i.test(q)));
  assert.ok(s.authCalls.every(p=>p==='session'));
});
test('current fixed tables are respected but never rewritten',async()=>{
  const s=setup(), fixed=[{gameId:'g1',memberIds:['a','b'],teacherId:'a',copyOwnerId:'a'}];
  s.sql.prepare('UPDATE meetings SET fixed_json=? WHERE id=?').run(JSON.stringify(fixed),DATE);
  const before=s.snapshot(), r=await(await s.run()).json();
  assert.equal(r.tables.filter(t=>t.fixed).length,1);assert.equal(r.summary.reservations,1);assert.equal(r.score.seated,4);assert.equal(s.snapshot(),before);
});
test('invalid reservations are explained, not repaired or saved by the private test',async()=>{
  const s=setup();s.sql.prepare('UPDATE meetings SET fixed_json=? WHERE id=?').run(JSON.stringify([{gameId:'g1',memberIds:['a','b'],teacherId:'b',copyOwnerId:'a'}]),DATE);
  const before=s.snapshot(), r=await(await s.run()).json();assert.ok(r.warnings.length);assert.ok(r.unassigned.length);assert.equal(s.snapshot(),before);
});
test('ordinary members, disabled organisers, and anonymous requests cannot run the test',async()=>{
  const s=setup();assert.equal((await s.run(s.req('b'))).status,403);assert.equal((await s.run(s.req(null))).status,401);
  s.sql.prepare('UPDATE members SET disabled=1 WHERE user_id=\'a\'').run();assert.equal((await s.run()).status,403);
});
test('forged administrator body cannot bypass real membership check',async()=>{
  const s=setup();assert.equal((await s.run(s.req('b',{role:'admin'}))).status,403);
});
test('cross-site, missing-origin and non-POST calls are rejected before work',async()=>{
  const s=setup();assert.equal((await s.run(s.req('a',{}, {origin:'https://elsewhere.test'}))).status,403);
  assert.equal((await s.run(s.req('a',{}, {origin:''}))).status,403);
  assert.equal((await s.run(s.req('a',{}, {headers:{'Sec-Fetch-Site':'cross-site'}}))).status,403);
  assert.equal((await s.run(s.req('a',{}, {method:'GET'}))).status,405);assert.equal(s.authCalls.length,0);
});
test('request cannot change attendance, ratings, meeting, reservations or tie-break seed',async()=>{
  const s=setup(), before=s.snapshot();for(const body of [{tieBreakSeed:'reroll'},{meetingDate:'2099-01-01'},{members:[]},{ratings:{}},{fixedTables:[]}])assert.equal((await s.run(s.req('a',body))).status,400);
  assert.equal(s.snapshot(),before);
});
test('malformed, non-object, oversized and non-JSON bodies are rejected',async()=>{
  const s=setup();for(const text of ['not-json','[]','null','1'])assert.equal((await s.run(s.req('a',text))).status,400);
  assert.equal((await s.run(s.req('a',' '.repeat(1025)))).status,413);
  assert.equal((await s.run(s.req('a',{}, {type:'text/plain'}))).status,415);
});
test('read-only database guard blocks mutations even inside the session delegate',async()=>{
  const s=setup(), db=readOnlyDatabase(s.DB), before=s.snapshot();
  assert.throws(()=>db.prepare('UPDATE meetings SET plan_json=NULL'));
  assert.throws(()=>db.prepare('SELECT 1; DELETE FROM history'));
  assert.throws(()=>db.exec('DELETE FROM games'));
  assert.throws(()=>db.batch([s.DB.prepare('SELECT 1')]));
  const hostile=async(request,env)=>{env.DB.prepare('DELETE FROM session').run();return null;};
  assert.equal((await privateTestResponse(s.req(),s.env,{},hostile,NOW)).status,401);assert.equal(s.snapshot(),before);
});
test('only current active attendees are allocated; withdrawn and disabled members are excluded',async()=>{
  const s=setup();s.member('e');s.member('f');
  s.sql.prepare('INSERT INTO attendance(meeting_id,user_id,coming) VALUES (?,\'f\',1)').run(DATE);
  s.sql.exec("UPDATE members SET disabled=1 WHERE user_id='f';UPDATE attendance SET coming=0 WHERE user_id='d';");
  const r=await(await s.run()).json();assert.deepEqual(r.people.map(p=>p.id),['a','b','c']);assert.equal(r.summary.attendees,3);
});
test('archived games are excluded and Pass is never treated as consent',async()=>{
  const s=setup();s.sql.exec("UPDATE games SET archived_at=123 WHERE id='g2';UPDATE ratings SET value='pass' WHERE user_id='b';");
  const r=await(await s.run()).json();assert.equal(r.summary.seated,0);assert.equal(r.unassigned.length,4);
});
test('exact teacher counts remain hard requirements',async()=>{
  const s=setup();s.sql.exec("UPDATE offers SET counts_json='[5]' WHERE game_id='g1';");
  const r=await(await s.run()).json();assert.equal(r.summary.seated,2);assert.deepEqual(r.unassigned.map(p=>p.id),['a','b']);
});
test('missing copy or nonattending teacher prevents an invented table',async()=>{
  const s=setup();s.sql.exec("UPDATE offers SET own=0 WHERE game_id='g1';UPDATE attendance SET coming=0 WHERE user_id='c';");
  const r=await(await s.run()).json();assert.equal(r.summary.seated,0);
});
test('no attendees produces an informative empty result without changing stored plans',async()=>{
  const s=setup();s.sql.exec('UPDATE attendance SET coming=0');const before=s.snapshot(),r=await(await s.run()).json();assert.equal(r.summary.attendees,0);assert.deepEqual(r.tables,[]);assert.equal(s.snapshot(),before);
});
test('next regular meeting can be tested without creating a meeting row',async()=>{
  const s=setup();s.sql.exec('DELETE FROM attendance;DELETE FROM notification_outbox;DELETE FROM meetings');const before=s.snapshot();
  const r=await(await s.run()).json();assert.equal(r.meeting.date,DATE);assert.equal(r.summary.attendees,0);assert.equal(s.snapshot(),before);
});
test('manual earlier meeting is selected and cancelled fourth Sundays stay cancelled',async()=>{
  const s=setup();s.sql.prepare('INSERT INTO meetings(id,updated_at) VALUES (?,0)').run('2026-11-15');
  assert.equal((await(await s.run()).json()).meeting.date,'2026-11-15');
  s.sql.prepare('INSERT INTO meeting_exclusions(meeting_id) VALUES (?)').run('2026-11-15');
  s.sql.prepare('INSERT INTO meeting_exclusions(meeting_id) VALUES (?)').run(DATE);
  const before=s.snapshot();assert.equal((await(await s.run()).json()).meeting.date,'2026-12-27');assert.equal(s.snapshot(),before);
});
test('twelve-attendee boundary matches the live API, not a silent approximate allocation',async()=>{
  const s=setup();for(let i=0;i<9;i++){const id='extra'+i;s.member(id);s.sql.prepare('INSERT INTO attendance(meeting_id,user_id,coming) VALUES (?,?,1)').run(DATE,id);}
  const before=s.snapshot();assert.equal((await s.run()).status,422);assert.equal(s.snapshot(),before);
});
test('history is mapped exactly as the live input and capped at the latest 24 plays',async()=>{
  const s=setup();s.sql.exec("INSERT INTO meetings(id,status,updated_at) VALUES ('2026-10-25','completed',0);INSERT INTO history(meeting_id,user_id,game_id,rating,priority_game_id,priority_feasible,fixed) VALUES ('2026-10-25','a','g2','will','g1',1,0);");
  const {input}=await readPrivateInput(s.env,NOW);assert.deepEqual(input.members[0].history,[{gameId:'g2',rating:'will',priorityGameId:'g1',priorityFeasible:true,fixed:false}]);
  const r=await(await s.run()).json();assert.deepEqual(r.score,allocateTables(input).score);assert.equal(r.score.priorityAndFairness,14);
});
test('no external API is called by testing, and no credentials or raw history are returned',async t=>{
  const s=setup();t.mock.method(globalThis,'fetch',()=>assert.fail('No external requests allowed'));
  const r=await(await s.run()).json();assert.equal(r.people[0].history,undefined);const text=JSON.stringify(r);assert.doesNotMatch(text,/example\.test|fixture-only|public plan must survive/);
});
test('private page enforces organiser access independently of link visibility',async()=>{
  const s=setup(), app=withPrivatePlanner(s.base,{javascript:'safe',css:'safe'},s.authenticate);
  let r=await app.fetch(new Request(ORIGIN+PRIVATE_PAGE,{headers:{Cookie:'b'}}),s.env,{});assert.equal(r.status,403);assert.match(await r.text(),/active organiser/);
  r=await app.fetch(new Request(ORIGIN+PRIVATE_PAGE,{headers:{Cookie:'a'}}),s.env,{});assert.equal(r.status,200);const html=await r.text();assert.match(html,/Run private test/);assert.doesNotMatch(html,/Member a|Member b/);assert.match(r.headers.get('cache-control'),/no-store/);
});
test('wrapper preserves unrelated routes, scheduler, policy and health fields',async()=>{
  const s=setup(), base={scheduled(){return 'unchanged';},async fetch(request){const path=new URL(request.url).pathname;return path==='/api/health'?Response.json({ok:true,catalogue:'1.4.0',tieBreakMethod:'meeting-seeded-order-v1'}):new Response('<html><head></head><body>Original planner</body></html>',{headers:{'Content-Type':'text/html','Content-Security-Policy':"script-src 'self'"}});}};
  const app=withPrivatePlanner(base,{javascript:'client',css:'css'});assert.equal(app.scheduled(), 'unchanged');
  const health=await(await app.fetch(new Request(ORIGIN+'/api/health'),s.env,{})).json();assert.equal(health.catalogue,'1.4.0');assert.equal(health.privatePlanner,'1.4.1');
  const r=await app.fetch(new Request(ORIGIN+'/'),s.env,{});assert.equal(r.headers.get('Content-Security-Policy'),"script-src 'self'");const html=await r.text();assert.match(html,/Original planner/);assert.match(html,/private-planner\.js/);
});
test('private client has no publication, result-recording, localStorage or telemetry calls',async()=>{
  const js=await readFile(new URL('../public/private-planner.js',import.meta.url),'utf8');
  assert.match(js,/\/api\/admin\/planner-test/);assert.doesNotMatch(js,/\/api\/admin\/(?:plan['"/?]|lock|complete)|localStorage|sessionStorage|sendBeacon/);
});
