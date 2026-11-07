import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {bggIdFromLink, parseGameDetails, lookupGameDetails, storedGameDetails} from '../src/game-details.mjs';
import {parseThumbnails, thumbnailResponse, safeThumbnail, boundedBytes} from '../src/game-media.mjs';

const id = 38927;
const title = 'Commands & Colors: Ancients Expansion Pack #5 – Epic Ancients II';
const cover = 'https://cf.geekdo-images.com/expansion-test/thumb/img/example/pic38927.jpg';
const baseCover = 'https://cf.geekdo-images.com/base-test/thumb/img/example/pic14105.jpg';
const item = (type='boardgameexpansion', gameId=id, artwork=cover) => `<item type="${type}" id="${gameId}"><thumbnail>${artwork}</thumbnail><name type="primary" value="Commands &amp; Colors: Ancients Expansion Pack #5 – Epic Ancients II"/><minplayers value="2"/><maxplayers value="8"/></item>`;
const xml = body => `<?xml version="1.0"?><items>${body}</items>`;
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE game_metadata(bgg_id INTEGER PRIMARY KEY,title TEXT,thumbnail TEXT,min_players INTEGER,max_players INTEGER,fetched_at INTEGER); CREATE TABLE bgg_cache(query TEXT PRIMARY KEY,response TEXT,expires_at INTEGER); CREATE TABLE request_limits(key TEXT PRIMARY KEY,count INTEGER,expires_at INTEGER);');
  t.after(() => sqlite.close());
  return {sqlite, prepare(sql) {
    const query = sqlite.prepare(sql);
    return {values:[], bind(...values){this.values=values;return this;}, async first(){return query.get(...this.values)||null;}, async all(){return {results:query.all(...this.values)};}, async run(){return {meta:{changes:query.run(...this.values).changes}};}};
  }, async batch(statements){const result=[];for(const statement of statements)result.push(await statement.run());return result;}};
}
function setup(t, user={id:'test-member'}, ids=[id,14105]) {
  const DB=database(t);
  const base={async fetch(request){assert.equal(new URL(request.url).pathname,'/api/bootstrap');return Response.json({user,games:ids.map(bggId=>({bggId}))});}};
  return {env:{DB,BGG_TOKEN:'fixture-token'},base,ctx:{waitUntil(){}},request:new Request(`https://collective.test/api/game-thumbnails?ids=${id}`)};
}
function upstream(t, responseXml, counter={calls:0}) {
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    counter.calls++;
    const target=new URL(url);
    assert.equal(target.origin,'https://boardgamegeek.com');
    assert.equal(target.pathname,'/xmlapi2/thing');
    assert.equal(target.searchParams.get('type'),'boardgame,boardgameexpansion');
    assert.equal(options.redirect,'manual');
    assert.equal(options.headers.Authorization,'Bearer fixture-token');
    return new Response(responseXml,{headers:{'Content-Type':'text/xml'}});
  });
  return counter;
}

test('the existing pasted expansion link keeps its exact BGG ID',()=>{
  assert.equal(bggIdFromLink('https://boardgamegeek.com/boardgame/38927/commands-and-colors-ancients-expansion-pack-5-epic'),id);
});
test('direct lookup parses expansion title, artwork and advisory player range',()=>{
  assert.deepEqual(parseGameDetails(xml(item()),id),{bggId:id,title,thumbnail:cover,minPlayers:2,maxPlayers:8});
});
test('thumbnail parser accepts an expansion item',()=>{
  assert.equal(parseThumbnails(xml(item()),[id]).get(id),cover);
});
test('base-game item responses continue to work in both parsers',()=>{
  assert.equal(parseGameDetails(xml(item('boardgame')),id).thumbnail,cover);
  assert.equal(parseThumbnails(xml(item('boardgame')),[id]).get(id),cover);
});
test('mixed base-game and expansion responses preserve each item artwork',()=>{
  const mixed=xml(item('boardgame',14105,baseCover)+item());
  assert.deepEqual([...parseThumbnails(mixed,[14105,id])],[[14105,baseCover],[id,cover]]);
  assert.equal(parseGameDetails(mixed,id).thumbnail,cover);
});
test('unrelated item types remain excluded',()=>{
  for(const type of ['videogame','rpgitem','boardgameaccessory','boardgameexpansion-extra']){
    assert.equal(parseGameDetails(xml(item(type)),id),null);
    assert.equal(parseThumbnails(xml(item(type)),[id]).size,0);
  }
});
test('metadata is never silently borrowed from a different BGG item',()=>{
  assert.equal(parseGameDetails(xml(item('boardgame',14105,baseCover)),id),null);
  assert.equal(parseThumbnails(xml(item('boardgame',14105,baseCover)),[id]).size,0);
});
test('off-host, insecure and credential-bearing artwork remains rejected',()=>{
  for(const url of ['https://other.invalid/cover.png','http://cf.geekdo-images.com/pic.jpg','https://user:pass@cf.geekdo-images.com/pic.jpg']){
    assert.equal(parseGameDetails(xml(item('boardgameexpansion',id,url)),id).thumbnail,null);
    assert.equal(parseThumbnails(xml(item('boardgameexpansion',id,url)),[id]).get(id),null);
    assert.equal(safeThumbnail(url),null);
  }
});
test('malformed XML and custom entities remain rejected',()=>{
  for(const bad of ['<html>unavailable</html>','<!DOCTYPE items [<!ENTITY x "bad">]>'+xml(item())]){
    assert.throws(()=>parseGameDetails(bad,id));assert.throws(()=>parseThumbnails(bad,[id]));
  }
});
test('direct item request allows expansions, stores metadata and primes the cover cache',async t=>{
  const s=setup(t);const count=upstream(t,xml(item()));
  const result=await lookupGameDetails(s.env,id);
  assert.equal(result.game?.thumbnail,cover);assert.equal(result.game?.title,title);
  assert.equal(result.cached,false);assert.equal(count.calls,1);
  assert.deepEqual(await storedGameDetails(s.env,id),result.game);
  assert.equal(JSON.parse(s.env.DB.sqlite.prepare('SELECT response FROM bgg_cache WHERE query=?').get('thumbnail:v1:'+id).response).thumbnail,cover);
  assert.equal((await lookupGameDetails(s.env,id)).cached,true);assert.equal(count.calls,1);
});
test('thumbnail endpoint retrieves expansion cover and then reuses it without API calls',async t=>{
  const s=setup(t);const count=upstream(t,xml(item()));
  for(let i=0;i<2;i++){
    const response=await thumbnailResponse(s.request,s.env,s.ctx,s.base);
    assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body,{thumbnails:{[id]:cover},pending:[]});
    assert.doesNotMatch(JSON.stringify(body),/fixture-token|test-member/);
  }
  assert.equal(count.calls,1);
});
test('known expansion artwork survives later API failure',async t=>{
  const s=setup(t);
  s.env.DB.sqlite.prepare('INSERT INTO game_metadata VALUES (?,?,?,?,?,?)').run(id,title,cover,2,8,0);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('API unavailable');});
  const result=await lookupGameDetails(s.env,id);
  assert.equal(result.stale,true);assert.equal(result.game.thumbnail,cover);
});
test('an incomplete later item response does not erase known expansion artwork',async t=>{
  const s=setup(t);
  s.env.DB.sqlite.prepare('INSERT INTO game_metadata VALUES (?,?,?,?,?,?)').run(id,title,cover,2,8,0);
  upstream(t,xml(item().replace(/<thumbnail>.*?<\/thumbnail>/,'')));
  assert.equal((await lookupGameDetails(s.env,id)).game.thumbnail,cover);
});
test('member and catalogue checks still prevent unauthorised thumbnail lookups',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('must not fetch');});
  let s=setup(t,null);assert.equal((await thumbnailResponse(s.request,s.env,s.ctx,s.base)).status,401);
  s=setup(t,{id:'test-member'},[14105]);assert.equal((await thumbnailResponse(s.request,s.env,s.ctx,s.base)).status,403);
});
test('redirects are not followed and cannot receive the BGG token',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async (_url,options)=>{
    calls++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://other.invalid/'}});
  });
  const s=setup(t);assert.equal((await lookupGameDetails(s.env,id)).game,null);
  const body=await (await thumbnailResponse(s.request,s.env,s.ctx,s.base)).json();
  assert.deepEqual(body.pending,[id]);assert.equal(calls,2);assert.doesNotMatch(JSON.stringify(body),/fixture-token/);
});
test('oversized responses remain bounded',async()=>{
  await assert.rejects(boundedBytes(new Response('abc',{headers:{'Content-Length':'999'}}),10));
  assert.throws(()=>parseGameDetails('x'.repeat(524289),id));
});
