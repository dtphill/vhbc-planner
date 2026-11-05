import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {safeThumbnail,parseThumbnails,boundedBytes,thumbnailResponse,withGameMedia,BADGE_URL,MEDIA_VERSION} from '../src/game-media.mjs';
const good='https://cf.geekdo-images.com/abc__thumb/img/id=/fit-in/200x150/filters:format(jpeg)/pic1.jpg';
const xml=(id=1,url=good)=>`<?xml version="1.0"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"><item type="boardgame" id="${id}"><thumbnail>${url.replaceAll('&','&amp;')}</thumbnail><minplayers value="1"/><maxplayers value="6"/></item></items>`;
function database(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE bgg_cache(query TEXT PRIMARY KEY,response TEXT,expires_at INTEGER); CREATE TABLE request_limits(key TEXT PRIMARY KEY,count INTEGER,expires_at INTEGER);');
 return {sqlite,prepare(sql){const s=sqlite.prepare(sql);return {args:[],bind(...args){this.args=args;return this;},async first(){return s.get(...this.args)||null;},async all(){return {results:s.all(...this.args)};},async run(){return {meta:{changes:s.run(...this.args).changes}};}};},async batch(statements){const out=[];for(const s of statements)out.push(await s.run());return out;}};
}
function setup(user={id:'member'},ids=[1,2]){
 const db=database();
 const base={async fetch(req){assert.equal(new URL(req.url).pathname,'/api/bootstrap');return Response.json({user,games:ids.map(bggId=>({bggId})),private:'not for the image response'});}};
 return {db,env:{DB:db,BGG_TOKEN:'test-token-only'},base,ctx:{waitUntil(){}},request:new Request('https://test.example/api/game-thumbnails?ids=1',{headers:{Cookie:'session=test'}})};
}
test('only HTTPS images on the precise BGG image host are accepted',()=>{
 assert.equal(safeThumbnail(good),good);
 assert.equal(safeThumbnail(good.replace('https:','')),good);
 for(const bad of ['https://evil.test/x','https://cf.geekdo-images.com.evil.test/a','http://cf.geekdo-images.com/a','javascript:alert(1)','data:image/png,aaa','https://person:password@cf.geekdo-images.com/a','https://cf.geekdo-images.com:8080/a','https://cf.geekdo-images.com\\@evil.test/a',good+'\n',good+'#token'])assert.equal(safeThumbnail(bad),null,bad);
});
test('item metadata returns the requested cover only, not imported player counts',()=>{
 assert.deepEqual([...parseThumbnails(xml(),[1])],[[1,good]]);
 assert.equal(parseThumbnails(xml(),[2]).size,0);
 assert.deepEqual([...parseThumbnails(xml().replace('<thumbnail>','<thumbnail><![CDATA[').replace('</thumbnail>',']]></thumbnail>'),[1])],[[1,good]]);
});
test('XML entity expansion, HTML and off-site URLs are rejected',()=>{
 for(const bad of ['<html>wrong</html>','<!DOCTYPE items [<!ENTITY a "b">]>'+xml(),'x'.repeat(2097153)])assert.throws(()=>parseThumbnails(bad,[1]));
 assert.equal(parseThumbnails(xml(1,'https://evil.test/x'),[1]).get(1),null);
 assert.equal(parseThumbnails(xml().replace(/<thumbnail>.*?<\/thumbnail>/,''),[1]).get(1),null);
});
test('bounded body protects both advertised and streamed lengths',async()=>{
 assert.equal((await boundedBytes(new Response('123'),3)).length,3);
 await assert.rejects(boundedBytes(new Response('1234'),3));
 await assert.rejects(boundedBytes(new Response('1',{headers:{'Content-Length':'999'}}),3));
});
test('unauthenticated visitors and non-catalogue IDs cannot retrieve metadata',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('must not contact BGG');});
 let s=setup(null);assert.equal((await thumbnailResponse(s.request,s.env,s.ctx,s.base)).status,401);
 s=setup({id:'member'},[2]);assert.equal((await thumbnailResponse(s.request,s.env,s.ctx,s.base)).status,403);
});
test('bad input and unsupported methods fail before fetching',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('must not contact BGG');});const s=setup();
 for(const ids of ['','0','-1','1,2,','99999999999999999',Array.from({length:21},(_,i)=>i+1).join(',')]) assert.equal((await thumbnailResponse(new Request('https://test.example/api/game-thumbnails?ids='+ids),s.env,s.ctx,s.base)).status,400);
 assert.equal((await thumbnailResponse(new Request(s.request.url,{method:'POST'}),s.env,s.ctx,s.base)).status,405);
});
test('missing token leaves normal game display available without an external request',async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('must not contact BGG');});const s=setup();delete s.env.BGG_TOKEN;
 assert.deepEqual(await (await thumbnailResponse(s.request,s.env,s.ctx,s.base)).json(),{thumbnails:{1:null},pending:[]});
});
test('success is cached, does not leak tokens or member details, and preserves the API host',async t=>{
 let calls=0; t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url.hostname,'boardgamegeek.com');assert.equal(url.pathname,'/xmlapi2/thing');assert.equal(options.headers.Authorization,'Bearer test-token-only');assert.equal(options.redirect,'manual');return new Response(xml());});
 const s=setup();
 for(let i=0;i<2;i++){const r=await thumbnailResponse(s.request,s.env,s.ctx,s.base);assert.equal(r.status,200);assert.deepEqual(await r.json(),{thumbnails:{1:good},pending:[]});}
 assert.equal(calls,1);assert.ok(s.db.sqlite.prepare('SELECT query FROM bgg_cache').get().query.startsWith('thumbnail:v1:'));
});
test('a second uncached request is queued behind the shared BGG fetch gate',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(xml());});const s=setup();
 await thumbnailResponse(s.request,s.env,s.ctx,s.base);
 const r=await thumbnailResponse(new Request('https://test.example/api/game-thumbnails?ids=2'),s.env,s.ctx,s.base);
 assert.deepEqual(await r.json(),{thumbnails:{},pending:[2],retryAfter:6});assert.equal(calls,1);
});
test('throttling or a transport failure returns a bounded retry without changing the catalogue',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('limited',{status:429}));let s=setup();
 assert.deepEqual(await (await thumbnailResponse(s.request,s.env,s.ctx,s.base)).json(),{thumbnails:{},pending:[1],retryAfter:60});
 t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>{throw new Error('network');});s=setup();
 assert.equal((await (await thumbnailResponse(s.request,s.env,s.ctx,s.base)).json()).retryAfter,15);
});
test('missing cover is negatively cached and duplicate IDs are requested once',async t=>{
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(url.searchParams.get('id'),'1');return new Response(xml().replace(/<thumbnail>.*?<\/thumbnail>/,''));});const s=setup();
 const r=await thumbnailResponse(new Request(s.request.url+',1'),s.env,s.ctx,s.base);
 assert.deepEqual(await r.json(),{thumbnails:{1:null},pending:[]});
});
test('wrapper injects same-origin assets and real badge without weakening script policy',async()=>{
 const base={async fetch(){return new Response('<html><head></head><body>Planner</body></html>',{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'"}});}};
 const app=withGameMedia(base,{javascript:'client',css:'style'});
 const r=await app.fetch(new Request('https://test.example/'),{},{});const html=await r.text();
 assert.ok(html.includes('powered-by-bgg.png'));assert.ok(html.includes('Game data and cover images from BoardGameGeek.'));assert.ok(html.includes('game-media.js?v='+MEDIA_VERSION));
 assert.ok(r.headers.get('Content-Security-Policy').includes("script-src 'self';"));assert.ok(r.headers.get('Content-Security-Policy').includes('https://cf.geekdo-images.com'));
 assert.equal(await (await app.fetch(new Request('https://test.example/media/game-media.js'),{},{})).text(),'client');
});
test('badge request never carries the BGG token and validates the image bytes',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,BADGE_URL);assert.equal(options.headers,undefined);assert.equal(options.redirect,'manual');return new Response(Uint8Array.from([137,80,78,71,13,10,26,10]),{headers:{'Content-Type':'image/png'}});});
 const app=withGameMedia({},{javascript:'',css:''});const r=await app.fetch(new Request('https://test.example/media/powered-by-bgg.png'),{BGG_TOKEN:'not-for-cdn'},{waitUntil(){}});
 assert.equal(r.status,200);assert.equal(r.headers.get('Content-Type'),'image/png');
});
test('client has lazy images, fallback handling and bounded retries',async()=>{
 const src=await readFile(new URL('../public/game-media.js',import.meta.url),'utf8');
 assert.ok(src.includes("img.loading='lazy'"));assert.ok(src.includes("img.addEventListener('error'"));assert.ok(src.includes('<3'));assert.ok(!src.includes('BGG_TOKEN'));
});
test('thumbnail redirects are rejected without following or caching a false success',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://elsewhere.invalid/'}});});
 const s=setup();const r=await thumbnailResponse(s.request,s.env,s.ctx,s.base);
 assert.deepEqual(await r.json(),{thumbnails:{},pending:[1],retryAfter:15});assert.equal(calls,1);
 assert.equal(s.db.sqlite.prepare('SELECT count(*) AS n FROM bgg_cache').get().n,0);
});
test('badge redirects fail closed and cannot forward credentials',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);return new Response('',{status:302,headers:{Location:'https://elsewhere.invalid/'}});});
 const app=withGameMedia({},{javascript:'',css:''});
 const r=await app.fetch(new Request('https://test.example/media/powered-by-bgg.png'),{BGG_TOKEN:'not-for-cdn'},{waitUntil(){}});
 assert.equal(r.status,503);assert.equal(calls,1);
});
test('both server integrations exclude the redirect mode unsupported by Workers',async()=>{
 for(const path of ['../src/bgg.mjs','../src/game-media.mjs']){
  const source=await readFile(new URL(path,import.meta.url),'utf8');
  assert.doesNotMatch(source,/redirect\s*:\s*['"]error['"]/);assert.match(source,/redirect\s*:\s*['"]manual['"]/);
 }
});
