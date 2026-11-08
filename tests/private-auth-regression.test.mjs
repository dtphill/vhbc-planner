import test from 'node:test';
import assert from 'node:assert/strict';
import {privateSession} from '../src/private-session.mjs';
import {readOnlyDatabase, withPrivatePlanner} from '../src/private-planner.mjs';

// Real Better Auth checks signed sessions against this synthetic D1 interface.
// Include the non-auth INTEGER-key table that triggered the production failure.
const schema = {
  user:'id:text name:text email:text emailVerified:integer image:text? createdAt:date updatedAt:date',
  session:'id:text expiresAt:date token:text createdAt:date updatedAt:date ipAddress:text? userAgent:text? userId:text',
  account:'id:text accountId:text providerId:text userId:text accessToken:text? refreshToken:text? idToken:text? accessTokenExpiresAt:date? refreshTokenExpiresAt:date? scope:text? password:text? createdAt:date updatedAt:date',
  verification:'id:text identifier:text value:text expiresAt:date createdAt:date updatedAt:date',
  rateLimit:'id:text key:text count:integer lastRequest:bigint',
  group_join_links:'id:integer nonce:text enabled:integer created_by:text? updated_at:integer',
};
const secret='synthetic-auth-fixture-only-never-production-secret-2026';
const token='synthetic-session-fixture-only';
async function signedCookie() {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(token)));
  return '__Secure-vhbc.session_token='+encodeURIComponent(token+'.'+btoa(String.fromCharCode(...sig)));
}
class FixtureDB {
  constructor(trace,options={}) {this.trace=trace;this.options=options;}
  prepare(sql) {
    this.trace.push(sql);
    const fixture=this.options;
    return {
      params:[],
      bind(...args) {this.params=args;return this;},
      async all() {
        const response=results=>({success:true,results,meta:{changes:0,last_row_id:0}});
        if(sql.includes('sqlite_master'))return response(Object.keys(schema).map(name=>({name,type:'table'})));
        if(sql.includes('pragma_table_info'))return response((schema[this.params[0]]||'').split(' ').filter(Boolean).map((entry,cid)=>{
          const [name,kind]=entry.split(':');
          return {cid,name,type:kind.replace('?',''),notnull:kind.endsWith('?')?0:1,dflt_value:null,pk:name==='id'?1:0};
        }));
        if(/^(?:PRAGMA index_list|SELECT \* FROM pragma_index_list)/i.test(sql))return response([{seq:0,name:'fixture_primary',unique:1,origin:'pk',partial:0}]);
        if(/^(?:PRAGMA index_info|SELECT \* FROM pragma_index_info)/i.test(sql))return response([{seqno:0,cid:0,name:'id'}]);
        const now=Date.now();
        const user={id:'fixture-admin',name:'Fixture Admin',email:'fixture@example.invalid',emailVerified:1,image:null,createdAt:now-1000000,updatedAt:now-1000000};
        const session={id:'fixture-session',userId:user.id,token,expiresAt:now+86400000,createdAt:now-1000000,updatedAt:now-1000000,ipAddress:'',userAgent:''};
        let row=sql.includes('from "user"')&&!sql.includes('session')?user:{...session,user};
        for(const [key,value] of Object.entries(user)){row['join_user_'+key]=value;row['user_'+key]=value;}
        if(sql.includes('FROM members WHERE user_id='))row={user_id:user.id,role:fixture.role||'admin',disabled:fixture.disabled?1:0};
        else if(!sql.includes('from "session"')&&!sql.includes('from "user"'))return response([]);
        if(fixture.missing&&sql.includes('from "session"'))return response([]);
        return response([row]);
      },
      async first() {return (await this.all()).results[0]||null;},
      async raw() {return [];},
      async run() {throw new Error('Synthetic write blocked');},
    };
  }
  async batch(statements) {return Promise.all(statements.map(s=>s.all()));}
  async exec() {throw new Error('Synthetic exec blocked');}
}

const cases=[
  {name:'active organiser opens private page',code:200,run:true},
  {name:'ordinary member denied',role:'member',code:403},
  {name:'disabled organiser denied',disabled:true,code:403},
  {name:'missing cookie denied',missingCookie:true,code:401},
  {name:'tampered cookie denied',tamperedCookie:true,code:401},
  {name:'revoked session denied',missing:true,code:401},
  {name:'authenticated private API is read only',method:'POST',code:200,private:true},
  {name:'member cannot call private API',method:'POST',role:'member',code:403},
  {name:'cross-site request denied',method:'POST',origin:'https://elsewhere.invalid',code:403},
  {name:'infrastructure error is not a false logout',breakAuth:true,code:503},
];
for(const options of cases)test('private authentication: '+options.name,async()=>{
  const cookie=options.missingCookie?'':await signedCookie()+(options.tamperedCookie?'x':'');
  const trace=[],db=new FixtureDB(trace,options);
  const env={APP_URL:'https://vhbc.dtpgames.com',BETTER_AUTH_SECRET:secret,DB:db};
  const sessionFor=options.breakAuth?async()=>{throw new Error('Synthetic infrastructure failure');}:privateSession;
  const app=withPrivatePlanner({async fetch(){return new Response('base');}},{javascript:'',css:''},sessionFor);
  const method=options.method||'GET';
  const request=new Request(env.APP_URL+(method==='POST'?'/api/admin/planner-test':'/admin/planner-test'),{
    method,headers:{cookie,Origin:options.origin||env.APP_URL,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{}),
  });
  const response=await app.fetch(request,env,{}),text=await response.text();
  assert.equal(response.status,options.code,text);
  assert.ok(trace.every(sql=>/^\s*SELECT\b/i.test(sql)),JSON.stringify(trace));
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  if(options.run){assert.ok(text.includes('id="ppt-run"'));assert.ok(trace.includes("SELECT * FROM pragma_index_list('group_join_links')"));}
  if(options.private)assert.equal(JSON.parse(text).persisted,false);
  if(options.code===503)assert.ok(!text.includes('Sign in with an active'));
});
for(const sql of [
  "UPDATE members SET role='admin'",'DELETE FROM meetings','INSERT INTO history VALUES (1)',
  'PRAGMA writable_schema=ON','PRAGMA foreign_keys=OFF','PRAGMA journal_mode(WAL)',
  "PRAGMA index_list('user');DELETE FROM user","PRAGMA index_list('user') extra",'SELECT 1;DELETE FROM meetings',
])test('private guard rejects '+sql,()=>{
  const trace=[],db=readOnlyDatabase(new FixtureDB(trace));
  assert.throws(()=>db.prepare(sql));assert.equal(trace.length,0);
});
