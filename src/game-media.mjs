/** Optional BGG artwork layer. Accounts, preferences and allocation stay in the base Worker. */
export const MEDIA_VERSION = '1.2.0';
// Unmodified Powered by BGG lockup. Source/provenance is recorded in docs/game-media.md.
export const BADGE_URL = 'https://dm1i7q1ruvbhg.cloudfront.net/assets/powered_by_bgg-9f2993c7fad826d5407c35b5c8117b08d2a6cdf5beb1f0c02d06a7dc7f5cdd7f.png';
const DAY = 86400000;
const PREFIX = 'thumbnail:v1:';
const HEADERS = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
const reply = (body,status=200) => Response.json(body,{status,headers:HEADERS});

export function safeThumbnail(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:'+value : value);
    if (url.protocol !== 'https:' || url.hostname !== 'cf.geekdo-images.com' || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch { return null; }
}
function xmlText(text) {
  if (text.startsWith('<![CDATA[') && text.endsWith(']]>')) return text.slice(9,-3).trim();
  if (/[<>]/u.test(text)) return '';
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(_,entity)=>{
    if (entity[0] !== '#') return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[entity.toLowerCase()];
    const n = entity[1].toLowerCase()==='x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff) ? String.fromCodePoint(n) : '';
  });
}
/** Extract only item IDs and thumbnail URLs; no XML entity expansion or other metadata is used. */
export function parseThumbnails(xml, ids) {
  if (typeof xml !== 'string' || xml.length > 2097152 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Invalid BGG image response');
  const document = xml.replace(/<!--[\s\S]*?-->/g,'').trim();
  if (!/^(?:<\?xml[^?]*\?>\s*)?<items(?:\s[^>]*)?>[\s\S]*<\/items>\s*$/.test(document)) throw new Error('Invalid BGG image response');
  const wanted = new Set(ids);
  const found = new Map();
  for (const match of document.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)) {
    const idMatch=/(?:^|\s)id\s*=\s*(["'])([1-9]\d*)\1/.exec(match[1]);
    const typeMatch=/(?:^|\s)type\s*=\s*(["'])boardgame\1/.exec(match[1]);
    const id=Number(idMatch?.[2]);
    if (!typeMatch || !wanted.has(id) || found.has(id)) continue;
    const raw=/<thumbnail(?:\s[^>]*)?>([\s\S]*?)<\/thumbnail>/.exec(match[2]);
    found.set(id,raw ? safeThumbnail(xmlText(raw[1].trim())) : null);
  }
  return found;
}
export async function boundedBytes(response, maximum) {
  const size=Number(response.headers.get('content-length')||0);
  if (size>maximum) { await response.body?.cancel(); throw new Error('Response too large'); }
  if (!response.body) throw new Error('Empty response');
  const reader=response.body.getReader(); const chunks=[]; let length=0;
  try {
    while (true) {const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>maximum)throw new Error('Response too large');chunks.push(value);}
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
}

export async function thumbnailResponse(request, env, ctx, base) {
  if (request.method!=='GET') return reply({error:'Use GET.'},405);
  const url=new URL(request.url);
  const raw=url.searchParams.get('ids')||'';
  if (!/^[1-9]\d*(?:,[1-9]\d*){0,19}$/.test(raw)) return reply({error:'Choose between 1 and 20 game IDs.'},400);
  const ids=[...new Set(raw.split(',').map(Number))];
  if (ids.some(id=>!Number.isSafeInteger(id))) return reply({error:'Invalid game ID.'},400);
  // Reuse the application's existing session and active-membership checks, never a new login mechanism.
  const boot=await base.fetch(new Request(new URL('/api/bootstrap',request.url),{headers:request.headers}),env,ctx);
  if (!boot.ok) return reply({error:'The game catalogue could not be loaded.'},503);
  const data=await boot.json();
  if (!data.user) return reply({error:'Please sign in.'},401);
  const allowed=new Set((data.games||[]).map(g=>g.bggId));
  if (ids.some(id=>!allowed.has(id))) return reply({error:'Only linked games in this group are available.'},403);
  const thumbnails={}; const pending=[]; const now=Date.now();
  if (!env.BGG_TOKEN) return reply({thumbnails:Object.fromEntries(ids.map(id=>[id,null])),pending:[]});
  for (const id of ids) {
    let cached;
    try {
      const row=await env.DB.prepare('SELECT response FROM bgg_cache WHERE query=? AND expires_at>?').bind(PREFIX+id,now).first();
      if (row && row.response.length<=4096) cached=JSON.parse(row.response);
    } catch { /* Artwork remains optional if a cache row is damaged. */ }
    if (cached && (cached.thumbnail===null || safeThumbnail(cached.thumbnail))) thumbnails[id]=cached.thumbnail;
    else pending.push(id);
  }
  if (!pending.length) return reply({thumbnails,pending:[]});
  // Coordinate cache misses across visitors, rather than each browser hitting BGG independently.
  const gate=await env.DB.prepare("INSERT INTO request_limits(key,count,expires_at) VALUES ('bgg-thumbnail-fetch',1,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at WHERE request_limits.expires_at<=? RETURNING key").bind(now+6000,now).first();
  if (!gate) return reply({thumbnails,pending,retryAfter:6});
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const target=new URL('https://boardgamegeek.com/xmlapi2/thing');
    target.searchParams.set('id',pending.join(',')); target.searchParams.set('type','boardgame');
    const response=await fetch(target,{headers:{Authorization:'Bearer '+env.BGG_TOKEN.trim(),Accept:'application/xml, text/xml'},redirect:'error',signal:controller.signal});
    if (!response.ok || response.status===202) {
      await response.body?.cancel();
      return reply({thumbnails,pending,retryAfter:response.status===429?60:15});
    }
    const xml=new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response,2097152));
    const parsed=parseThumbnails(xml,pending);
    const writes=[];
    for(const id of pending) {
      const thumbnail=parsed.get(id)||null; thumbnails[id]=thumbnail;
      writes.push(env.DB.prepare('INSERT INTO bgg_cache(query,response,expires_at) VALUES (?,?,?) ON CONFLICT(query) DO UPDATE SET response=excluded.response,expires_at=excluded.expires_at').bind(PREFIX+id,JSON.stringify({thumbnail}),now+(parsed.has(id)?DAY:60000)));
    }
    await env.DB.batch(writes);
    return reply({thumbnails,pending:[]});
  } catch { return reply({thumbnails,pending,retryAfter:15}); }
  finally {clearTimeout(timer);}
}

async function badgeResponse(request, ctx) {
  const cache=globalThis.caches?.default;
  const key=new Request(new URL('/media/powered-by-bgg.png',request.url));
  let cached=await cache?.match(key);
  if(cached) return request.method==='HEAD'?new Response(null,cached):cached;
  const response=await fetch(BADGE_URL,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/png')) {await response.body?.cancel();return new Response('Badge temporarily unavailable',{status:503,headers:HEADERS});}
  const bytes=await boundedBytes(response,524288);
  if (![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)) throw new Error('Invalid badge image');
  cached=new Response(bytes,{headers:{...HEADERS,'Content-Type':'image/png','Cache-Control':'public, max-age=604800'}});
  if(cache) ctx.waitUntil(cache.put(key,cached.clone()));
  return request.method==='HEAD'?new Response(null,cached):cached;
}
const credit='<footer class="vhbc-bgg-credit"><a href="https://boardgamegeek.com/" target="_blank" rel="noopener noreferrer" aria-label="Powered by BoardGameGeek"><img src="/media/powered-by-bgg.png" width="220" height="63" alt="Powered by BoardGameGeek" decoding="async" referrerpolicy="no-referrer"></a><span>Game data and cover images from BoardGameGeek.</span></footer>';

export function withGameMedia(base, assets) {
  return {
    ...base,
    async fetch(request,env,ctx) {
      const path=new URL(request.url).pathname;
      try {
        if(path==='/api/game-thumbnails') return await thumbnailResponse(request,env,ctx,base);
        if(['/media/game-media.js','/media/game-media.css','/media/powered-by-bgg.png'].includes(path)) {
          if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:HEADERS});
          if(path==='/media/powered-by-bgg.png')return await badgeResponse(request,ctx);
          const js=path.endsWith('.js');
          return new Response(request.method==='HEAD'?null:js?assets.javascript:assets.css,{headers:{...HEADERS,'Content-Type':js?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
        }
        const response=await base.fetch(request,env,ctx);
        if(path==='/api/health' && response.ok) return reply({...await response.json(),version:MEDIA_VERSION});
        if(path!=='/' || request.method!=='GET' || !response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;
        const headers=new Headers(response.headers);
        const policy=headers.get('Content-Security-Policy')||"default-src 'self'; img-src 'self' data:;";
        headers.set('Content-Security-Policy',policy.replace(/img-src[^;]*/,m=>m+' https://cf.geekdo-images.com'));
        headers.delete('Content-Length'); headers.delete('ETag');
        const html=(await response.text()).replace('</head>','<link rel="stylesheet" href="/media/game-media.css?v='+MEDIA_VERSION+'"></head>').replace('</body>',credit+'<script type="module" src="/media/game-media.js?v='+MEDIA_VERSION+'"></script></body>');
        return new Response(html,{status:response.status,headers});
      } catch { return reply({error:'Images are temporarily unavailable. Your game preferences are unchanged.'},503); }
    },
  };
}
