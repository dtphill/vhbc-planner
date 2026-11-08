/** Small, checked adapters for the existing planner UI. No account logic changes. */
function once(source, before, after) {
  const at=source.indexOf(before);
  if(at<0||source.indexOf(before,at+before.length)>=0)throw new Error('Planner asset changed: review catalogue adapter');
  return source.slice(0,at)+after+source.slice(at+before.length);
}
export function upgradePlannerClient(source) {
  let js=source;
  js=once(js,"async function perform(work, success, after, progress = 'Saving…') {","async function perform(work, success, after, progress = 'Saving…', refresh = true) {");
  js=once(js,"try { await load(); } catch (error)","try { if (refresh || result?.refreshRequired) await load(); window.dispatchEvent(new CustomEvent('vhbc:data-updated', {detail:state.data})); } catch (error)");
  // Fetch the organiser's schedule only when that screen needs it, not on every rating.
  const oldSchedule="state.meetingSchedule = isAdmin() ? await api('/api/admin/meetings') : null;";
  if(js.includes(oldSchedule))js=once(js,oldSchedule,"state.meetingSchedule = isAdmin() ? (state.view === 'organise' ? await api('/api/admin/meetings') : state.meetingSchedule) : null;");
  js=once(js,"function navigate(view) {\n  clearError();","async function navigate(view) {\n  clearError();\n  const navigationVersion=(state.navigationVersion||0)+1; state.navigationVersion=navigationVersion;\n  if (view === 'organise' && isAdmin()) { try { state.meetingSchedule = await api('/api/admin/meetings'); } catch (error) { showError(error); return; } }\n  if(state.navigationVersion!==navigationVersion)return;");
  const start=js.indexOf('async function saveRating('),end=js.indexOf('async function undoPreference()',start);
  if(start<0||end<0)throw new Error('Preference adapter anchor missing');
  js=js.slice(0,start)+`function applyPreferenceStats(result) {
  if (Array.isArray(result.gameStats)) {
    const updated = new Map(result.gameStats.map(g => [String(g.id),g]));
    for (const game of games()) {
      const row = updated.get(String(game.id));
      if (row) game.interestCounts = row.interestCounts;
    }
  }
  if (state.data.meeting?.status !== 'completed') {
    state.data.plan = null; state.data.meeting.status = 'open';
  }
}
async function saveRating(gameId, value, reviewing) {
  const undo = capturePreferenceUndo(gameId);
  await perform(() => post('/api/rating', {gameId, rating:value}), gameName(gameId) + ': ' + ({want:'Want',will:'Will play',pass:'Passed'}[value] || 'Unrated') + '.', result => {
    if (value === null) delete state.data.preferences.ratings[gameId];
    else state.data.preferences.ratings[gameId] = value;
    if (value !== 'want' && same(prefs().priorityGameId,gameId)) state.data.preferences.priorityGameId = null;
    applyPreferenceStats(result); state.undo = undo; if(reviewing)state.review.index++;
  }, 'Saving…', false);
}
async function savePriority(gameId, reviewing) {
  const changedGame = gameId || prefs().priorityGameId;
  const undo = changedGame ? capturePreferenceUndo(changedGame) : null;
  await perform(() => post('/api/priority', {gameId}), gameId ? 'Current priority pick saved.' : 'Priority pick cleared.', result => {
    state.data.preferences.priorityGameId = gameId;
    if(gameId)state.data.preferences.ratings[gameId] = 'want';
    applyPreferenceStats(result); state.undo = undo; if(reviewing)state.review.index++;
  }, 'Saving…', false);
}
`+js.slice(end);
  js=once(js,'try { await load(); render(); }',`window.addEventListener('vhbc:refresh', async event => {
  if(state.busy)return;
  const view=event.detail?.view;
  if(['games','meeting','organise'].includes(view))state.view=view;
  state.undo=null; state.priorMeeting=null; state.priorConfirmed=false; state.completionConfirmed=false;
  await perform(async()=>{}, event.detail?.message || 'Updated.', null, 'Refreshing…');
});
try { await load(); render(); }`);
  return js;
}
export function upgradeCommunityClient(source) {
  let js=source;
  const start=js.indexOf('function reloadAt(view,message){'), end=js.indexOf('\nfunction decorate()',start);
  if(start<0||end<0)throw new Error('Community refresh adapter anchor missing');
  js=js.slice(0,start)+"function reloadAt(view,message){ document.getElementById('ct-teach-dialog')?.close(); admin=null; window.dispatchEvent(new CustomEvent('vhbc:refresh',{detail:{view,message}})); }\n"+js.slice(end);
  const duplicate=js.indexOf('// Usually the base app supplies the first bootstrap.');
  if(duplicate<0)throw new Error('Bootstrap adapter anchor missing');
  js=js.slice(0,duplicate)+"// The base app supplies the initial bootstrap through the interceptor above.\n";
  return js;
}
