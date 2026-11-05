import {localDate} from './calendar.mjs';
import {lookupGameDetails, storedGameDetails, safeArtwork} from './game-details.mjs';

export const COMMUNITY_VERSION = '1.3.0';
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const json = (body,status=200) => Response.json(body,{status,headers});
class CommunityError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail = (status,message) => {throw new CommunityError(status,message);};
const stmt = (db,sql,...values) => db.prepare(sql).bind(...values);
const first = (db,sql,...values) => stmt(db,sql,...values).first();
const all = async (db,sql,...values) => (await stmt(db,sql,...values).all()).results;
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
const hex = bytes => Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
const digest = async text => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
const audit = (env,member,action) => stmt(env.DB,'INSERT INTO audit_log(id,actor_id,action,created_at) VALUES (?,?,?,?)',crypto.randomUUID(),member.id,action,Date.now());

export async function readCommunityJson(request) {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415,'Send JSON with this request.');
  if(!request.body) return {};
  const reader=request.body.getReader();const chunks=[];let size=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();fail(413,'This request is too large.');}chunks.push(value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'Enter valid details.');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Expected an object.');return value;
}
function sameOrigin(request,env){if(request.headers.get('origin')!==env.APP_URL||request.headers.get('sec-fetch-site')==='cross-site')fail(403,'Use the Collective website for this action.');}
async function signingKey(env){
  if(typeof env.BETTER_AUTH_SECRET!=='string'||env.BETTER_AUTH_SECRET.length<32)fail(503,'Joining is temporarily unavailable.');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.BETTER_AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function groupToken(env,nonce){return nonce+'.'+hex(await crypto.subtle.sign('HMAC',await signingKey(env),new TextEncoder().encode('vhbc-group-join:v1:'+nonce)));}
export async function validGroupLink(env,token){
  if(typeof token!=='string'||!/^([a-f0-9]{64})\.([a-f0-9]{64})$/.test(token))fail(403,'This group invitation is invalid or has been disabled. Ask the organiser for the current link.');
  const [nonce,signature]=token.split('.');
  const valid=await crypto.subtle.verify('HMAC',await signingKey(env),Uint8Array.from(signature.match(/../g),v=>parseInt(v,16)),new TextEncoder().encode('vhbc-group-join:v1:'+nonce));
  if(!valid)fail(403,'This group invitation is invalid or has been disabled. Ask the organiser for the current link.');
  const row=await first(env.DB,'SELECT * FROM group_join_links WHERE id=1 AND enabled=1 AND nonce=?',nonce);
  if(!row)fail(403,'This group invitation is invalid or has been disabled. Ask the organiser for the current link.');return row;
}
async function limitJoining(request,env){
  const now=Date.now();const key='group-join:'+await digest((request.headers.get('cf-connecting-ip')||'unknown')+':'+Math.floor(now/60000));
  const row=await first(env.DB,'INSERT INTO request_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key,now+120000);
  if(row.count>5)fail(429,'Please wait a minute before trying again.');
}
async function bootstrap(request,env,ctx,base){
  const response=await base.fetch(new Request(new URL('/api/bootstrap',request.url),{headers:request.headers}),env,ctx);
  if(!response.ok)fail(503,'The group could not be loaded. Please refresh.');
  const data=await response.json();if(!data.user)fail(401,'Please sign in.');return data;
}
function futurePlans(env){return stmt(env.DB,"UPDATE meetings SET plan_json=NULL,status='open',revision=revision+1,updated_at=? WHERE id>=? AND status!='completed' AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)",Date.now(),localDate());}
export async function communityStatus(env){
  const row=await first(env.DB,'SELECT * FROM group_join_links WHERE id=1');
  const link=row?.enabled?{enabled:true,url:env.APP_URL+'/#join='+await groupToken(env,row.nonce)}:{enabled:false,url:null};
  const archived=await all(env.DB,'SELECT id,title,archived_at AS removedAt FROM games WHERE archived_at IS NOT NULL ORDER BY title COLLATE NOCASE');
  return {joinLink:link,archivedGames:archived};
}
export async function changeGroupLink(env,member,action){
  if(!['create','replace','disable'].includes(action))fail(400,'Choose a valid invitation action.');
  const current=await first(env.DB,'SELECT * FROM group_join_links WHERE id=1');
  if(action==='disable'){
    await env.DB.batch([stmt(env.DB,'UPDATE group_join_links SET enabled=0,updated_at=? WHERE id=1',Date.now()),audit(env,member,'group.invitation-disabled')]);
  }else if(action==='replace'||!current?.enabled){
    await env.DB.batch([stmt(env.DB,'INSERT INTO group_join_links(id,nonce,enabled,created_by,updated_at) VALUES (1,?,1,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce,enabled=1,created_by=excluded.created_by,updated_at=excluded.updated_at',random(),member.id,Date.now()),audit(env,member,'group.invitation-created')]);
  }
  return communityStatus(env);
}
export async function archiveGame(env,member,gameId,restore=false){
  if(typeof gameId!=='string'||gameId.length>100)fail(400,'Choose a game.');
  const game=await first(env.DB,'SELECT * FROM games WHERE id=?',gameId);
  if(!game)fail(404,'Game not found.');
  if(restore?game.archived_at===null:game.archived_at!==null)fail(409,restore?'This game is already available.':'This game has already been deleted.');
  if(restore){await env.DB.batch([stmt(env.DB,'UPDATE games SET archived_at=NULL,archived_by=NULL WHERE id=?',gameId),futurePlans(env),audit(env,member,'game.restored:'+gameId)]);}
  else {
    await env.DB.batch([
      stmt(env.DB,'UPDATE games SET archived_at=?,archived_by=? WHERE id=?',Date.now(),member.id,gameId),
      stmt(env.DB,'UPDATE members SET priority_game_id=NULL WHERE priority_game_id=?',gameId),
      stmt(env.DB,"UPDATE meetings SET fixed_json=COALESCE((SELECT json_group_array(json(value)) FROM json_each(meetings.fixed_json) WHERE json_extract(value,'$.gameId')!=?),'[]') WHERE id>=? AND status!='completed'",gameId,localDate()),
      futurePlans(env),audit(env,member,'game.deleted:'+gameId),
    ]);
  }
  return {ok:true,gameId};
}
async function guardArchivedAddition(env,body){
  let id=Number.isSafeInteger(body.bggId)&&body.bggId>0?body.bggId:null;
  try{const url=new URL(body.bggUrl);if(['boardgamegeek.com','www.boardgamegeek.com'].includes(url.hostname)){const match=/^\/boardgame\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);if(match)id=Number(match[1]);}}catch{}
  const title=typeof body.title==='string'?body.title.trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' '):'';
  if(await first(env.DB,'SELECT id FROM games WHERE archived_at IS NOT NULL AND (normalized_title=? OR bgg_id=?)',title,id))fail(409,'This game was deleted from the group. Ask an organiser to restore it rather than adding a duplicate.');
}
async function join(request,env,ctx,base,body){
  await limitJoining(request,env);
  const invitation=await validGroupLink(env,body.token);
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  const name=typeof body.name==='string'?body.name.trim():'';
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Enter a valid email address.');
  if(!name||name.length>60)fail(400,'Enter your name, up to 60 characters.');
  if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)fail(400,'Use a password between 12 and 128 characters.');
  if(await first(env.DB,'SELECT id FROM user WHERE email=?',email))fail(409,'An account already exists for this email. Use Sign in instead.');
  // Exchange the revocable group link for an internal, single-use MEMBER invitation.
  // Existing registration retains password hashing, sessions and all of its checks.
  const token=random();const tokenHash=await digest(token);
  await stmt(env.DB,"INSERT INTO invites(token_hash,email,role,expires_at,created_by,created_at) SELECT ?,?,'member',?,?,? WHERE EXISTS(SELECT 1 FROM group_join_links WHERE id=1 AND enabled=1 AND nonce=?)",tokenHash,email,Date.now()+600000,invitation.created_by,Date.now(),invitation.nonce).run();
  try {
    const proxied=new Request(new URL('/api/register',request.url),{method:'POST',headers:request.headers,body:JSON.stringify({token,email,name,password:body.password})});
    return await base.fetch(proxied,env,ctx);
  } finally {
    // Unused internal invitations must not remain usable after a failed attempt.
    await stmt(env.DB,'UPDATE invites SET expires_at=? WHERE token_hash=? AND used_at IS NULL',Date.now(),tokenHash).run();
  }
}

export function withCommunityTools(base,assets){
 return {...base,async fetch(request,env,ctx){
  const path=new URL(request.url).pathname;
  try {
    if(path==='/media/community-tools.js'||path==='/media/community-tools.css'){
      if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
      const js=path.endsWith('.js');return new Response(request.method==='HEAD'?null:js?assets.javascript:assets.css,{headers:{...headers,'Content-Type':js?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
    }
    if(path.startsWith('/api/community/')||path.startsWith('/api/admin/community/')){
      if(!['GET','POST'].includes(request.method))fail(405,'This method is not supported.');
      const body=request.method==='POST'?(sameOrigin(request,env),await readCommunityJson(request)):{};
      if(path==='/api/community/register'&&request.method==='POST')return await join(request,env,ctx,base,body);
      const data=await bootstrap(request,env,ctx,base);const member=data.user;
      if(path==='/api/community/game-details'&&request.method==='GET'){
        const raw=new URL(request.url).searchParams.get('id')||'';const id=Number(raw);
        if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(id))fail(400,'Use a valid BoardGameGeek game link.');
        const key='bgg-item-member:'+member.id+':'+Math.floor(Date.now()/60000);
        const limited=await first(env.DB,'INSERT INTO request_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key,Date.now()+120000);
        if(limited.count>20)fail(429,'Please wait a minute before looking up another game.');
        return json(await lookupGameDetails(env,id));
      }
      if(path==='/api/community/teach'&&request.method==='POST'){
        const game=(data.games||[]).find(g=>g.id===body.gameId);if(!game)fail(404,'This game is not available.');
        if(typeof body.teach!=='boolean')fail(400,'Choose whether you can teach.');
        const offer=game.offers.find(o=>o.userId===member.id);
        const counts=body.teach?body.counts:offer?.counts;
        if(!Array.isArray(counts)||!counts.length||counts.some(n=>!Number.isInteger(n)||n<2||n>12))fail(400,'Select the player counts you are willing to teach.');
        const target=new Request(new URL('/api/games/'+encodeURIComponent(game.id)+'/offer',request.url),{method:'PUT',headers:request.headers,body:JSON.stringify({own:!!offer?.own,teach:body.teach,counts,pitch:offer?.pitch||''})});
        return await base.fetch(target,env,ctx);
      }
      if(!path.startsWith('/api/admin/community/'))fail(404,'Action not found.');
      if(member.role!=='admin')fail(403,'Only the organiser can use this action.');
      if(path==='/api/admin/community/status'&&request.method==='GET')return json(await communityStatus(env));
      if(path==='/api/admin/community/join-link'&&request.method==='POST')return json(await changeGroupLink(env,member,body.action));
      if(['/api/admin/community/delete-game','/api/admin/community/restore-game'].includes(path)&&request.method==='POST')return json(await archiveGame(env,member,body.gameId,path.endsWith('/restore-game')));
      fail(404,'Action not found.');
    }
    if(path==='/api/games'&&request.method==='POST'){
      sameOrigin(request,env);await bootstrap(request,env,ctx,base);await guardArchivedAddition(env,await readCommunityJson(request.clone()));
    }
    const response=await base.fetch(request,env,ctx);
    if(path==='/api/game-thumbnails'&&response.ok){
      // The original endpoint has already checked membership and catalogue IDs.
      // Last-good cover URLs survive transient BGG/API outages and cache cleanup.
      const result=await response.json();const ids=(new URL(request.url).searchParams.get('ids')||'').split(',').map(Number);
      for(const id of ids){
        const current=safeArtwork(result.thumbnails?.[id]);
        if(current){
          await stmt(env.DB,'INSERT INTO game_metadata(bgg_id,title,thumbnail,fetched_at) SELECT ?,title,?,0 FROM games WHERE bgg_id=? AND archived_at IS NULL LIMIT 1 ON CONFLICT(bgg_id) DO UPDATE SET thumbnail=excluded.thumbnail',id,current,id).run();
        }else{
          const saved=await storedGameDetails(env,id);
          if(saved?.thumbnail){result.thumbnails[id]=saved.thumbnail;result.pending=(result.pending||[]).filter(v=>v!==id);}
        }
      }
      return json(result);
    }
    if(path==='/api/games'&&request.method==='POST'&&response.ok){
      const saved=await response.clone().json();
      const game=await first(env.DB,'SELECT bgg_id FROM games WHERE id=? AND archived_at IS NULL',saved.gameId);
      if(game?.bgg_id&&ctx?.waitUntil)ctx.waitUntil(lookupGameDetails(env,game.bgg_id).catch(()=>{}));
    }
    if(path==='/api/health'&&response.ok)return json({...await response.json(),version:COMMUNITY_VERSION});
    if(path==='/'&&request.method==='GET'&&response.ok&&response.headers.get('content-type')?.includes('text/html')){
      const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');
      // Load before the base app so it can intercept group-link registration and refresh cards.
      const html=(await response.text()).replace('<script ', '<script type="module" src="/media/community-tools.js?v='+COMMUNITY_VERSION+'"></script><script ').replace('</head>','<link rel="stylesheet" href="/media/community-tools.css?v='+COMMUNITY_VERSION+'"></head>');
      return new Response(html,{status:response.status,headers:h});
    }
    return response;
  }catch(error){return json({error:error instanceof CommunityError?error.message:'This change could not be completed. Please refresh and try again.'},error instanceof CommunityError?error.status:500);}
 }};
}
