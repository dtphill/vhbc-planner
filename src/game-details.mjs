/** Direct BGG item lookup. This does not use search or import user collections. */
const DAY = 86400000;
const MAX_BYTES = 524288;
export function bggIdFromLink(value) {
  if(typeof value!=='string'||value.length>2048)return null;
  const text=value.trim();
  if(!/^https?:\/\//i.test(text)||/[\u0000-\u0020\u007f\\]/u.test(text))return null;
  try{const u=new URL(text);if(!['http:','https:'].includes(u.protocol)||!['boardgamegeek.com','www.boardgamegeek.com'].includes(u.hostname)||u.username||u.password||u.port)return null;
    const m=/^\/boardgame\/([1-9]\d*)(?:\/[^\s]*)?$/.exec(u.pathname);const id=Number(m?.[1]);return Number.isSafeInteger(id)&&id>0?id:null;
  }catch{return null;}
}
export function safeArtwork(value){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/u.test(value))return null;
  try{const u=new URL(value.startsWith('//')?'https:'+value:value);return u.protocol==='https:'&&u.hostname==='cf.geekdo-images.com'&&!u.username&&!u.password&&!u.port&&!u.hash?u.href:null;}catch{return null;}
}
function text(value){return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(_,e)=>{
 if(e[0]!=='#')return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[e.toLowerCase()];
 const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):Number(e.slice(1));return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';
});}
function attributes(source){const out={};for(const m of source.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(["'])([^<>]*?)\2/g))out[m[1]]=text(m[3]);return out;}
export function parseGameDetails(xml,id){
 if(typeof xml!=='string'||xml.length>MAX_BYTES||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))throw new Error('Invalid item metadata');
 const doc=xml.replace(/<!--[\s\S]*?-->/g,'').trim();
 if(!/^(?:<\?xml[^?]*\?>\s*)?<items(?:\s[^>]*)?>[\s\S]*<\/items>\s*$/.test(doc))throw new Error('Invalid item metadata');
 for(const match of doc.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)){
  const item=attributes(match[1]);if(item.type!=='boardgame'||Number(item.id)!==id)continue;
  const names=[...match[2].matchAll(/<name\b([^>]*)\/?\s*>/g)].map(m=>attributes(m[1]));
  const title=names.find(n=>n.type==='primary')?.value?.replace(/\s+/gu,' ').trim();
  if(!title||title.length>300||/[\u0000-\u001f\u007f]/u.test(title))throw new Error('Invalid game title');
  const count=tag=>{const m=new RegExp('<'+tag+'\\b([^>]*)\\/?\\s*>').exec(match[2]);const s=m?attributes(m[1]).value:'';const n=Number(s);return /^\d+$/.test(s||'')&&Number.isInteger(n)&&n>=1&&n<=1000?n:null;};
  let minPlayers=count('minplayers'),maxPlayers=count('maxplayers');if(minPlayers&&maxPlayers&&minPlayers>maxPlayers){minPlayers=null;maxPlayers=null;}
  let raw=/<thumbnail(?:\s[^>]*)?>([\s\S]*?)<\/thumbnail>/.exec(match[2])?.[1]?.trim()||'';
  raw=raw.startsWith('<![CDATA[')&&raw.endsWith(']]>')?raw.slice(9,-3).trim():text(raw);
  return {bggId:id,title,thumbnail:safeArtwork(raw),minPlayers,maxPlayers};
 }
 return null;
}
async function readXml(response){
 if(Number(response.headers.get('content-length')||0)>MAX_BYTES){await response.body?.cancel();throw new Error('Item metadata too large');}
 if(!response.body)throw new Error('Missing item metadata');
 const reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,xml='';
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw new Error('Item metadata too large');xml+=decoder.decode(value,{stream:true});}return xml+decoder.decode();}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
}
function cachedDetail(row){
 if(!row||typeof row.title!=='string'||!row.title.trim())return null;
 return {bggId:row.bgg_id,title:row.title,thumbnail:safeArtwork(row.thumbnail),minPlayers:row.min_players||null,maxPlayers:row.max_players||null};
}
export async function storedGameDetails(env,id){return cachedDetail(await env.DB.prepare('SELECT * FROM game_metadata WHERE bgg_id=?').bind(id).first());}
export async function lookupGameDetails(env,id){
 const now=Date.now();const row=await env.DB.prepare('SELECT * FROM game_metadata WHERE bgg_id=?').bind(id).first();const cached=cachedDetail(row);
 if(cached&&row.fetched_at>now-7*DAY)return {game:cached,cached:true,stale:false};
 const fallback=(message,retryAfter=0)=>({game:cached,cached:!!cached,stale:!!cached,message,retryAfter});
 if(!env.BGG_TOKEN?.trim())return fallback('BGG is not connected. Enter the title manually.');
 const gate=await env.DB.prepare("INSERT INTO request_limits(key,count,expires_at) VALUES ('bgg-item-lookup',1,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE request_limits.expires_at<=? RETURNING key").bind(now+2000,now).first();
 if(!gate)return fallback('BGG lookup is busy. You can keep entering the game manually.',2);
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),6500);
 try{
  const target=new URL('https://boardgamegeek.com/xmlapi2/thing');target.searchParams.set('id',String(id));target.searchParams.set('type','boardgame');
  const response=await fetch(target,{headers:{Authorization:'Bearer '+env.BGG_TOKEN.trim(),Accept:'application/xml, text/xml'},redirect:'manual',signal:controller.signal});
  if(!response.ok||response.status===202){await response.body?.cancel();return fallback('BGG lookup is unavailable. You can enter the title manually.',[202,429].includes(response.status)?15:0);}
  const game=parseGameDetails(await readXml(response),id);if(!game)return fallback('No board game was found for that link. You can enter the details manually.');
  // Preserve a known cover if a later metadata response temporarily omits it.
  game.thumbnail=game.thumbnail||cached?.thumbnail||null;
  await env.DB.batch([
   env.DB.prepare('INSERT INTO game_metadata(bgg_id,title,thumbnail,min_players,max_players,fetched_at) VALUES (?,?,?,?,?,?) ON CONFLICT(bgg_id) DO UPDATE SET title=excluded.title,thumbnail=COALESCE(excluded.thumbnail,game_metadata.thumbnail),min_players=excluded.min_players,max_players=excluded.max_players,fetched_at=excluded.fetched_at').bind(id,game.title,game.thumbnail,game.minPlayers,game.maxPlayers,now),
   ...(game.thumbnail?[env.DB.prepare('INSERT INTO bgg_cache(query,response,expires_at) VALUES (?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response,expires_at=excluded.expires_at').bind('thumbnail:v1:'+id,JSON.stringify({thumbnail:game.thumbnail}),now+DAY)]:[])
  ]);
  return {game,cached:false,stale:false};
 }catch{return fallback('BGG lookup did not respond. You can enter the title manually.');}finally{clearTimeout(timeout);}
}
