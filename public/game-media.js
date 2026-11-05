// Decorative, non-blocking artwork. The main planner does not depend on this module.
const main = document.getElementById('main');
const images = new Map();
const attempts = new Map();
const pending = new Set();
let running = false;
let timer;
const idFromLink = link => {
  try {const u=new URL(link.href);const m=/^\/boardgame\/([1-9]\d*)(?:\/|$)/.exec(u.pathname);return u.hostname==='boardgamegeek.com' && m ? Number(m[1]) : null;}catch{return null;}
};
const safeImage = value => {
  try {const u=new URL(value);return u.protocol==='https:' && u.hostname==='cf.geekdo-images.com' && !u.username && !u.password && !u.port ? u.href : null;}catch{return null;}
};
function showImage(box, url) {
  if(box.dataset.imageDone)return;
  box.dataset.imageDone='true';
  if(!url){box.classList.add('vhbc-cover-missing');return;}
  const img=document.createElement('img');
  img.alt='Cover of '+box.dataset.title;
  img.loading='lazy'; img.decoding='async'; img.referrerPolicy='no-referrer';
  img.width=144; img.height=128;
  img.addEventListener('load',()=>{box.classList.add('vhbc-cover-loaded');});
  img.addEventListener('error',()=>{img.remove();box.classList.add('vhbc-cover-missing');},{once:true});
  img.src=url; box.append(img);
}
function paint() {
  for(const box of main.querySelectorAll('.vhbc-game-cover[data-bgg-id]')){
    const id=Number(box.dataset.bggId);
    if(images.has(id))showImage(box,images.get(id));
  }
}
function scan() {
  for(const card of main.querySelectorAll('.mq-game, .mq-review-title')) {
    if(card.querySelector('.vhbc-game-cover'))continue;
    const link=[...card.querySelectorAll('a[href]')].find(a=>idFromLink(a));
    const id=link?idFromLink(link):null;
    const title=card.querySelector('h3')?.textContent||'Game';
    const box=document.createElement(link?'a':'div');
    box.className='vhbc-game-cover'; box.dataset.title=title;
    if(link){box.href=link.href;box.target='_blank';box.rel='noopener noreferrer';box.setAttribute('aria-label','View '+title+' on BoardGameGeek');box.dataset.bggId=id;}
    const placeholder=document.createElement('span');placeholder.className='vhbc-cover-placeholder';placeholder.setAttribute('aria-hidden','true');
    placeholder.textContent=title.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();box.append(placeholder);
    card.insertBefore(box,card.querySelector('h3'));
    if(!id){box.classList.add('vhbc-cover-missing');box.title='No BoardGameGeek cover linked';}
    else if(images.has(id))showImage(box,images.get(id));
    else if((attempts.get(id)||0)<3)pending.add(id);
  }
  paint();
  if(pending.size&&!running&&!timer)timer=setTimeout(flush,100);
}
async function flush() {
  timer=null;if(running||!pending.size)return;
  running=true;
  const ids=[...pending].slice(0,20);ids.forEach(id=>{pending.delete(id);attempts.set(id,(attempts.get(id)||0)+1);});
  let delay=100;
  try {
    const response=await fetch('/api/game-thumbnails?ids='+ids.join(','),{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('No artwork response');
    const data=await response.json();
    for(const id of ids)if(Object.hasOwn(data.thumbnails||{},id))images.set(id,safeImage(data.thumbnails[id]));
    for(const id of data.pending||[])if(ids.includes(id)&&(attempts.get(id)||0)<3)pending.add(id);
    delay=Math.max(100,Math.min(60000,(Number(data.retryAfter)||0)*1000));
  } catch { for(const id of ids)images.set(id,null); }
  finally {running=false;paint();if(pending.size)timer=setTimeout(flush,delay);}
}
if(main){new MutationObserver(scan).observe(main,{childList:true,subtree:true});scan();}
