import {rememberArtwork} from '/media/artwork-cache.js?v=1.4.0';
const main=document.getElementById('main');
const originalFetch=window.fetch.bind(window);
let catalogue=new Map(), includeExpansions=false, frame=null, searchResults=[];
function acceptData(data){
  catalogue=new Map((data.user?(data.games||[]):[]).map(g=>[String(g.id),g]));
  for(const game of catalogue.values())if(game.thumbnail)rememberArtwork(Number(game.bggId),game.thumbnail);
  window.dispatchEvent(new Event('vhbc:artwork-ready'));schedule();
}
window.fetch=async(input,options)=>{
  const u=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
  let target=input;
  if(u.origin===location.origin&&u.pathname==='/api/search'){
    u.searchParams.set('expansions',includeExpansions?'1':'0');target=input instanceof Request?new Request(u,input):u.href;
  }
  const response=await originalFetch(target,options);
  if(u.origin===location.origin&&response.ok){
    if(u.pathname==='/api/bootstrap'){try{acceptData(await response.clone().json());}catch{}}
    if(u.pathname==='/api/search'){try{searchResults=(await response.clone().json()).results||[];schedule();}catch{}}
  }
  return response;
};
window.addEventListener('vhbc:data-updated',event=>acceptData(event.detail));
function decorate(){
  frame=null;if(!main)return;
  const field=main.querySelector('#add-search');
  if(field&&!main.querySelector('#include-expansions')){
    const row=document.createElement('div');row.className='ce-search-controls';
    const label=document.createElement('label');label.className='ce-expansion-choice';
    const box=document.createElement('input');box.type='checkbox';box.id='include-expansions';box.checked=includeExpansions;
    label.append(box,document.createTextNode('Include expansions'));row.append(label);field.closest('label').after(row);
    box.addEventListener('change',()=>{includeExpansions=box.checked;searchResults=[];field.dispatchEvent(new Event('input',{bubbles:true}));});
  }
  for(const card of main.querySelectorAll('.mq-game')){
    const game=catalogue.get(card.id.replace(/^game-/,''));if(!game?.interestCounts)continue;
    const {want,will}=game.interestCounts;
    let totals=card.querySelector('.ce-interest-counts');
    if(!totals){totals=document.createElement('div');totals.className='ce-interest-counts';totals.title='Current saved preferences across all active group members, not just next meeting attendees. Priority picks are included in Want.';card.querySelector('.mq-choice')?.before(totals);}
    const text='Want '+want+' · Will play '+will;
    if(totals.textContent!==text)totals.textContent=text;
    const a=want+' group member'+(want===1?'':'s')+' want to play; '+will+' will play';
    if(totals.getAttribute('aria-label')!==a)totals.setAttribute('aria-label',a);
  }
  for(const button of main.querySelectorAll('[data-search-result]')){
    const result=searchResults[Number(button.dataset.searchResult)];
    if(result?.isExpansion&&!button.querySelector('.ce-expansion-tag')){const tag=document.createElement('small');tag.className='ce-expansion-tag';tag.textContent='Expansion';button.querySelector('.mq-result-title')?.append(tag);}
  }
}
function schedule(){if(frame===null)frame=requestAnimationFrame(decorate);}
if(main){new MutationObserver(schedule).observe(main,{childList:true,subtree:true});schedule();}
