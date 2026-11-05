// Small catalogue and joining controls; no BGG profile access or collection import.
const originalFetch=window.fetch.bind(window);
let data=null,admin=null,loadingAdmin=false,queued=false,busy=false;
const fragment=new URLSearchParams(location.hash.slice(1));
const joinToken=fragment.get('join');
if(joinToken){
  // Reuse the existing three-field registration form and its password-manager support.
  history.replaceState(null,'',location.pathname+location.search+'#invite='+encodeURIComponent(joinToken));
}
const main=document.getElementById('main');
const root=document.getElementById('vhbc-monthly-planner');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function announce(message){const target=document.getElementById('status');if(target)target.textContent=message;}
function error(message){const target=document.getElementById('notice');if(target){target.hidden=false;target.textContent=message;}}
function schedule(){if(!queued){queued=true;queueMicrotask(()=>{queued=false;decorate();});}}
window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
  let target=input,init=options;
  if(url.origin===location.origin&&url.pathname==='/api/register'&&options?.body){
    try{const body=JSON.parse(options.body);if(typeof body.token==='string'&&/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(body.token)){target='/api/community/register';init={...options};}}catch{}
  }
  const response=await originalFetch(target,init);
  if(url.origin===location.origin&&url.pathname==='/api/bootstrap'&&response.ok){
    try{data=await response.clone().json();if(!data.user)admin=null;schedule();}catch{}
  }
  return response;
};
async function api(path,body){
  const response=await originalFetch(path,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  let result;try{result=await response.json();}catch{throw new Error('Unexpected server response. Please try again.');}
  if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'This change could not be saved.');return result;
}
function reloadAt(view,message){
  try{sessionStorage.setItem('vhbc-return-view',view);sessionStorage.setItem('vhbc-flash',message);}catch{}
  location.reload();
}
function decorate(){
  if(!main||!data)return;
  const registration=document.getElementById('register-form');
  if(registration&&!registration.querySelector('.ct-join-note')){
    const note=document.createElement('p');note.className='ct-join-note mq-muted';note.textContent='No BoardGameGeek account is needed. Joining does not import any games.';registration.prepend(note);
    const signIn=document.createElement('button');signIn.type='button';signIn.className='mq-small-action';signIn.dataset.ctSignIn='true';signIn.textContent='Already a member? Sign in';registration.append(signIn);
    const password=registration.querySelector('input[name="password"]');
    if(password){const label=document.createElement('label');label.className='ct-show-password';label.innerHTML='<input type="checkbox" data-ct-password> Show password';password.closest('label').after(label);}
  }
  if(!data.user)return;
  for(const card of main.querySelectorAll('.mq-game')){
    const id=card.id.replace(/^game-/,'');const game=(data.games||[]).find(g=>g.id===id);if(!game)continue;
    const own=(game.offers||[]).find(o=>o.userId===data.user.id);
    let teaching=card.querySelector('.ct-teaching');
    if(!teaching){teaching=document.createElement('div');teaching.className='ct-teaching';const offers=card.querySelector('.offers');if(offers)offers.before(teaching);else card.querySelector('.mq-choice')?.before(teaching);}
    const html=(!(game.offers||[]).some(o=>o.teach)?'<span class="ct-teacher-wanted">Teacher wanted</span>':'')+'<button type="button" class="mq-small-action ct-teach" data-ct-teach="'+esc(id)+'" aria-pressed="'+!!own?.teach+'">'+(own?.teach?'I can teach · edit':'I can teach')+'</button>';
    if(teaching.innerHTML!==html)teaching.innerHTML=html;
    if(data.user.role==='admin'&&!card.querySelector('[data-ct-delete]')){
      const management=document.createElement('div');management.className='ct-card-management';
      const edit=card.querySelector('.offer-edit');if(edit){edit.before(management);management.append(edit);}else card.append(management);
      const remove=document.createElement('button');remove.type='button';remove.className='mq-small-action ct-delete';remove.dataset.ctDelete=id;remove.textContent='Delete game';management.append(remove);
    }
  }
  const gameForm=document.getElementById('game-form');
  if(gameForm&&!gameForm.querySelector('.ct-catalogue-note')&&!gameForm.querySelector('[name="title"]')?.readOnly){
    const note=document.createElement('p');note.className='ct-catalogue-note mq-muted';note.textContent='Add a game you genuinely want to offer for a group session—not your whole collection. Games are added individually.';gameForm.prepend(note);
  }
  const invite=document.getElementById('invite-form');
  if(invite&&data.user.role==='admin'){
    let panel=document.getElementById('ct-admin');if(!panel){panel=document.createElement('section');panel.id='ct-admin';panel.className='mq-section spaced-section';invite.closest('section').before(panel);renderAdmin();}
    if(admin===null&&!loadingAdmin){loadingAdmin=true;api('/api/admin/community/status').then(result=>{admin=result;renderAdmin();}).catch(e=>{panel.innerHTML='<h2>Group invitations</h2><p>'+esc(e.message)+'</p><button type="button" data-ct-admin="retry">Try again</button>';}).finally(()=>{loadingAdmin=false;});}
    const heading=invite.closest('section').querySelector('h2');if(heading&&heading.textContent!=='Individual invitation')heading.textContent='Individual invitation';
  }
  watchFormDetails();
  let returnView,flash;try{returnView=sessionStorage.getItem('vhbc-return-view');flash=sessionStorage.getItem('vhbc-flash');}catch{}
  if(returnView){const button=document.querySelector('#navigation [data-view="'+(returnView==='organise'?'organise':'games')+'"]');if(button){try{sessionStorage.removeItem('vhbc-return-view');sessionStorage.removeItem('vhbc-flash');}catch{}queueMicrotask(()=>{button.click();if(flash)announce(flash);});}}
}
function renderAdmin(){
  const panel=document.getElementById('ct-admin');if(!panel)return;
  if(!admin){panel.innerHTML='<h2>Invite the group</h2><p class="mq-muted">Loading invitation controls…</p>';return;}
  const enabled=admin.joinLink?.enabled;
  panel.innerHTML='<h2>Invite the group</h2><p class="mq-muted">Share one link with the group. Members enter their name, email and password. No BGG account or collection import.</p>'+(enabled?'<label class="ct-link-label">Group sign-up link<input id="ct-join-link" value="'+esc(admin.joinLink.url)+'" readonly spellcheck="false"></label><div class="mq-inline"><button type="button" class="mq-primary" data-ct-admin="copy">Copy group link</button><button type="button" class="mq-small-action" data-ct-admin="replace">Replace link</button><button type="button" class="mq-small-action" data-ct-admin="disable">Disable link</button></div><p class="mq-muted">Anyone with this link can join as a member, not an organiser. Share it within the group. Replacing or disabling it stops new sign-ups through the old link; existing members keep their accounts.</p>':'<button type="button" class="mq-primary" data-ct-admin="create">Create group invitation</button><p class="mq-muted">No reusable link is currently active. Individual invitations below still work.</p>')+'<details class="organiser-details ct-deleted"><summary>Deleted games</summary>'+(admin.archivedGames?.length?'<ul class="fixed-list">'+admin.archivedGames.map(game=>'<li><span>'+esc(game.title)+'</span><button type="button" class="mq-small-action" data-ct-restore="'+esc(game.id)+'">Restore game</button></li>').join('')+'</ul>':'<p class="mq-muted">No deleted games.</p>')+'</details>';
}
function teachingDialog(id){
  const game=data.games.find(g=>g.id===id);if(!game)return;
  const own=game.offers.find(o=>o.userId===data.user.id);
  let dialog=document.getElementById('ct-teach-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='ct-teach-dialog';dialog.setAttribute('aria-labelledby','ct-teach-title');document.body.append(dialog);}
  dialog.innerHTML='<h2 id="ct-teach-title">Teach '+esc(game.title)+'</h2><form data-ct-form="teach" data-game-id="'+esc(id)+'"><p>Choose the player counts you are happy to teach, including yourself.</p><fieldset class="ct-counts"><legend>Player counts</legend>'+Array.from({length:11},(_,i)=>i+2).map(n=>'<label><input type="checkbox" name="counts" value="'+n+'"'+(own?.counts?.includes(n)?' checked':'')+'><span>'+n+'</span></label>').join('')+'</fieldset><p class="ct-dialog-error" role="alert" hidden></p><div class="ct-dialog-actions"><button type="submit">Save teaching offer</button><button type="button" data-ct-close>Cancel</button></div>'+(own?.teach?'<button type="button" class="ct-stop" data-ct-stop="'+esc(id)+'">Stop offering to teach</button>':'')+'</form>';
  dialog.showModal();
  const linkedId=game.bggId;
  if(linkedId) getDetails(linkedId).then(result=>{if(dialog.open&&dialog.querySelector('form')?.dataset.gameId===id)applyCountHints(dialog.querySelector('form'),result.game);}).catch(()=>{});
}
async function run(work,done){
  if(busy)return;busy=true;
  try{await work();if(done)done();}catch(e){const target=document.querySelector('#ct-teach-dialog[open] .ct-dialog-error');if(target){target.hidden=false;target.textContent=e.message;}else error(e.message);}
  finally{busy=false;}
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;const d=button.dataset;
  if(d.ctSignIn!==undefined){history.replaceState(null,'',location.pathname+location.search);location.reload();return;}
  if(d.ctTeach){teachingDialog(d.ctTeach);return;}
  if(d.ctClose!==undefined){button.closest('dialog').close();return;}
  if(d.ctStop){run(()=>api('/api/community/teach',{gameId:d.ctStop,teach:false}),()=>reloadAt('games','Teaching offer removed.'));return;}
  if(d.ctDelete){
    const game=data?.games?.find(g=>g.id===d.ctDelete);if(!game||data.user.role!=='admin')return;
    if(confirm('Delete '+game.title+' from Available games? Past play history is kept. Upcoming table recommendations will be reset, and any reservation for this game removed. You can restore it under Organise → Deleted games.'))run(()=>api('/api/admin/community/delete-game',{gameId:game.id}),()=>reloadAt('games','Game deleted. Past play history is unchanged.'));return;
  }
  if(d.ctRestore){run(()=>api('/api/admin/community/restore-game',{gameId:d.ctRestore}),()=>reloadAt('organise','Game restored.'));return;}
  if(d.ctAdmin){
    if(d.ctAdmin==='copy'){navigator.clipboard.writeText(admin.joinLink.url).then(()=>announce('Group invitation copied. Share it with your group.')).catch(()=>{const field=document.getElementById('ct-join-link');field.focus();field.select();announce('Select and copy the group invitation.');});return;}
    if(d.ctAdmin==='retry'){admin=null;loadingAdmin=false;decorate();return;}
    if(['replace','disable'].includes(d.ctAdmin)&&!confirm(d.ctAdmin==='replace'?'Replace the group invitation? The old link will no longer allow new members to join. Existing members are unaffected.':'Disable the group invitation? Existing members are unaffected.'))return;
    run(async()=>{admin=await api('/api/admin/community/join-link',{action:d.ctAdmin});renderAdmin();announce('Group invitation updated.');});
  }
});
document.addEventListener('change',event=>{if(event.target.matches('[data-ct-password]')){const input=document.querySelector('#register-form input[name="password"]');if(input)input.type=event.target.checked?'text':'password';}});
document.addEventListener('submit',event=>{
  const form=event.target;if(!form.matches('[data-ct-form="teach"]'))return;
  event.preventDefault();event.stopPropagation();const counts=new FormData(form).getAll('counts').map(Number);
  if(!counts.length){const alert=form.querySelector('.ct-dialog-error');alert.hidden=false;alert.textContent='Select at least one player count.';return;}
  run(()=>api('/api/community/teach',{gameId:form.dataset.gameId,teach:true,counts}),()=>reloadAt('games','Teaching offer saved. Your existing copy details are unchanged.'));
},true);

// Direct item metadata: independent of search and never imports a collection.
const detailsCache=new Map();
const detailsInFlight=new Map();
const formRequests=new WeakMap();
const automaticTitles=new WeakMap();
let lookupTimer;
function linkedId(value){
  if(typeof value!=='string'||value.length>2048)return null;
  const source=value.trim();if(!/^https?:\/\//i.test(source)||/[\u0000-\u0020\u007f\\]/u.test(source))return null;
  try{const u=new URL(source);if(!['http:','https:'].includes(u.protocol)||!['boardgamegeek.com','www.boardgamegeek.com'].includes(u.hostname)||u.username||u.password||u.port)return null;
    const match=/^\/boardgame\/([1-9]\d*)(?:\/[^\s]*)?$/.exec(u.pathname);const id=Number(match?.[1]);return Number.isSafeInteger(id)&&id>0?id:null;
  }catch{return null;}
}
function safeCover(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='cf.geekdo-images.com'&&!u.username&&!u.password&&!u.port&&!u.hash?u.href:null;}catch{return null;}}
async function getDetails(id){
  if(detailsCache.has(id))return detailsCache.get(id);
  if(detailsInFlight.has(id))return detailsInFlight.get(id);
  const work=api('/api/community/game-details?id='+id).then(result=>{if(result.game?.bggId===id&&result.game.title)detailsCache.set(id,result);return result;}).finally(()=>detailsInFlight.delete(id));
  detailsInFlight.set(id,work);return work;
}
function applyCountHints(form,game){
  if(!form)return;
  const minimum=game?.minPlayers,maximum=game?.maxPlayers;
  const known=Number.isInteger(minimum)&&Number.isInteger(maximum)&&minimum>0&&maximum>=minimum;
  for(const button of form.querySelectorAll('[data-count]')){
    const count=Number(button.dataset.count);const outside=known&&(count<minimum||count>maximum);
    button.classList.toggle('ct-outside',!!outside);
    if(outside)button.title='Outside BGG’s listed range. You can still choose this for house rules or expansions.';else button.removeAttribute('title');
  }
  for(const input of form.querySelectorAll('.ct-counts input[name="counts"]')){
    const count=Number(input.value);const outside=known&&(count<minimum||count>maximum);
    input.closest('label').classList.toggle('ct-outside',!!outside);
    if(outside)input.closest('label').title='Outside BGG’s listed range; still selectable.';else input.closest('label').removeAttribute('title');
  }
  let note=form.querySelector('.ct-count-guidance');
  if(!known){note?.remove();return;}
  if(!note){note=document.createElement('p');note.className='ct-count-guidance mq-muted';form.querySelector('.count-options, .ct-counts')?.after(note);}
  const range=minimum===maximum?String(minimum):minimum+'–'+maximum;
  const message='BGG lists '+range+' players. Muted counts are outside that range but can still be selected for house rules or expansions.';
  if(note.textContent!==message)note.textContent=message;
}
function lookupStatus(form,message){
  let status=form.querySelector('.ct-link-status');
  if(!status){status=document.createElement('p');status.className='ct-link-status mq-muted';status.setAttribute('role','status');form.querySelector('[name="bggUrl"]')?.closest('label')?.after(status);}
  if(status.textContent!==message)status.textContent=message;
}
function showLinkedCover(form,game){
  let preview=form.querySelector('.ct-link-preview');
  const image=safeCover(game?.thumbnail);
  if(!image){preview?.remove();return;}
  if(!preview){preview=document.createElement('a');preview.className='ct-link-preview';preview.target='_blank';preview.rel='noopener noreferrer';form.querySelector('.ct-link-status')?.after(preview);}
  preview.href='https://boardgamegeek.com/boardgame/'+game.bggId;
  preview.setAttribute('aria-label','View '+game.title+' on BGG');
  if(preview.dataset.url===image)return;
  preview.dataset.url=image;preview.replaceChildren();
  const img=document.createElement('img');img.alt='Cover of '+game.title;img.src=image;img.decoding='async';img.referrerPolicy='no-referrer';img.width=72;img.height=88;
  img.addEventListener('error',()=>{preview.hidden=true;},{once:true});preview.hidden=false;preview.append(img);
}
function watchFormDetails(){
  const form=document.getElementById('game-form');if(!form)return;
  const link=form.querySelector('[name="bggUrl"]');if(!link)return;
  const id=linkedId(link.value);const previous=formRequests.get(form);
  if(previous?.id===id)return;
  const ticket={id};formRequests.set(form,ticket);clearTimeout(lookupTimer);
  applyCountHints(form,null);form.querySelector('.ct-link-preview')?.remove();
  if(!id){lookupStatus(form,link.value.trim()?'Paste a BoardGameGeek game-page link to look up its title and player range.':'Paste a BGG link to fill the title and show its player range.');return;}
  lookupStatus(form,'Looking up the linked game…');
  lookupTimer=setTimeout(async()=>{
    try{
      let result=await getDetails(id);
      if(!result.game&&result.retryAfter>0&&result.retryAfter<=2){await new Promise(resolve=>setTimeout(resolve,result.retryAfter*1000));if(formRequests.get(form)!==ticket||!form.isConnected)return;result=await getDetails(id);}
      if(!form.isConnected||formRequests.get(form)!==ticket||linkedId(link.value)!==id)return;
      const game=result.game;
      if(!game){lookupStatus(form,result.message||'BGG lookup is unavailable. Enter the title manually; the link will still be saved.');return;}
      const title=form.querySelector('[name="title"]');
      if(title&&!title.readOnly&&(!title.value.trim()||title.value===automaticTitles.get(form))){
        title.value=game.title.slice(0,120);automaticTitles.set(form,title.value);title.dispatchEvent(new Event('input',{bubbles:true}));
      }
      lookupStatus(form,result.stale?'Using saved BGG details. You can edit the title and choose any player count.':'BGG details loaded. You can edit the title and choose any player count.');
      applyCountHints(form,game);showLinkedCover(form,game);
    }catch(e){if(form.isConnected&&formRequests.get(form)===ticket)lookupStatus(form,e.message+' You can still enter the game manually.');}
  },350);
}
document.addEventListener('input',event=>{if(event.target.matches('#game-form [name="bggUrl"]'))watchFormDetails();});
if(main)new MutationObserver(schedule).observe(main,{childList:true,subtree:true});
// Usually the base app supplies the first bootstrap. This also covers an already-loaded page.
originalFetch('/api/bootstrap',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>{if(value){data=value;schedule();}}).catch(()=>{});
