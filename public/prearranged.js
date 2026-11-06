// Secondary, collapsed route for games already agreed outside the planner.
const main = document.getElementById('main');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function request(path, body) {
  const response = await fetch(path,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body ? {'Content-Type':'application/json'} : {})},...(body ? {method:'POST',body:JSON.stringify(body)} : {})});
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The table could not be loaded.'); return data;
}
function attach() {
  if (!main?.querySelector('.mq-overview') || main.querySelector('#prearranged-option')) return;
  const details = document.createElement('details');
  details.id = 'prearranged-option'; details.className = 'vhbc-prearranged';
  details.innerHTML = '<summary>Already arranged a game?</summary><div class="vhbc-reservation-content"><p class="mq-muted">Usually, just rate games and mark yourself as coming. Use this only for a table everyone has already agreed to.</p><div class="vhbc-reservation-panel"></div></div>';
  // Keep attendance and preference review above this secondary action.
  const overview = main.querySelector('.mq-overview');
  (overview.nextElementSibling || overview).after(details);
  const panel = details.querySelector('.vhbc-reservation-panel');
  let data = null; let gameId = ''; let selected = new Set(); let loading = false; let saving = false;
  const game = () => data.games.find(g => g.id === gameId);
  const free = () => data.members.filter(m => !data.fixedTables.some(t => t.memberIds.includes(m.id)));
  const options = offers => offers.map(o => '<option value="'+esc(o.userId)+'">'+esc(o.name || data.members.find(m => m.id === o.userId)?.name || 'Member')+'</option>').join('');
  function paint() {
    const confirmed = data.meeting.status !== 'open';
    const available = free();
    const selfFree = available.some(m => m.id === data.user.id);
    const current = game();
    const existing = data.fixedTables.length ? '<div class="vhbc-reserved"><p class="mq-muted">Already reserved</p>'+data.fixedTables.map(t => '<p><strong>'+esc(data.games.find(g => g.id === t.gameId)?.title || 'Game')+'</strong> — '+t.memberIds.map(id => esc(data.members.find(m => m.id === id)?.name || 'Member')).join(', ')+'</p>').join('')+'</div>' : '';
    if (confirmed) { panel.innerHTML = existing+'<p>The tables are already confirmed or recorded. Ask the organiser about changes.</p>'; return; }
    if (data.user.role !== 'admin' && !selfFree) { panel.innerHTML = existing+'<p class="mq-muted">'+(data.members.some(m => m.id === data.user.id) ? 'You already have a pre-arranged table. Ask the organiser to change it.' : 'Mark yourself as coming above before reserving a table.')+'</p>'; return; }
    const offers = current?.offers || [];
    const teachers = offers.filter(o => o.teach && selected.has(o.userId) && o.counts.includes(selected.size));
    const owners = offers.filter(o => o.own && data.members.some(m => m.id === o.userId) && !data.fixedTables.some(t => t.gameId === current.id && t.copyOwnerId === o.userId));
    const canSubmit = current && selected.size >= 2 && teachers.length && owners.length;
    panel.innerHTML = existing+'<form class="vhbc-reservation-form form-stack"><label>Game<select name="gameId" required><option value="">Choose an available game</option>'+data.games.map(g => '<option value="'+esc(g.id)+'"'+(g.id === gameId?' selected':'')+'>'+esc(g.title)+'</option>').join('')+'</select></label>'+(current ? '<fieldset><legend>Agreed players</legend><p class="mq-muted">Only people marked as coming are shown. Everyone must have marked this game Want or Will play.</p><div class="member-options">'+available.map(m => '<label class="mq-checkbox"><input type="checkbox" name="memberIds" value="'+esc(m.id)+'"'+(selected.has(m.id)?' checked':'')+(data.user.role !== 'admin' && m.id === data.user.id?' disabled':'')+'>'+esc(m.name)+(m.id === data.user.id?' (you)':'')+'</label>').join('')+'</div></fieldset><div class="form-columns"><label>Teacher<select name="teacherId" required><option value="">Choose a teacher</option>'+options(teachers)+'</select></label><label>Copy supplied by<select name="copyOwnerId" required><option value="">Choose a copy</option>'+options(owners)+'</select></label></div><p class="mq-muted">'+(selected.size < 2?'Select at least two agreed players.':!teachers.length?'No selected player has offered to teach at this player count. Update the teaching offer in Available games first.':!owners.length?'No unreserved copy is offered by an attending member. Update the copy details in Available games first.':'Your chosen player counts still apply. The organiser will confirm the full meeting plan.')+'</p><label class="mq-checkbox"><input type="checkbox" name="agreed" required>I have checked that everyone listed has agreed to this table.</label><button type="submit"'+(!canSubmit?' disabled':'')+'>Save pre-arranged table</button>':'')+'<p class="vhbc-reservation-message" role="status" aria-live="polite"></p></form>';
    if (teachers.length === 1) panel.querySelector('[name="teacherId"]').value = teachers[0].userId;
    if (owners.length === 1) panel.querySelector('[name="copyOwnerId"]').value = owners[0].userId;
  }
  details.addEventListener('toggle', async () => {
    if (!details.open || loading || saving) return;
    loading = true;
    panel.innerHTML = '<p class="mq-muted" role="status">Loading meeting details…</p>';
    try {
      data = await request('/api/prearranged/options');
      if (!details.isConnected) return;
      selected = new Set(free().some(m => m.id === data.user.id)?[data.user.id]:[]); gameId = ''; paint();
    } catch(error) { if(details.isConnected)panel.innerHTML = '<p role="alert">'+esc(error.message)+'</p><p class="mq-muted">Close and reopen this option to try again.</p>'; }
    finally { loading = false; }
  });
  panel.addEventListener('change', event => {
    const el = event.target;
    if (saving || !data) return;
    if (el.name === 'gameId') { gameId = el.value; selected = new Set(free().some(m => m.id === data.user.id)?[data.user.id]:[]); paint(); }
    if (el.name === 'memberIds') { if(el.checked)selected.add(el.value);else selected.delete(el.value);paint(); }
  });
  // Capture here so the base app's unrelated form handler cannot process this form.
  panel.addEventListener('submit', async event => {
    if (!event.target.matches('.vhbc-reservation-form')) return;
    event.preventDefault(); event.stopPropagation(); if (saving || !data) return;
    const form = event.target; const fd = new FormData(form); const message = form.querySelector('[role="status"]');
    saving = true; for(const el of form.elements)el.disabled = true; message.textContent = 'Saving table…';
    try {
      await request('/api/prearranged/reserve',{meetingDate:data.meeting.date,revision:data.meeting.revision,gameId,memberIds:[...selected],teacherId:fd.get('teacherId'),copyOwnerId:fd.get('copyOwnerId'),agreed:fd.has('agreed')});
      // Reload the base state as well; a saved reservation invalidates old recommendations.
      try { sessionStorage.setItem('vhbc-reservation-saved','1'); } catch {}
      location.reload();
    } catch(error) {
      if (!details.isConnected) return;
      paint(); const target = panel.querySelector('[role="status"]'); if(target){target.setAttribute('role','alert');target.textContent=error.message;}
    } finally {saving = false;}
  },true);
}
if (main) {
  new MutationObserver(attach).observe(main,{childList:true,subtree:true}); attach();
  try {
    if (sessionStorage.getItem('vhbc-reservation-saved')) {
      sessionStorage.removeItem('vhbc-reservation-saved');
      const status = document.getElementById('status');
      if(status)status.textContent = 'Pre-arranged table saved. The organiser will confirm the meeting’s tables.';
    }
  } catch {}
}
