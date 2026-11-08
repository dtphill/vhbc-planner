import {upgradePlannerClient, upgradeCommunityClient} from './planner-client-upgrade.mjs';
export const CATALOGUE_VERSION='1.4.0';
const DAY=86400000;
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
const json=(data,status=200)=>Response.json(data,{status,headers});
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const all=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results;
export function safeArtwork(value) {
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/u.test(value))return null;
  try{const u=new URL(value.startsWith('//')?'https:'+value:value);return u.protocol==='https:'&&u.hostname==='cf.geekdo-images.com'&&!u.username&&!u.password&&!u.port&&!u.hash?u.href:null;}catch{return null;}
}
// A single aggregate query. Ratings are unique per member/game; priority is already Want.
export async function catalogueStats(env){
 const rows=await all(env.DB,`SELECT g.id,gm.thumbnail,
 COALESCE(SUM(CASE WHEN m.disabled=0 AND r.value='want' THEN 1 ELSE 0 END),0) AS want,
 COALESCE(SUM(CASE WHEN m.disabled=0 AND r.value='will' THEN 1 ELSE 0 END),0) AS will
 FROM games g LEFT JOIN game_metadata gm ON gm.bgg_id=g.bgg_id
 LEFT JOIN ratings r ON r.game_id=g.id LEFT JOIN members m ON m.user_id=r.user_id
 WHERE g.archived_at IS NULL GROUP BY g.id`);
 return rows.map(r=>({id:r.id,thumbnail:safeArtwork(r.thumbnail),interestCounts:{want:Number(r.want)||0,will:Number(r.will)||0}}));
}
async function signedIn(request,env,ctx,base){
 const r=await base.fetch(new Request(new URL('/api/bootstrap',request.url),{headers:request.headers}),env,ctx);
 if(!r.ok)return {error:json({error:'The catalogue could not be loaded.'},503)};
 const data=await r.json();return data.user?{data}:{error:json({error:'Please sign in.'},401)};
}
export async function refreshArtwork(env,ids,games,helpers){
 const now=Date.now();
 const gate=await stmt(env.DB,"INSERT INTO request_limits(key,count,expires_at) VALUES ('bgg-thumbnail-fetch',1,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE request_limits.expires_at<=? RETURNING key",now+6000,now).first();
 if(!gate)return {thumbnails:{},pending:ids,retryAfter:6};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try {
  const url=new URL('https://boardgamegeek.com/xmlapi2/thing');url.searchParams.set('id',ids.join(','));url.searchParams.set('type','boardgame,boardgameexpansion');
  const r=await fetch(url,{headers:{Authorization:'Bearer '+env.BGG_TOKEN.trim(),Accept:'application/xml, text/xml'},redirect:'manual',signal:controller.signal});
  if(!r.ok||r.status===202){await r.body?.cancel();return {thumbnails:{},pending:ids,retryAfter:r.status===429?60:15};}
  const parsed=helpers.parseThumbnails(new TextDecoder('utf-8',{fatal:true}).decode(await helpers.boundedBytes(r,2097152)),ids);
  const thumbnails={},writes=[];
  for(const id of ids){
   const thumbnail=safeArtwork(parsed.get(id));thumbnails[id]=thumbnail;
   writes.push(stmt(env.DB,'INSERT INTO bgg_cache(query,response,expires_at) VALUES (?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response,expires_at=excluded.expires_at','thumbnail:v1:'+id,JSON.stringify({thumbnail,fetchedAt:now}),now+(thumbnail?DAY:60000)));
   if(thumbnail){
    const title=games.find(g=>g.bggId===id)?.title||'Game';
    writes.push(stmt(env.DB,'INSERT INTO game_metadata(bgg_id,title,thumbnail,fetched_at) VALUES (?,?,?,0) ON CONFLICT(bgg_id) DO UPDATE SET thumbnail=excluded.thumbnail WHERE game_metadata.thumbnail IS NOT excluded.thumbnail',id,title,thumbnail));
   }
  }
  if(writes.length)await env.DB.batch(writes);
  return {thumbnails,pending:[]};
 }catch{return {thumbnails:{},pending:ids,retryAfter:15};}finally{clearTimeout(timer);}
}
/** Reuse saved covers immediately. Only a genuinely unknown cover waits for BGG. */
export async function fastThumbnails(request,env,ctx,base,helpers){
 if(request.method!=='GET')return json({error:'Use GET.'},405);
 const raw=new URL(request.url).searchParams.get('ids')||'';
 if(!/^[1-9]\d*(?:,[1-9]\d*){0,19}$/.test(raw))return json({error:'Choose between 1 and 20 game IDs.'},400);
 const ids=[...new Set(raw.split(',').map(Number))];if(ids.some(id=>!Number.isSafeInteger(id)))return json({error:'Invalid game ID.'},400);
 const auth=await signedIn(request,env,ctx,base);if(auth.error)return auth.error;
 const games=auth.data.games||[],allowed=new Set(games.map(g=>g.bggId));
 if(ids.some(id=>!allowed.has(id)))return json({error:'Only linked games in this group are available.'},403);
 const placeholders=ids.map(()=>'?').join(','),now=Date.now();
 const [cacheRows,metadata]=await Promise.all([
  all(env.DB,'SELECT query,response,expires_at FROM bgg_cache WHERE query IN ('+placeholders+')',...ids.map(id=>'thumbnail:v1:'+id)),
  all(env.DB,'SELECT bgg_id,thumbnail FROM game_metadata WHERE bgg_id IN ('+placeholders+')',...ids)
 ]);
 const cache=new Map(cacheRows.map(r=>[Number(r.query.slice('thumbnail:v1:'.length)),r])),known=new Map(metadata.map(r=>[r.bgg_id,safeArtwork(r.thumbnail)]));
 const thumbnails={},missing=[],stale=[];
 for(const id of ids){
  const row=cache.get(id);let saved=null;try{if(row?.response?.length<4096)saved=JSON.parse(row.response);}catch{}
  const image=safeArtwork(saved?.thumbnail)||known.get(id);
  if(image){thumbnails[id]=image;if(!row||row.expires_at<=now)stale.push(id);}
  else if(saved?.thumbnail===null&&row.expires_at>now&&Number.isFinite(saved.fetchedAt)&&now-saved.fetchedAt<60000)thumbnails[id]=null;
  else missing.push(id);
 }
 if(!env.BGG_TOKEN?.trim()){for(const id of missing)thumbnails[id]=null;return json({thumbnails,pending:[]});}
 if(!missing.length){
  if(stale.length&&ctx?.waitUntil)ctx.waitUntil(refreshArtwork(env,stale,games,helpers).catch(()=>{}));
  return json({thumbnails,pending:[]});
 }
 const result=await refreshArtwork(env,missing,games,helpers);
 return json({...result,thumbnails:{...thumbnails,...result.thumbnails}});
}
export function withCatalogueEnhancements(base,assets,helpers){
 const transformed=new Map();
 const staticFiles={
  '/media/catalogue-tools.js':[assets.javascript,'text/javascript; charset=utf-8'],
  '/media/catalogue-tools.css':[assets.css,'text/css; charset=utf-8'],
  '/media/artwork-cache.js':[assets.artworkCache,'text/javascript; charset=utf-8'],
  '/media/game-media.js':[assets.artworkClient,'text/javascript; charset=utf-8']
 };
 return {...base,async fetch(request,env,ctx){
  const url=new URL(request.url),path=url.pathname;
  try {
   if(staticFiles[path]){
    if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
    const [body,type]=staticFiles[path];return new Response(request.method==='HEAD'?null:body,{headers:{...headers,'Content-Type':type,'Cache-Control':url.searchParams.get('v')===CATALOGUE_VERSION?'public, max-age=31536000, immutable':'public, max-age=300'}});
   }
   if(path==='/api/game-thumbnails')return await fastThumbnails(request,env,ctx,base,helpers);
   if(path==='/api/search'&&request.method==='GET'){
    const auth=await signedIn(request,env,ctx,base);if(auth.error)return auth.error;
    const q=(url.searchParams.get('q')||'').trim(),flag=url.searchParams.get('expansions');
    if(q.length<2||q.length>100||/[\u0000-\u001f\u007f]/.test(q))return json({error:'Enter between 2 and 100 characters.'},400);
    if(flag!==null&&!['0','1'].includes(flag))return json({error:'Choose whether to include expansions.'},400);
    const now=Date.now(),key='catalogue-search:'+auth.data.user.id+':'+Math.floor(now/60000);
    const limit=await stmt(env.DB,'INSERT INTO request_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key,now+120000).first();
    if(limit.count>15)return json({error:'Please wait a minute before searching again.'},429);
    const external=await helpers.searchBgg(q,env,flag==='1');
    const games=auth.data.games||[];
    // Existing group entries remain findable, including manual entries, during BGG outages.
    const remote=(external.results||[]).map(r=>({...r,existingGameId:games.find(g=>g.bggId===r.bggId)?.id??null}));
    const local=games.filter(g=>g.title.toLowerCase().includes(q.toLowerCase())&&!remote.some(r=>r.bggId&&r.bggId===g.bggId)).map(g=>({title:g.title,bggId:g.bggId,year:null,existingGameId:g.id}));
    return json({...external,results:helpers.rankSearchResults([...local,...remote],q).slice(0,25)});
   }
   const response=await base.fetch(request,env,ctx);
   if(path==='/api/bootstrap'&&response.ok){
    const data=await response.json();
    if(data.user){const stats=new Map((await catalogueStats(env)).map(g=>[String(g.id),g]));data.games=(data.games||[]).map(g=>({...g,...stats.get(String(g.id))}));}
    return json(data);
   }
   if(['/api/rating','/api/priority'].includes(path)&&request.method==='POST'&&response.ok){
    const result=await response.json();
    // The mutation already succeeded. A display-stat failure must not falsely report save failure.
    try{result.gameStats=await catalogueStats(env);}catch{result.refreshRequired=true;}
    return json(result);
   }
   if(path==='/api/health'&&response.ok)return json({...await response.json(),catalogue:CATALOGUE_VERSION});
   if(['/app.js','/media/community-tools.js'].includes(path)&&request.method==='GET'&&response.ok){
    const original=await response.text(),key=path;
    let cached=transformed.get(key);
    if(!cached||cached.original!==original){
     const updated=path==='/app.js'?upgradePlannerClient(original):upgradeCommunityClient(original);
     cached={original,updated};transformed.set(key,cached);
    }
    const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');h.set('Cache-Control','public, max-age=300');return new Response(cached.updated,{status:response.status,headers:h});
   }
   if(path==='/'&&request.method==='GET'&&response.ok&&response.headers.get('content-type')?.includes('text/html')){
    const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');h.set('Cache-Control','no-cache');
    let html=await response.text();
    html=html.replace(/(src="(?:\/app\.js|\/media\/(?:community-tools|game-media)\.js))(?:\?[^\"]*)?"/g,'$1?v='+CATALOGUE_VERSION+'"');
    html=html.replace('<script ','<script type="module" src="/media/catalogue-tools.js?v='+CATALOGUE_VERSION+'"></script><script ').replace('</head>','<link rel="stylesheet" href="/media/catalogue-tools.css?v='+CATALOGUE_VERSION+'"></head>');
    return new Response(html,{status:response.status,headers:h});
   }
   return response;
  }catch(error){console.error(JSON.stringify({event:'catalogue.enhancement.failed',name:error?.name||'Error'}));return json({error:'The catalogue could not be loaded. Please refresh and try again.'},503);}
 }};
}
