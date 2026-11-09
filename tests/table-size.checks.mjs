import {allocateTables} from '../src/allocation.mjs';
import {memberSizePreferences,normalizeSizePreferences,sizeBucket,TABLE_SIZE_POLICY} from '../src/table-size-policy.mjs';
import {allocationBonuses,rotationPoints} from '../src/rotation-policy.mjs';
const assert=(v,m='Assertion failed')=>{if(!v)throw new Error(m);};
const equal=(a,b,m='')=>assert(JSON.stringify(a)===JSON.stringify(b),m||`Expected ${JSON.stringify(a)} = ${JSON.stringify(b)}`);
export function fixture(n=4){
 const members=Array.from({length:n},(_,i)=>({id:String(i),name:'Member '+i,ratings:{x:'want',y:'want'},history:[],priorityGameId:null}));
 const games=['x','y'].map(id=>({id,title:'Game '+id,offers:members.map(m=>({userId:m.id,own:true,teach:true,counts:[2,3,4,5,6]}))}));
 return {members,games,fixedTables:[],tieBreakSeed:'2026-11-22'};
}
export function objective(input,result){
 let seats=0,priority=0,sizes=0,rotation=0,accommodation=0,desire=0;
 for(const t of result.tables){
  assert(t.memberIds.length>0);const g=input.games.find(g=>g.id===t.gameId);assert(g);
  const teacher=g.offers.find(o=>o.userId===t.teacherId);assert(teacher?.teach&&teacher.counts.includes(t.memberIds.length)&&t.memberIds.includes(t.teacherId));
  assert(g.offers.some(o=>o.userId===t.copyOwnerId&&o.own));
  for(const id of t.memberIds){const m=input.members.find(m=>m.id===id);assert(m);assert(['want','will'].includes(m.ratings[t.gameId]));assert(!m.restrictions?.[t.gameId]||m.restrictions[t.gameId].includes(t.memberIds.length));
   seats++;const b=allocationBonuses(m);if(!t.fixed){if(m.priorityGameId===t.gameId)priority+=b.priorityBase+b.waiting;if(m.ratings[t.gameId]==='want')accommodation+=b.accommodation;}
   if(memberSizePreferences(m,input.tieBreakSeed).includes(sizeBucket(t.memberIds.length)))sizes++;
   rotation+=rotationPoints(m,t.gameId);desire+=m.ratings[t.gameId]==='want'?2:1;
  }
 }
 equal(new Set(result.tables.flatMap(t=>t.memberIds)).size,seats,'Duplicated person');
 equal(new Set(result.tables.map(t=>JSON.stringify([t.gameId,t.copyOwnerId]))).size,result.tables.length,'Duplicated copy');
 return [seats,priority,sizes,rotation,accommodation,desire];
}
function lex(a,b){for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
/** Independent exhaustive enumeration with actual copies and teachers. Small n only. */
export function exhaustive(input){
 const n=input.members.length,valid=[];
 for(const game of input.games)for(let mask=1;mask<1<<n;mask++){
  const people=input.members.filter((_,i)=>mask&(1<<i)),count=people.length;
  if(people.some(m=>!['want','will'].includes(m.ratings[game.id])||(m.restrictions?.[game.id]&&!m.restrictions[game.id].includes(count))))continue;
  const teacher=game.offers.find(o=>o.teach&&o.counts.includes(count)&&people.some(m=>m.id===o.userId));if(!teacher)continue;
  for(const owner of game.offers.filter(o=>o.own&&input.members.some(m=>m.id===o.userId)))valid.push({mask,table:{gameId:game.id,memberIds:people.map(m=>m.id),teacherId:teacher.userId,copyOwnerId:owner.userId}});
 }
 let best=[0,0,0,0,0,0];
 function visit(available,tables,used){
  const result={tables};const score=objective(input,result);if(lex(score,best)>0)best=score;
  if(!available)return;const bit=available&-available;
  visit(available^bit,tables,used);
  for(const {mask,table} of valid){if(!(mask&bit)||(mask&available)!==mask)continue;const copy=JSON.stringify([table.gameId,table.copyOwnerId]);if(used.has(copy))continue;used.add(copy);visit(available^mask,[...tables,table],used);used.delete(copy);}
 }
 visit((1<<n)-1,[],new Set());return best;
}
export async function runSizeChecks(legacy=null){
 const checks=[];const test=async(name,fn)=>{try{await fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});}};
 await test('neutral, multiple selections and bucket boundaries',()=>{equal(normalizeSizePreferences(['5+','2','2']),['2','5+']);equal(normalizeSizePreferences(['2','3-4','5+']),[]);equal([1,2,3,4,5,12].map(sizeBucket),[null,'2','3-4','3-4','5+','5+']);});
 await test('current preferences do not leak into a later meeting seed',()=>{const m={tableSizePreferencesByMeeting:'{"2026-11-22":["2"]}'};equal(memberSizePreferences(m,'2026-11-22'),['2']);equal(memberSizePreferences(m,'2026-12-27'),[]);});
 await test('2P can split one game into multiple copies despite legal 4P',()=>{const x=fixture();x.games=x.games.slice(0,1);x.members.forEach(m=>m.tableSizePreferences=['2']);const r=allocateTables(x);equal(r.tables.map(t=>t.memberIds.length),[2,2]);equal(r.score.tableSizeMatches,4);});
 await test('3-4P favours an actual four-player table',()=>{const x=fixture();x.members.forEach(m=>m.tableSizePreferences=['3-4']);const r=allocateTables(x);equal(r.tables.length,1);equal(r.tables[0].memberIds.length,4);equal(r.score.tableSizeMatches,4);});
 await test('5+P favours a six-player table',()=>{const x=fixture(6);x.members.forEach(m=>m.tableSizePreferences=['5+']);const r=allocateTables(x);equal(r.tables.length,1);equal(r.score.tableSizeMatches,6);});
 await test('seating outranks an impossible size preference',()=>{const x=fixture(3);x.members.forEach(m=>m.tableSizePreferences=['2']);const r=allocateTables(x);equal(r.score.seated,3);equal(r.score.tableSizeMatches,0);equal(r.warnings,[]);});
 await test('eligible priorities outrank table-size preferences',()=>{const x=fixture();x.games[0].offers.forEach(o=>o.counts=[4]);x.games[1].offers.forEach(o=>o.counts=[2]);x.members.forEach(m=>m.tableSizePreferences=['2']);x.members[0].priorityGameId='x';const r=allocateTables(x);equal(r.tables[0].gameId,'x');equal(r.score.priority,6);});
 await test('date-specific size preference precedes rotation but does not override consent',()=>{const x=fixture();x.games[0].offers.forEach(o=>o.counts=[2]);x.games[1].offers.forEach(o=>o.counts=[4]);x.members.forEach(m=>{m.tableSizePreferences=['2'];m.history=[{gameId:'x',rating:'want'}];});let r=allocateTables(x);assert(r.tables.every(t=>t.gameId==='x'));x.members.forEach(m=>m.ratings.x='pass');r=allocateTables(x);assert(r.tables.every(t=>t.gameId==='y'));equal(r.score.seated,4);});
 await test('unrated and wrong teacher counts remain illegal',()=>{const x=fixture();x.games.forEach(g=>g.offers.forEach(o=>o.counts=[4]));x.members.forEach(m=>m.tableSizePreferences=['2']);let r=allocateTables(x);assert(r.tables.every(t=>t.memberIds.length===4));x.members[3].ratings={};r=allocateTables(x);equal(r.score.seated,0);});
 await test('copies remain hard resources when preferred split is unavailable',()=>{const x=fixture();x.games=x.games.slice(0,1);x.games[0].offers.forEach((o,i)=>o.own=i===0);x.members.forEach(m=>m.tableSizePreferences=['2']);const r=allocateTables(x);equal(r.tables.length,1);equal(r.score.seated,4);equal(r.score.tableSizeMatches,0);});
 await test('per-game member restrictions are still exact',()=>{const x=fixture();x.members[0].restrictions={x:[4],y:[4]};x.members.forEach(m=>m.tableSizePreferences=['2']);const r=allocateTables(x);equal(r.score.seated,4);equal(r.tables.find(t=>t.memberIds.includes('0')).memberIds.length,4);});
 await test('pre-arranged tables are not changed by size preferences',()=>{const x=fixture();x.members.forEach(m=>m.tableSizePreferences=['2']);x.fixedTables=[{gameId:'x',memberIds:x.members.map(m=>m.id),teacherId:'0',copyOwnerId:'0'}];const r=allocateTables(x);equal(r.tables[0].memberIds.length,4);assert(r.tables[0].fixed);equal(r.score.tableSizeMatches,0);});
 await test('scoring matches reconstructed assignments and preserves snapshot',()=>{const x=fixture(6);x.members.forEach((m,i)=>m.tableSizePreferences=[i<2?'2':'3-4']);const before=JSON.stringify(x),r=allocateTables(x);equal(JSON.stringify(x),before);equal([r.score.seated,r.score.priority,r.score.tableSizeMatches,r.score.rotation,r.score.accommodation,r.score.desire],objective(x,r));});
 await test('same input and reordered arrays repeat without rerolling',()=>{const x=fixture(6);x.members.forEach(m=>m.tableSizePreferences=['2']);const r=allocateTables(x);equal(allocateTables(x),r);x.members.reverse();x.games.reverse();x.games.forEach(g=>g.offers.reverse());equal(allocateTables(x),r);});
 await test('private table metadata contains size outcomes',()=>{const x=fixture();x.members[0].tableSizePreferences=['3-4'];const r=allocateTables(x);const p=r.tables.flatMap(t=>t.sizePreferences).find(p=>p.memberId==='0');assert(p.matched);equal(p.players,4);});
 await test('invalid or expired choices are neutral, not exclusion',()=>{const x=fixture();x.members.forEach(m=>m.tableSizePreferencesJson='not-json');equal(allocateTables(x).score.tableSizeMatches,0);equal(allocateTables(x).score.seated,4);});
 await test('exhaustive oracle agrees in 120 mixed scenarios',()=>{
  let seed=91;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let trial=0;trial<120;trial++){
   const x=fixture(2+trial%4);x.members.forEach(m=>{m.tableSizePreferences=[['2'],['3-4'],['5+'],[],['2','5+']][Math.floor(rnd()*5)];m.priorityGameId=rnd()<.2?'x':null;for(const g of x.games)m.ratings[g.id]=rnd()<.15?'pass':rnd()<.5?'want':'will';if(m.priorityGameId)m.ratings.x='want';m.history=rnd()<.6?[{gameId:rnd()<.5?'x':'y',rating:rnd()<.5?'want':'will'}]:[];});
   x.games.forEach(g=>g.offers.forEach(o=>{o.own=rnd()<.45;o.teach=rnd()<.6;o.counts=[2,3,4,5].filter(()=>rnd()<.7);}));
   const actual=allocateTables(x);equal(objective(x,actual),exhaustive(x),'Oracle mismatch '+trial);
  }
 });
 if(legacy)await test('200 neutral scenarios preserve previous assignments and scores',()=>{
  let seed=11;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let t=0;t<200;t++){const x=fixture(2+t%7);x.tieBreakSeed='2026-'+String(1+t%12).padStart(2,'0')+'-22';x.members.forEach(m=>{m.priorityGameId=rnd()<.2?'x':null;m.ratings={x:rnd()<.3?'will':'want',y:rnd()<.2?'pass':'want'};if(m.priorityGameId)m.ratings.x='want';m.history=Array.from({length:t%6},()=>({gameId:rnd()<.5?'x':'y',rating:rnd()<.5?'want':'will',fixed:rnd()<.1}));});x.games.forEach(g=>g.offers.forEach(o=>{o.own=rnd()<.5;o.teach=rnd()<.5;o.counts=[2,3,4,5,6].filter(()=>rnd()<.7);}));const a=allocateTables(x),b=legacy(x);const clean=r=>r.tables.map(({sizePreferences,...t})=>t);equal(clean(a),clean(b),'Neutral assignments '+t);for(const key of Object.keys(b.score))equal(a.score[key],b.score[key],key+' '+t);equal(a.unassignedMemberIds,b.unassignedMemberIds);equal(a.warnings,b.warnings);}
 });
 return {passed:checks.every(c=>c.passed),checks};
}
