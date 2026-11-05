import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normaliseSearchTitle,rankSearchResults,withRankedSearch} from '../src/search-ranking.mjs';
const entries = titles => titles.map((title,i)=>({title,bggId:i+1,year:2000+i}));
const titles = rows => rows.map(row=>row.title);

test('exact Root outranks alphabetically earlier partial matches',()=>{
 assert.deepEqual(titles(rankSearchResults(entries(['A Root Story','Root: The Riverfolk Expansion','Root','Rooted','Beetroot']),'Root')),['Root','Root: The Riverfolk Expansion','A Root Story','Rooted','Beetroot']);
});
test('case, diacritics, whitespace and punctuation do not hide an exact match',()=>{
 for (const [query,title] of [['friedrich','FRIEDRICH'],['cafe','Café'],['north africa 41',"North Africa ’41"],['commands and colors','Commands & Colors'],['  ROOT  ','Root']]) {
  assert.equal(rankSearchResults(entries(['A '+title+' Story',title]),query)[0].title,title);
 }
});
test('complete titles beat editions and subtitles, which beat phrase matches',()=>{
 const result=rankSearchResults(entries(['A Game of Successors','Successors (Fourth Edition)','Successors']),'successors');
 assert.deepEqual(titles(result),['Successors','Successors (Fourth Edition)','A Game of Successors']);
});
test('shorter qualified title is preferred to a long title with the same prefix',()=>{
 assert.deepEqual(titles(rankSearchResults(entries(['Root The Clockwork Expansion','Root Riverfolk','Root']),'Root')),['Root','Root Riverfolk','Root The Clockwork Expansion']);
});
test('words together are better than separated words; partial matches remain available',()=>{
 assert.deepEqual(titles(rankSearchResults(entries(['Roman Civil War','The Civil War','Civil War','Civilian Warlords']),'civil war')),['Civil War','The Civil War','Roman Civil War','Civilian Warlords']);
});
test('ranking the complete response before its cap retains late exact matches',()=>{
 const input=entries(Array.from({length:45},(_,i)=>'A Root Game '+i));
 input.push({title:'Root',bggId:237182,year:2018});
 const top=rankSearchResults(input,'Root').slice(0,25);
 assert.equal(top.length,25);assert.equal(top[0].bggId,237182);
});
test('an existing group entry does not push an unrelated partial title above an exact title',()=>{
 const input=[{title:'A Root Story',bggId:1,year:2024,existingGameId:'local'}, {title:'Root',bggId:237182,year:2018,existingGameId:null}];
 assert.equal(rankSearchResults(input,'root')[0].title,'Root');
 assert.equal(rankSearchResults(input,'root')[1].existingGameId,'local');
});
test('equivalent matches prefer existing entries, without overwriting metadata',()=>{
 const input=[{title:'Root',bggId:1,year:2018},{title:'Root',bggId:2,year:2019,existingGameId:'saved'}];
 assert.equal(rankSearchResults(input,'root')[0],input[1]);
 assert.deepEqual(input.map(i=>i.bggId),[1,2]);
});
test('empty and punctuation-only queries preserve a copy of the incoming order',()=>{
 const input=entries(['Z','A']);
 for(const query of ['',null,'---']) {const result=rankSearchResults(input,query);assert.deepEqual(result,input);assert.notEqual(result,input);}
 assert.equal(normaliseSearchTitle('  Root — The Marauder  '),'root the marauder');
 assert.deepEqual(rankSearchResults(null,'root'),[]);
});
test('merged-result wrapper preserves response flags, headers and scheduling',async()=>{
 const body={results:entries(['A Root Story','Root']),externalAvailable:true,message:''};
 const scheduled=()=>{};let baseCalls=0;
 const base={scheduled,async fetch(req,env,ctx){baseCalls++;assert.equal(env.test,true);return Response.json(body,{headers:{'Cache-Control':'no-store','X-Frame-Options':'DENY','ETag':'stale','Content-Length':'123'}});}};
 const wrapper=withRankedSearch(base);
 const res=await wrapper.fetch(new Request('https://collective.test/api/search?q=Root'),{test:true},{});
 const data=await res.json();assert.equal(data.results[0].title,'Root');assert.equal(data.externalAvailable,true);assert.equal(data.message,'');
 assert.equal(res.headers.get('X-Frame-Options'),'DENY');assert.equal(res.headers.get('Cache-Control'),'no-store');assert.equal(res.headers.get('Content-Length'),null);assert.equal(res.headers.get('ETag'),null);assert.equal(baseCalls,1);assert.equal(wrapper.scheduled,scheduled);
});
test('authentication and rate-limit errors pass through unchanged',async()=>{
 for(const status of [401,403,429,503]) {
  const original=Response.json({error:'Denied'},{status});
  const wrapper=withRankedSearch({fetch:async()=>original});
  assert.equal(await wrapper.fetch(new Request('https://collective.test/api/search?q=root'),{},{}),original);
 }
});
test('unrelated paths and non-GET requests are not rewritten',async()=>{
 for(const [path,method] of [['/api/bootstrap','GET'],['/api/search','POST'],['/','GET'],['/api/search','HEAD']]) {
  const original=Response.json({results:entries(['Z','A'])});
  assert.equal(await withRankedSearch({fetch:async()=>original}).fetch(new Request('https://collective.test'+path,{method}),{},{}),original);
 }
});
test('local fallback results are ranked even while external search is unavailable',async()=>{
 const original=Response.json({externalAvailable:false,message:'Manual entry remains available.',results:entries(['A Root Story','Root'])});
 const res=await withRankedSearch({fetch:async()=>original}).fetch(new Request('https://collective.test/api/search?q=root'),{},{});
 const data=await res.json();assert.equal(data.results[0].title,'Root');assert.equal(data.externalAvailable,false);assert.equal(data.message,'Manual entry remains available.');
});
test('search source ranks before applying its limit and ignores obsolete truncated caches',async()=>{
 const source=await readFile(new URL('../src/bgg.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('rankSearchResults(results, query).slice(0, MAX_RESULTS)'));
 assert.ok(!source.includes('if (results.length === MAX_RESULTS) break'));
 assert.ok(source.includes('"search:v2:" + term.toLowerCase()'));
 assert.ok(source.includes('redirect: "manual"'));
});
