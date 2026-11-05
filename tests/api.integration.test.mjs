import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';

test('Real Worker and D1: private accounts, saved preferences, allocation consent and recovery', async () => {
  const origin='https://collective.test';
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-11-02',compatibilityFlags:['nodejs_compat'],cf:false,d1Databases:['DB'],bindings:{APP_URL:origin,BETTER_AUTH_SECRET:randomBytes(32).toString('hex')},log:new Log(LogLevel.ERROR)}));
  try {
    const db=await mf.getD1Database('DB');
    for(const file of ['0001_auth.sql','0002_app.sql','0003_meeting_management.sql','0004_community_tools.sql']){
      const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');
      await db.batch(sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    let ownerCookie='',memberCookie='';
    const password=randomBytes(20).toString('hex');
    async function call(path,{method='GET',body,cookie='',originHeader=origin,ip='192.0.2.1'}={}){
      const response=await mf.dispatchFetch(origin+path,{method,headers:{Origin:originHeader,'Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':ip},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const value=await response.json();
      const cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      return {status:response.status,value,cookies,headers:response.headers};
    }
    const publicResult=await call('/api/bootstrap');
    assert.equal(publicResult.status,200);assert.equal(publicResult.value.user,null);assert.equal(publicResult.value.members,undefined);
    assert.equal((await call('/api/attendance',{method:'POST',body:{coming:true},originHeader:'https://other.test'})).status,403);
    assert.equal((await call('/api/auth/sign-up/email',{method:'POST',body:{email:'attacker@example.test',password,name:'Attacker'}})).status,404);
    const token=randomBytes(32).toString('hex');
    await db.prepare("INSERT INTO invites(token_hash,email,role,expires_at,created_at) VALUES (?,?,'admin',?,?)").bind(createHash('sha256').update(token).digest('hex'),'owner@example.test',Date.now()+600000,Date.now()).run();
    const signed=await call('/api/register',{method:'POST',body:{token,email:'owner@example.test',name:'Owner',password}});
    assert.equal(signed.status,200,JSON.stringify(signed.value));assert.ok(signed.cookies.includes('vhbc.session_token'));
    ownerCookie=signed.cookies;
    let boot=await call('/api/bootstrap',{cookie:ownerCookie});
    assert.equal(boot.value.user.role,'admin');assert.equal(boot.value.user.emailVerified,false);
    const ownerId=boot.value.user.id;
    assert.equal((await call('/api/register',{method:'POST',body:{token,email:'owner@example.test',name:'Owner',password}})).status,403);
    assert.equal((await call('/api/games',{method:'POST',cookie:ownerCookie,body:{title:'Baltic Empires',own:true,teach:true,counts:[],pitch:''}})).status,400);
    const baltic=await call('/api/games',{method:'POST',cookie:ownerCookie,body:{title:'Baltic Empires',own:true,teach:true,counts:[5],pitch:'Five players only.'}});
    assert.equal(baltic.status,200,JSON.stringify(baltic.value));
    const balticId=baltic.value.gameId;
    await call('/api/priority',{method:'POST',cookie:ownerCookie,body:{gameId:balticId}});
    for(const coming of [true,false,true]) assert.equal((await call('/api/attendance',{method:'POST',cookie:ownerCookie,body:{coming}})).status,200);
    boot=await call('/api/bootstrap',{cookie:ownerCookie});
    assert.equal(boot.value.preferences.priorityGameId,balticId);assert.equal(boot.value.preferences.ratings[balticId],'want');
    assert.deepEqual(boot.value.games[0].offers[0].counts,[5]);
    const invite=await call('/api/admin/invites',{method:'POST',cookie:ownerCookie,body:{email:'member@example.test'}});
    assert.equal(invite.status,200);
    const memberToken=new URL(invite.value.url).hash.slice('#invite='.length);
    const signedMember=await call('/api/register',{method:'POST',ip:'192.0.2.2',body:{token:memberToken,email:'member@example.test',name:'Member',password}});
    assert.equal(signedMember.status,200,JSON.stringify(signedMember.value));memberCookie=signedMember.cookies;
    const memberId=(await call('/api/bootstrap',{cookie:memberCookie})).value.user.id;
    assert.equal((await call('/api/admin/invites',{method:'POST',cookie:memberCookie,body:{email:'stranger@example.test'}})).status,403);
    const two=await call('/api/games',{method:'POST',cookie:ownerCookie,body:{title:'A two-player game',own:true,teach:true,counts:[2],pitch:''}});
    const gameId=two.value.gameId;
    for(const cookie of [ownerCookie,memberCookie]){
      await call('/api/rating',{method:'POST',cookie,body:{gameId,rating:'want'}});
      await call('/api/attendance',{method:'POST',cookie,body:{coming:true}});
    }
    let plan=await call('/api/admin/plan',{method:'POST',cookie:ownerCookie,body:{}});
    assert.equal(plan.status,200,JSON.stringify(plan.value));assert.equal(plan.value.tables.length,1);assert.deepEqual(plan.value.unassignedMemberIds,[]);
    assert.equal(plan.value.tables[0].gameId,gameId);
    assert.equal((await call('/api/admin/lock',{method:'POST',cookie:ownerCookie,body:{revision:plan.value.revision-1}})).status,409);
    const table={gameId,memberIds:[ownerId,memberId],teacherId:ownerId,copyOwnerId:ownerId};
    plan=await call('/api/admin/fixed',{method:'PUT',cookie:ownerCookie,body:{tables:[table]}});
    assert.equal(plan.status,200);
    await call('/api/rating',{method:'POST',cookie:memberCookie,body:{gameId,rating:'pass'}});
    boot=await call('/api/bootstrap',{cookie:ownerCookie});assert.equal(boot.value.plan,null);assert.equal(boot.value.fixedTables.length,1);
    assert.equal((await call('/api/admin/plan',{method:'POST',cookie:ownerCookie,body:{}})).status,422);
    await call('/api/rating',{method:'POST',cookie:memberCookie,body:{gameId,rating:'will'}});
    plan=await call('/api/admin/plan',{method:'POST',cookie:ownerCookie,body:{}});
    assert.equal(plan.status,200);
    const current=boot.value.meeting.date;
    const stored=await db.prepare('SELECT plan_json FROM meetings WHERE id=?').bind(current).first();
    await db.prepare("INSERT INTO meetings(id,status,revision,plan_json,updated_at) VALUES ('2025-01-26','locked',1,?,?)").bind(stored.plan_json,Date.now()).run();
    assert.equal((await call('/api/admin/complete',{method:'POST',cookie:ownerCookie,body:{meetingDate:'2025-01-26',revision:1}})).status,200);
    boot=await call('/api/bootstrap',{cookie:ownerCookie});assert.equal(boot.value.history.length,1);assert.equal(boot.value.plan,null);assert.equal(boot.value.preferences.priorityGameId,balticId);
    assert.equal((await call('/api/admin/complete',{method:'POST',cookie:ownerCookie,body:{meetingDate:'2025-01-26',revision:1}})).status,409);
    const recovery=await call('/api/admin/reset',{method:'POST',cookie:ownerCookie,body:{userId:memberId}});
    assert.equal(recovery.status,200,JSON.stringify(recovery.value));
    const resetToken=new URL(recovery.value.url).hash.slice('#reset='.length);
    const replacement=randomBytes(20).toString('hex');
    assert.equal((await call('/api/auth/reset-password',{method:'POST',body:{token:resetToken,newPassword:replacement}})).status,200);
    assert.equal((await call('/api/bootstrap',{cookie:memberCookie})).value.user,null);
    assert.equal((await call('/api/auth/sign-in/email',{method:'POST',body:{email:'member@example.test',password:replacement}})).status,200);
    assert.equal((await call('/api/auth/reset-password',{method:'POST',body:{token:resetToken,newPassword:password}})).status,400);
    assert.equal((await call('/api/search?q=Baltic',{cookie:ownerCookie})).value.externalAvailable,false);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_outbox').first()).n,0);
    const page=await mf.dispatchFetch(origin+'/');assert.equal(page.status,200);assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
  } finally { await mf.dispose(); }
});
