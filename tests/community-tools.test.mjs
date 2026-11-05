import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {withCommunityTools, archiveGame, changeGroupLink, validGroupLink, readCommunityJson} from '../src/community-tools.mjs';
import {lookupGameDetails, parseGameDetails, bggIdFromLink, safeArtwork} from '../src/game-details.mjs';
const origin='https://collective.test';
const photo='https://cf.geekdo-images.com/game__thumb/img/a/fit-in/200x150/pic1.jpg';
const XML=`<?xml version="1.0"?><items><item type="boardgame" id="123"><name type="alternate" value="Other"/><name value="Baltic &amp; Empires" type="primary"/><thumbnail>${photo}</thumbnail><minplayers value="3"/><maxplayers value="5"/></item></items>`;
async function setup(role='admin'){
 const sql=new DatabaseSync(':memory:');
 sql.exec('CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT UNIQUE);');
 sql.exec(await readFile(new URL('../migrations/0002_app.sql',import.meta.url),'utf8'));
 sql.exec('CREATE TABLE meeting_exclusions(meeting_id TEXT PRIMARY KEY);');
 sql.exec(await readFile(new URL('../migrations/0004_community_tools.sql',import.meta.url),'utf8'));
 sql.exec("INSERT INTO user VALUES ('admin','a@example.test'),('member','m@example.test'); INSERT INTO members(user_id,role,created_at) VALUES ('admin','admin',1),('member','member',1); INSERT INTO games(id,title,normalized_title,bgg_id,created_at) VALUES ('g','Baltic Empires','baltic empires',123,1),('other','Other','other',456,1);");
 const db={prepare(query){const statement=sql.prepare(query);return {args:[],bind(...args){this.args=args;return this;},async first(){return statement.get(...this.args)||null;},async all(){return {results:statement.all(...this.args)};},async run(){return {meta:{changes:statement.run(...this.args).changes}};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:db,APP_URL:origin,BETTER_AUTH_SECRET:'only-a-test-secret-with-at-least-32-characters',BGG_TOKEN:'only-a-test-bgg-token'};
 const forwarded=[];let signedIn=true;
 const base={async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/api/bootstrap')return Response.json({user:signedIn?{id:role==='admin'?'admin':'member',role}:null,games:sql.prepare('SELECT * FROM games WHERE archived_at IS NULL').all().map(g=>({id:g.id,bggId:g.bgg_id,title:g.title,offers:[{userId:role==='admin'?'admin':'member',own:true,teach:false,counts:[5],pitch:'Retain this pitch'}]}))});
  if(path==='/api/register'){const b=await request.json();forwarded.push({path,body:b});const inv=sql.prepare('SELECT * FROM invites WHERE email=? AND used_at IS NULL AND expires_at>?').get(b.email,Date.now());assert.equal(inv.role,'member');sql.prepare('UPDATE invites SET used_at=1 WHERE email=?').run(b.email);return Response.json({user:{name:b.name}},{headers:{'Set-Cookie':'test-session=ok; HttpOnly'}});}
  if(path==='/api/game-thumbnails')return Response.json({thumbnails:{123:null},pending:[123],retryAfter:15});
  if(path==='/')return new Response('<html><head><script type="module" src="/app.js"></script></head><body>Planner</body></html>',{headers:{'Content-Type':'text/html','Content-Security-Policy':"script-src 'self'"}});
  if(path==='/api/health')return Response.json({ok:true,version:'old'});
  forwarded.push({path,body:request.method==='GET'?null:await request.json()});return Response.json({ok:true});
 }};
 const app=withCommunityTools(base,{javascript:'client',css:'style'});const ctx={waitUntil(){}};
 const call=(path,body,extra={})=>app.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,ctx);
 return {sql,db,env,app,base,ctx,call,forwarded,signOut(){signedIn=false;}};
}
test('manual links accept BGG IDs, not arbitrary fetch targets',()=>{
 for(const link of ['https://boardgamegeek.com/boardgame/123/name','https://www.boardgamegeek.com/boardgame/123','http://boardgamegeek.com/boardgame/123?foo=1'])assert.equal(bggIdFromLink(link),123);
 for(const link of ['https://evil.test/boardgame/123','https://boardgamegeek.com.evil.test/boardgame/123','https://a:b@boardgamegeek.com/boardgame/123','https://boardgamegeek.com:8080/boardgame/123','javascript:bad','https://boardgamegeek.com/boardgame/0','https://boardgamegeek.com\\@evil.test/boardgame/123'])assert.equal(bggIdFromLink(link),null);
});
test('item response extracts primary name, cover and advisory range',()=>{assert.deepEqual(parseGameDetails(XML,123),{bggId:123,title:'Baltic & Empires',thumbnail:photo,minPlayers:3,maxPlayers:5});assert.equal(parseGameDetails(XML,456),null);});
test('invalid XML declarations, oversized bodies and unsafe artwork rejected',()=>{
 assert.throws(()=>parseGameDetails('<!DOCTYPE items>'+XML,123));assert.throws(()=>parseGameDetails('x'.repeat(524289),123));assert.throws(()=>parseGameDetails('<html>not XML</html>',123));
 assert.equal(safeArtwork('https://cf.geekdo-images.com.evil.test/x'),null);assert.equal(safeArtwork('https://user:pass@cf.geekdo-images.com/x'),null);
 assert.equal(parseGameDetails(XML.replace('value="3"','value="9"'),123).minPlayers,null);
});
test('item lookup uses fixed endpoint, caches metadata and never sends a token to artwork',async t=>{
 const s=await setup();let calls=0;t.mock.method(globalThis,'fetch',async(url,opts)=>{calls++;assert.equal(url.hostname,'boardgamegeek.com');assert.equal(url.pathname,'/xmlapi2/thing');assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Bearer only-a-test-bgg-token');return new Response(XML);});
 const one=await lookupGameDetails(s.env,123),two=await lookupGameDetails(s.env,123);assert.equal(one.game.title,'Baltic & Empires');assert.equal(two.cached,true);assert.equal(calls,1);assert.ok(s.sql.prepare('SELECT * FROM bgg_cache').get().response.includes(photo));assert.ok(!JSON.stringify(one).includes(s.env.BGG_TOKEN));
});
test('last good metadata survives API failures and cache expiry',async t=>{
 const s=await setup();s.sql.prepare('INSERT INTO game_metadata VALUES (?,?,?,?,?,?)').run(123,'Old title',photo,3,5,1);
 t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));const r=await lookupGameDetails(s.env,123);assert.equal(r.game.thumbnail,photo);assert.equal(r.stale,true);assert.equal(s.sql.prepare('SELECT title FROM game_metadata').get().title,'Old title');
});
test('redirects are not followed or handed credentials',async t=>{
 const s=await setup();let calls=0;t.mock.method(globalThis,'fetch',async(_,opts)=>{calls++;assert.equal(opts.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://elsewhere.invalid'}});});
 assert.equal((await lookupGameDetails(s.env,123)).game,null);assert.equal(calls,1);
});
test('blank token still permits cached metadata',async()=>{const s=await setup();s.env.BGG_TOKEN='';s.sql.prepare('INSERT INTO game_metadata VALUES (?,?,?,?,?,?)').run(123,'Saved',photo,3,5,1);assert.equal((await lookupGameDetails(s.env,123)).game.title,'Saved');});
test('create, reuse, replace and disable a group invitation',async()=>{
 const s=await setup();const actor={id:'admin'};const a=await changeGroupLink(s.env,actor,'create');const token=new URL(a.joinLink.url).hash.slice(6);assert.equal((await validGroupLink(s.env,token)).enabled,1);
 assert.equal((await changeGroupLink(s.env,actor,'create')).joinLink.url,a.joinLink.url);
 const b=await changeGroupLink(s.env,actor,'replace');assert.notEqual(a.joinLink.url,b.joinLink.url);await assert.rejects(validGroupLink(s.env,token));
 await changeGroupLink(s.env,actor,'disable');await assert.rejects(validGroupLink(s.env,new URL(b.joinLink.url).hash.slice(6)));
});
test('group registration delegates to existing auth as MEMBER and keeps session cookie',async()=>{
 const s=await setup();const link=await changeGroupLink(s.env,{id:'admin'},'create');const token=new URL(link.joinLink.url).hash.slice(6);
 const r=await s.call('/api/community/register',{token,email:'new@example.test',name:'New member',password:'long-test-password',role:'admin'});assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie'));assert.equal(s.forwarded[0].body.role,undefined);assert.notEqual(s.forwarded[0].body.token,token);
});
test('invalid and revoked links cannot create an account',async()=>{const s=await setup();const r=await s.call('/api/community/register',{token:'wrong',email:'new@example.test',name:'New',password:'long-test-password'});assert.equal(r.status,403);assert.equal(s.forwarded.length,0);});
test('members and signed-out visitors cannot manage catalogue or invitations',async()=>{
 const s=await setup('member');for(const path of ['/api/admin/community/delete-game','/api/admin/community/restore-game','/api/admin/community/join-link'])assert.equal((await s.call(path,{gameId:'g',action:'create'})).status,403);
 s.signOut();assert.equal((await s.call('/api/admin/community/status')).status,401);assert.equal((await s.call('/api/community/game-details?id=123')).status,401);
});
test('cross-site changes are rejected before writes',async()=>{const s=await setup();assert.equal((await s.call('/api/admin/community/delete-game',{gameId:'g'},{Origin:'https://elsewhere.test'})).status,403);assert.equal(s.sql.prepare('SELECT archived_at FROM games WHERE id=?').get('g').archived_at,null);});
test('delete preserves history, removes upcoming reservations and is restorable',async()=>{
 const s=await setup();const table=JSON.stringify([{gameId:'g',memberIds:['admin']},{gameId:'other',memberIds:['member']}]);
 s.sql.prepare("INSERT INTO meetings(id,status,revision,fixed_json,plan_json,updated_at) VALUES ('2025-01-01','completed',7,?,'{}',1),('2099-01-01','locked',3,?,'{}',1)").run(table,table);
 s.sql.exec("INSERT INTO history(meeting_id,user_id,game_id,rating) VALUES ('2025-01-01','admin','g','want'); UPDATE members SET priority_game_id='g' WHERE user_id='admin';");
 await archiveGame(s.env,{id:'admin'},'g');assert.ok(s.sql.prepare("SELECT archived_at FROM games WHERE id='g'").get().archived_at);assert.equal(s.sql.prepare('SELECT count(*) n FROM history').get().n,1);assert.equal(s.sql.prepare("SELECT priority_game_id FROM members WHERE user_id='admin'").get().priority_game_id,null);
 const future=s.sql.prepare("SELECT * FROM meetings WHERE id='2099-01-01'").get();assert.equal(future.status,'open');assert.equal(future.plan_json,null);assert.deepEqual(JSON.parse(future.fixed_json),[{gameId:'other',memberIds:['member']}]);assert.equal(s.sql.prepare("SELECT revision FROM meetings WHERE id='2025-01-01'").get().revision,7);
 await archiveGame(s.env,{id:'admin'},'g',true);assert.equal(s.sql.prepare("SELECT archived_at FROM games WHERE id='g'").get().archived_at,null);
});
test('ordinary addition cannot resurrect an archived game',async()=>{const s=await setup();await archiveGame(s.env,{id:'admin'},'g');const r=await s.call('/api/games',{title:'Baltic Empires',bggUrl:'https://boardgamegeek.com/boardgame/123'});assert.equal(r.status,409);});
test('teaching accepts house-rule counts and keeps copy and pitch',async()=>{const s=await setup('member');const r=await s.call('/api/community/teach',{gameId:'g',teach:true,counts:[7]});assert.equal(r.status,200);assert.deepEqual(s.forwarded[0].body,{own:true,teach:true,counts:[7],pitch:'Retain this pitch'});assert.equal((await s.call('/api/community/teach',{gameId:'g',teach:true,counts:[]})).status,400);});
test('persistent cover metadata serves images when original image lookup is pending',async()=>{const s=await setup();s.sql.prepare('INSERT INTO game_metadata VALUES (?,?,?,?,?,?)').run(123,'Saved',photo,3,5,1);const r=await s.call('/api/game-thumbnails?ids=123');const body=await r.json();assert.equal(body.thumbnails[123],photo);assert.deepEqual(body.pending,[]);});
test('client asset is injected before base app, without weakening script policy',async()=>{const s=await setup();const r=await s.call('/');const html=await r.text();assert.ok(html.indexOf('community-tools.js')<html.indexOf('/app.js'));assert.equal(r.headers.get('content-security-policy'),"script-src 'self'");assert.equal((await s.call('/media/community-tools.js')).status,200);});
test('input bodies are bounded and require JSON',async()=>{await assert.rejects(readCommunityJson(new Request(origin,{method:'POST',body:'{}'})));await assert.rejects(readCommunityJson(new Request(origin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:'x'.repeat(33000)})})));});

test('active catalogue filter preserves account queries and history while excluding archived games',async()=>{
 const {activeCatalogueDb,activeCatalogueSql}=await import('../src/active-catalogue.mjs');const s=await setup();
 await archiveGame(s.env,{id:'admin'},'g');const active=activeCatalogueDb(s.db);
 assert.deepEqual((await active.prepare('SELECT * FROM games ORDER BY title COLLATE NOCASE').all()).results.map(g=>g.id),['other']);
 assert.equal(await active.prepare('SELECT id FROM games WHERE id=?').bind('g').first(),null);
 assert.equal(activeCatalogueSql('SELECT * FROM history ORDER BY meeting_id'),'SELECT * FROM history ORDER BY meeting_id');
 assert.equal(activeCatalogueSql('SELECT * FROM user WHERE id=?'),'SELECT * FROM user WHERE id=?');
 assert.equal((await active.prepare('SELECT id FROM user WHERE id=?').bind('admin').first()).id,'admin');
});
