import {cachedArtwork, rememberArtwork, forgetArtwork, safeImage} from '/media/artwork-cache.js?v=1.4.0';
const main = document.getElementById('main');
const missing = new Set();
const pending = new Set();
const attempts = new Map();
let running = false, timer = null, frame = null;
function idFromLink(link) {
  try { const u=new URL(link.href), m=/^\/boardgame\/([1-9]\d*)(?:\/|$)/.exec(u.pathname); return ['boardgamegeek.com','www.boardgamegeek.com'].includes(u.hostname) && m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : null; } catch { return null; }
}
function showImage(box, value) {
  const url = safeImage(value); if (!url || box.dataset.imageUrl === url) return;
  const old = box.querySelector('img'); if (old) old.remove();
  box.dataset.imageUrl = url;
  const img = document.createElement('img'); img.alt = 'Cover of '+box.dataset.title;
  img.loading='lazy'; if(box.dataset.eager==='true')img.loading='eager';
  img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.width=144; img.height=128;
  img.addEventListener('load',()=>{box.classList.add('vhbc-cover-loaded'); box.classList.remove('vhbc-cover-missing');});
  img.addEventListener('error',()=>{img.remove();box.classList.remove('vhbc-cover-loaded');box.classList.add('vhbc-cover-missing');delete box.dataset.imageUrl;const id=Number(box.dataset.bggId);forgetArtwork(id);if((attempts.get(id)||0)<3){pending.add(id);queueFetch();}},{once:true});
  img.src=url; box.append(img);
}
function paint() {
  if(!main)return;
  for(const box of main.querySelectorAll('.vhbc-game-cover[data-bgg-id]')) {
    const id=Number(box.dataset.bggId), url=cachedArtwork(id);
    if(url)showImage(box,url);else if(missing.has(id))box.classList.add('vhbc-cover-missing');
  }
}
function queueFetch(){if(pending.size&&!running&&!timer)timer=setTimeout(flush,80);}
function scan() {
  frame=null;if(!main)return;let position=0;
  for(const card of main.querySelectorAll('.mq-game, .mq-review-title')) {
    const eager=position++<4;
    if(card.querySelector('.vhbc-game-cover'))continue;
    const link=[...card.querySelectorAll('a[href]')].find(a=>idFromLink(a));
    const id=link?idFromLink(link):null,title=card.querySelector('h3')?.textContent||'Game';
    const box=document.createElement(link?'a':'div');box.className='vhbc-game-cover';box.dataset.title=title;box.dataset.eager=String(eager);
    if(link){box.href=link.href;box.target='_blank';box.rel='noopener noreferrer';box.setAttribute('aria-label','View '+title+' on BoardGameGeek');box.dataset.bggId=id;}
    const placeholder=document.createElement('span');placeholder.className='vhbc-cover-placeholder';placeholder.setAttribute('aria-hidden','true');placeholder.textContent=title.replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();box.append(placeholder);
    card.insertBefore(box,card.querySelector('h3'));
    const saved=id&&cachedArtwork(id);
    if(saved)showImage(box,saved);
    else if(id&&!missing.has(id)&&(attempts.get(id)||0)<3)pending.add(id);
    else if(!id)box.classList.add('vhbc-cover-missing');
  }
  paint();queueFetch();
}
function schedule(){if(frame===null)frame=requestAnimationFrame(scan);}
async function flush(){
  timer=null;if(running||!pending.size)return;
  // Bootstrap may have supplied artwork while this batch was waiting.
  for(const id of pending)if(cachedArtwork(id))pending.delete(id);
  const ids=[...pending].slice(0,20);if(!ids.length)return;
  running=true;ids.forEach(id=>{pending.delete(id);attempts.set(id,(attempts.get(id)||0)+1);});let delay=100;
  try {
    const response=await fetch('/api/game-thumbnails?ids='+ids.join(','),{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Artwork lookup failed');const data=await response.json();
    for(const id of ids)if(Object.hasOwn(data.thumbnails||{},id)){if(rememberArtwork(id,data.thumbnails[id]))missing.delete(id);else if(!(data.pending||[]).includes(id))missing.add(id);}
    for(const id of data.pending||[])if(ids.includes(id)&&(attempts.get(id)||0)<3)pending.add(id);
    delay=Math.max(100,Math.min(60000,(Number(data.retryAfter)||0)*1000));
  } catch {for(const id of ids)if((attempts.get(id)||0)<3)pending.add(id);delay=5000;}
  finally{running=false;paint();if(pending.size)timer=setTimeout(flush,delay);}
}
window.addEventListener('vhbc:artwork-ready',schedule);
if(main){new MutationObserver(schedule).observe(main,{childList:true,subtree:true});schedule();}
