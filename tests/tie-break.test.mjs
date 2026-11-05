import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import allocateTables from '../src/allocation.mjs';
import {createMeetingTieBreak, TIE_BREAK_METHOD} from '../src/tie-break.mjs';

const member = (id, ratings, extra={}) => ({id,name:id,ratings,history:[],...extra});
const offer = (userId,counts,extra={}) => ({userId,own:true,teach:true,counts,...extra});
const game = (id,offers) => ({id,title:id,offers});
const dates = Array.from({length:48},(_,i)=>`${2026+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}-22`);
const tied = () => ({members:[member('a',{alpha:'want',zulu:'want'},{priorityGameId:'alpha'}),member('b',{alpha:'want',zulu:'want'},{priorityGameId:'zulu'})],games:[game('alpha',[offer('a',[2])]),game('zulu',[offer('b',[2])])]});
const canonical = result => JSON.stringify(result.tables.map(t=>[t.gameId,[...t.memberIds].sort()]).sort());
function assertLegal(input,result) {
  const people=new Map(input.members.map(m=>[m.id,m]));
  const games=new Map(input.games.map(g=>[g.id,g]));
  const used=new Set(),copies=new Set();
  for(const t of result.tables) {
    const g=games.get(t.gameId);
    assert.ok(t.memberIds.includes(t.teacherId));
    assert.ok(g.offers.some(o=>o.userId===t.teacherId&&o.teach&&o.available!==false&&o.counts.includes(t.memberIds.length)));
    assert.ok(people.has(t.copyOwnerId));
    assert.ok(g.offers.some(o=>o.userId===t.copyOwnerId&&o.own&&o.available!==false));
    const copy=JSON.stringify([t.gameId,t.copyOwnerId]);assert.ok(!copies.has(copy));copies.add(copy);
    for(const id of t.memberIds) {
      assert.ok(!used.has(id));used.add(id);
      assert.ok(['want','will'].includes(people.get(id).ratings[t.gameId]));
      const counts=people.get(id).restrictions?.[t.gameId]; if(counts)assert.ok(counts.includes(t.memberIds.length));
    }
  }
  assert.equal(used.size,result.score.seated);
}

test('same meeting and inputs reproduce exactly without using time or runtime randomness',t=>{
  const input={...tied(),tieBreakSeed:'2026-11-22'};
  const before=structuredClone(input); const expected=allocateTables(input);
  t.mock.method(Math,'random',()=>{throw new Error('A click must not reroll');});
  t.mock.method(Date,'now',()=>{throw new Error('The clock must not choose a draw');});
  for(let i=0;i<20;i++)assert.deepEqual(allocateTables(input),expected);
  assert.deepEqual(input,before);
  assert.deepEqual(expected.tieBreak,{method:TIE_BREAK_METHOD,seed:'2026-11-22'});
});
test('input ordering and presentation names do not change the draw',()=>{
  const input={...tied(),tieBreakSeed:'2026-12-27'};const expected=allocateTables(input);
  const shuffled={...input,members:[...input.members].reverse(),games:[...input.games].reverse().map(g=>({...g,offers:[...g.offers].reverse()}))};
  assert.deepEqual(allocateTables(shuffled),expected);
  assert.equal(canonical(allocateTables({...input,members:input.members.map(m=>({...m,name:'Renamed '+m.id})),games:input.games.map(g=>({...g,title:'Renamed '+g.id}))})),canonical(expected));
});
test('both tied priority games can win across meetings; primary scores stay equal',()=>{
  const winners=new Map();const baseline=allocateTables(tied()).score;
  for(const date of dates){const r=allocateTables({...tied(),tieBreakSeed:date});assert.deepEqual(r.score,baseline);const id=r.tables[0].gameId;winners.set(id,(winners.get(id)||0)+1);}
  assert.deepEqual([...winners.keys()].sort(),['alpha','zulu']);
});
test('tied seat assignments also vary rather than always favouring the lowest member ID',()=>{
  const input={members:['a','b','c'].map(id=>member(id,{g:'want'})),games:[game('g',[offer('a',[2])])]};
  const seated=new Set();for(const date of dates){const r=allocateTables({...input,tieBreakSeed:date});assertLegal(input,r);seated.add(r.tables[0].memberIds.find(id=>id!=='a'));}
  assert.deepEqual([...seated].sort(),['b','c']);
});
test('same-game multiple-table partitions vary without consuming a copy twice',()=>{
  const input={members:['a','b','c','d'].map(id=>member(id,{g:'want'})),games:[game('g',['a','b','c','d'].map((id,i)=>offer(id,[2],{own:i<2})))]};
  const layouts=new Set();for(const date of dates){const r=allocateTables({...input,tieBreakSeed:date});assertLegal(input,r);assert.equal(r.score.seated,4);layouts.add(canonical(r));}
  assert.ok(layouts.size>1);
});
test('a waiting bonus always defeats the final tie-break regardless of meeting',()=>{
  const input=tied();input.members[1].history=[{gameId:'alpha',rating:'want',priorityGameId:'zulu',priorityFeasible:true,fixed:false}];
  for(const date of dates)assert.equal(allocateTables({...input,tieBreakSeed:date}).tables[0].gameId,'zulu');
});
test('Want beats Will play before any final draw',()=>{
  const input=tied();for(const m of input.members)m.priorityGameId=null;input.members[0].ratings.alpha='will';
  for(const date of dates)assert.equal(allocateTables({...input,tieBreakSeed:date}).tables[0].gameId,'zulu');
});
test('seating more people outranks priority picks for every seed',()=>{
  const input={members:['a','b','c','d','e','f'].map((id,i)=>member(id,{fav:i<4?'want':'pass',left:i<3?'will':'pass',right:i>=3?'will':'pass'},{priorityGameId:i<4?'fav':null})),games:[game('fav',[offer('a',[4])]),game('left',[offer('b',[3])]),game('right',[offer('e',[3])])]};
  for(const date of dates){const r=allocateTables({...input,tieBreakSeed:date});assertLegal(input,r);assert.equal(r.score.seated,6);assert.deepEqual(r.tables.map(t=>t.gameId),['left','right']);}
});
test('pre-arranged tables and exact count restrictions remain unchanged',()=>{
  const input={members:['a','b','c','d','e','f'].map(id=>member(id,{g:'want',h:'will'},{restrictions:{g:[2],h:[2,4]}})),games:[game('g',[offer('a',[2])]),game('h',[offer('c',[2,4])])],fixedTables:[{gameId:'g',memberIds:['a','b'],teacherId:'a',copyOwnerId:'a'}]};
  const expected=allocateTables(input).tables.find(t=>t.fixed);
  for(const date of dates){const r=allocateTables({...input,tieBreakSeed:date});assertLegal(input,r);assert.deepEqual(r.tables.find(t=>t.fixed),expected);assert.equal(r.score.seated,6);}
});
test('seeded and legacy ordering achieve identical objective scores on 100 mixed scenarios',()=>{
  let state=11987;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(let trial=0;trial<100;trial++){
    const ids=Array.from({length:2+trial%7},(_,i)=>'p'+i);const titles=['g0','g1','g2','g3'];
    const input={members:ids.map(id=>member(id,Object.fromEntries(titles.map(g=>[g,['want','will','pass',undefined][Math.floor(random()*4)]])),{priorityGameId:titles[Math.floor(random()*4)],history:random()<.5?[{gameId:'old',rating:'will'}]:[]})),games:titles.map(g=>game(g,ids.map(id=>offer(id,random()<.5?[2,4]:[3],{own:random()<.4,teach:random()<.6}))))};
    const optimum=allocateTables(input).score;
    for(const date of dates.slice(0,6)){const r=allocateTables({...input,tieBreakSeed:date});assertLegal(input,r);assert.deepEqual(r.score,optimum,`trial ${trial}`);}
  }
});
test('invalid and missing seeds are handled explicitly and legacy results remain available',()=>{
  assert.equal(createMeetingTieBreak(undefined),null);assert.equal(createMeetingTieBreak(''),null);
  for(const bad of [42,{},'x'.repeat(129)])assert.throws(()=>createMeetingTieBreak(bad),TypeError);
  assert.equal(allocateTables(tied()).tables[0].gameId,'alpha');
});
test('server binds the draw to the selected meeting and saves its metadata with the plan',async()=>{
  const api=await readFile(new URL('../src/api.mjs',import.meta.url),'utf8');
  assert.match(api,/allocateTables\(\{\.\.\.input, tieBreakSeed:meeting\.id\}\)/);
  assert.match(api,/const plan = \{\.\.\.result,snapshot:planSnapshot\(input,result\)\}/);
  assert.doesNotMatch(api,/tieBreakSeed\s*:\s*(body|request)\./);
});
test('12 attendees remain practical with 24 interchangeable games',()=>{
  const ids=Array.from({length:12},(_,i)=>'p'+i),titles=Array.from({length:24},(_,i)=>'g'+i);
  const input={members:ids.map(id=>member(id,Object.fromEntries(titles.map(g=>[g,'want'])))),games:titles.map((g,j)=>game(g,ids.map((id,i)=>offer(id,[2,4],{own:i===j%12})))),tieBreakSeed:'2026-11-22'};
  const result=allocateTables(input);assertLegal(input,result);assert.equal(result.score.seated,12);
});
