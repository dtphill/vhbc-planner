const root = document.getElementById('vhbc-monthly-planner');
const main = document.getElementById('main');
const nav = document.getElementById('navigation');
const notice = document.getElementById('notice');
const statusLine = document.getElementById('status');
const undoButton = document.getElementById('undo-button');

const fragment = new URLSearchParams(location.hash.slice(1));
let inviteToken = fragment.get('invite');
let resetToken = fragment.get('reset');
if (inviteToken || resetToken) history.replaceState(null, '', location.pathname + location.search);
fragment.delete('invite');
fragment.delete('reset');

const state = {
  data: null, meetingSchedule: null, view: 'meeting', busy: false, filter: 'all', query: '',
  review: { active: false, ids: [], index: 0 }, undo: null,
  searchQuery: '', searchResults: [], searchMessage: '', searching: false, searchVersion: 0,
  selectedGame: null, editingGameId: null, gameDraft: emptyGameDraft(),
  fixedGameId: '', fixedMembers: [], privateLink: null, completionConfirmed: false, priorMeeting: null, priorConfirmed: false,
};
let searchTimer;

function emptyGameDraft() { return { title: '', bggUrl: '', own: false, teach: false, counts: [], pitch: '' }; }
function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function same(a, b) { return String(a ?? '') === String(b ?? ''); }
function games() { return state.data?.games || []; }
function members() { return state.data?.members || []; }
function gameById(id) { return games().find(g => same(g.id, id)); }
function memberById(id) { return members().find(m => same(m.id, id)) || (same(state.data?.user?.id, id) ? state.data.user : null); }
function gameName(id) { return gameById(id)?.title || 'Game no longer available'; }
function memberName(id) { return memberById(id)?.name || 'Member no longer available'; }
function prefs() { return state.data?.preferences || { ratings: {}, priorityGameId: null }; }
function rating(id) { return prefs().ratings?.[id] || null; }
function isAdmin() { return state.data?.user?.role === 'admin'; }
function unratedIds() { return games().filter(g => !rating(g.id)).map(g => g.id); }
function currentFixedTables() { return (state.data?.fixedTables || (state.data?.plan?.tables || []).filter(t => t.fixed)).map(t => ({ gameId: t.gameId, memberIds: t.memberIds || [], teacherId: t.teacherId, copyOwnerId: t.copyOwnerId })); }
function safeBGG(game) {
  if (Number.isSafeInteger(Number(game?.bggId)) && Number(game.bggId) > 0) return 'https://boardgamegeek.com/boardgame/' + Number(game.bggId);
  try { const u = new URL(game?.bggUrl); if (u.protocol === 'https:' && ['boardgamegeek.com', 'www.boardgamegeek.com'].includes(u.hostname)) return u.href; } catch {}
  return null;
}
function bggLink(game) { const href = safeBGG(game); return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">View on BGG</a>' : ''; }
function dateLabel(date) {
  if (!date) return 'Next meeting';
  const d = new Date(String(date).slice(0, 10) + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? String(date) : new Intl.DateTimeFormat('en-AU', { dateStyle: 'full', timeZone: 'Australia/Melbourne' }).format(d);
}
function meetingLabel() { return state.data?.meeting?.label || dateLabel(state.data?.meeting?.date); }
function announce(text) { statusLine.textContent = text || ''; }
function showError(error) { notice.textContent = error?.message || String(error || 'Something went wrong. Please try again.'); notice.hidden = false; }
function clearError() { notice.hidden = true; notice.textContent = ''; }
function information(title, text) {
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-text').textContent = text;
  document.getElementById('information-dialog').showModal();
}

async function api(path, options = {}) {
  const request = { credentials: 'same-origin', cache: 'no-store', ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } };
  if (state.data?.meeting?.date && options.method && !options.body?.meetingDate && /^\/api\/(?:attendance|admin\/(?:plan|fixed|lock|complete))$/.test(path)) request.headers['X-VHBC-Meeting'] = state.data.meeting.date;
  if (options.body !== undefined && typeof options.body !== 'string') { request.headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(options.body); }
  let response;
  try { response = await fetch(path, request); } catch { throw new Error('The connection failed. Your change has not been confirmed. Please try again.'); }
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error('The server returned an unexpected response. Please try again.'); }
  if (!response.ok) {
    const message = typeof result.error === 'string' ? result.error : result.error?.message || result.message;
    throw new Error(message || (response.status === 401 ? 'Please sign in again.' : 'This change could not be saved. Please try again.'));
  }
  return result;
}
async function load() {
  state.data = await api('/api/bootstrap');
  state.meetingSchedule = isAdmin() ? await api('/api/admin/meetings') : null;
  return state.data;
}
async function perform(work, success, after, progress = 'Saving…') {
  if (state.busy) return false;
  state.busy = true;
  main.setAttribute('aria-busy', 'true');
  root.classList.add('is-busy');
  clearError();
  announce(progress);
  try {
    const result = await work();
    if (after) await after(result);
    try { await load(); } catch (error) { showError(new Error('The change was saved, but the page could not refresh. Reload the page to see the latest information.')); }
    announce(typeof success === 'function' ? success(result) : success || 'Saved.');
    render();
    return true;
  } catch (error) {
    showError(error);
    announce('');
    return false;
  } finally {
    state.busy = false;
    main.setAttribute('aria-busy', 'false');
    root.classList.remove('is-busy');
  }
}
function post(path, body) { return api(path, { method: 'POST', body }); }
function put(path, body) { return api(path, { method: 'PUT', body }); }

function renderChrome() {
  const user = state.data?.user;
  document.getElementById('identity').innerHTML = user ? '<span>' + esc(user.name) + '</span><button type="button" data-action="sign-out" class="header-action">Sign out</button>' : '';
  nav.hidden = !user || Boolean(inviteToken || resetToken);
  if (!nav.hidden) {
    const views = [['meeting', 'Next meeting'], ['games', 'Available games'], ['add', 'Add a game'], ['history', 'Past meetings']];
    if (isAdmin()) views.push(['organise', 'Organise']);
    views.push(['account', 'Account']);
    nav.innerHTML = views.map(([id, label]) => '<button type="button" data-view="' + id + '" aria-pressed="' + (state.view === id) + '">' + label + '</button>').join('');
  }
  undoButton.hidden = !user || !state.undo;
}
function render() {
  renderChrome();
  if (resetToken) { main.innerHTML = resetHTML(); return; }
  if (inviteToken) { main.innerHTML = registrationHTML(); return; }
  if (!state.data?.user) { main.innerHTML = signInHTML(); return; }
  const renderers = { meeting: meetingHTML, games: gamesHTML, add: addHTML, history: historyHTML, organise: organiseHTML, account: accountHTML };
  if (state.view === 'organise' && !isAdmin()) state.view = 'meeting';
  main.innerHTML = (renderers[state.view] || meetingHTML)();
}
function signInHTML() {
  return '<div class="auth-layout"><section><h2>Sign in</h2><form id="sign-in-form" class="form-stack"><label>Email address<input type="email" name="email" autocomplete="username" required maxlength="254"></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button class="mq-primary" type="submit">Sign in</button></form><button class="mq-small-action" type="button" data-action="forgot-password">Forgot password?</button><p class="mq-muted">New members join using an invitation from the organiser.</p></section><section class="meeting-note"><h2>Next meeting</h2><p class="mq-meeting-date">' + esc(meetingLabel()) + '</p><p>Normally the fourth Sunday of the month, from 10 am.</p></section></div>';
}
function registrationHTML() {
  if (state.data?.user) return '<section class="auth-panel"><h2>Join the group</h2><p>You are signed in as ' + esc(state.data.user.name) + '. Sign out to register with this invitation.</p><button type="button" data-action="sign-out" class="mq-primary">Sign out</button></section>';
  return '<section class="auth-panel"><h2>Join the group</h2><form id="register-form" class="form-stack"><label>Your name<input name="name" autocomplete="name" required maxlength="60"></label><label>Email address<input type="email" name="email" autocomplete="username" required maxlength="254"></label><label>Password<input type="password" name="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="password-guidance"></label><p id="password-guidance" class="mq-muted">Use at least 12 characters.</p><button type="submit" class="mq-primary">Create my account</button></form></section>';
}
function resetHTML() {
  return '<section class="auth-panel"><h2>Set a new password</h2><form id="reset-form" class="form-stack"><label>New password<input type="password" name="newPassword" autocomplete="new-password" minlength="12" maxlength="128" required aria-describedby="reset-guidance"></label><p id="reset-guidance" class="mq-muted">Use at least 12 characters.</p><button type="submit" class="mq-primary">Save new password</button></form></section>';
}

function meetingHTML() {
  const coming = Boolean(state.data.attendance?.coming);
  const wantCount = Object.values(prefs().ratings || {}).filter(v => v === 'want').length;
  const willCount = Object.values(prefs().ratings || {}).filter(v => v === 'will').length;
  const attendees = members().filter(m => m.coming);
  const priority = gameById(prefs().priorityGameId);
  return '<div class="mq-overview"><section><h2>Next meeting</h2><p class="mq-meeting-date">' + esc(meetingLabel()) + '</p><p>From 10 am.</p>' + (coming ? '<div class="mq-inline"><strong>You’re coming</strong><button type="button" class="mq-small-action" data-action="attendance" data-coming="false">I can no longer attend</button></div>' : '<button type="button" class="mq-primary" data-action="attendance" data-coming="true">I’m coming</button>') + '</section><section><h2>My preferences</h2><p>' + wantCount + ' Want · ' + willCount + ' Will play</p><div class="mq-wish"><span class="mq-muted">My current priority pick</span><br>' + (priority ? esc(priority.title) : 'None selected') + '</div><div class="mq-inline"><button type="button" class="mq-small-action" data-view="games">Edit preferences</button>' + (priority ? '<button type="button" class="mq-small-action" data-action="clear-priority">Clear priority pick</button>' : '') + '</div></section></div>' + reviewHTML() + '<section class="mq-section spaced-section"><h2>Attending</h2>' + (attendees.length ? '<ul class="name-list">' + attendees.map(m => '<li>' + esc(m.name) + '</li>').join('') + '</ul>' : '<p class="mq-muted">No attendance recorded yet.</p>') + '</section><section class="mq-section spaced-section">' + planHTML(false) + '</section>';
}
function beginReview() { state.review = { active: true, ids: unratedIds(), index: 0 }; }
function reviewHTML() {
  const pending = unratedIds();
  if (!state.review.active) return '<section class="mq-section"><div class="heading-row"><h2>New games to consider</h2>' + (pending.length ? '<span class="mq-muted">' + pending.length + ' unrated</span>' : '') + '</div>' + (pending.length ? '<button type="button" data-action="review">Quick review</button>' : '<p class="mq-muted">No new games.</p>') + '</section>';
  while (state.review.index < state.review.ids.length && !gameById(state.review.ids[state.review.index])) state.review.index++;
  const id = state.review.ids[state.review.index];
  if (id === undefined) return '<section class="mq-section"><h2>Review finished</h2><p>' + (pending.length ? pending.length + ' game' + (pending.length === 1 ? ' remains' : 's remain') + ' unrated.' : 'All available games have a preference.') + '</p><div class="mq-inline">' + (pending.length ? '<button type="button" data-action="review">Review remaining</button>' : '') + '<button type="button" class="mq-small-action" data-action="review-later">Close review</button></div></section>';
  const game = gameById(id);
  return '<section class="mq-section"><div class="heading-row"><h2>New games to consider</h2><span class="mq-muted">' + (state.review.index + 1) + ' of ' + state.review.ids.length + '</span></div><div class="mq-review"><div class="mq-review-title"><h3 class="mq-game-title">' + esc(game.title) + '</h3>' + bggLink(game) + '</div><div>' + offersHTML(game, true) + preferenceHTML(game, true) + '<div class="mq-inline"><button type="button" class="mq-small-action" data-action="skip-review">Not sure yet</button><button type="button" class="mq-small-action" data-action="review-later">Review later</button></div></div></div></section>';
}
function preferenceHTML(game, reviewing = false) {
  const id = esc(game.id);
  const current = rating(game.id);
  return '<div class="mq-choice" role="group" aria-label="Preference for ' + esc(game.title) + '">' + [['want', 'Want'], ['will', 'Will play'], ['pass', 'Pass']].map(([value, label]) => '<button type="button" data-rate="' + value + '" data-game="' + id + '"' + (reviewing ? ' data-review="true"' : '') + ' aria-pressed="' + (current === value) + '">' + label + '</button>').join('') + '</div><button type="button" class="mq-small-action mq-top" data-priority="' + id + '"' + (reviewing ? ' data-review="true"' : '') + ' aria-pressed="' + same(prefs().priorityGameId, game.id) + '">' + (same(prefs().priorityGameId, game.id) ? 'My current priority pick' : 'Make my current priority pick') + '</button>';
}
function offersHTML(game, expanded = false) {
  const offers = game.offers || [];
  if (!offers.length) return '<p class="mq-muted">No copy or teaching offers recorded.</p>';
  const content = '<ul class="offer-list">' + offers.map(offer => '<li><span class="offer-person">' + esc(offer.name || memberName(offer.userId)) + '</span><span class="mq-muted">' + esc([offer.own ? 'Has a copy' : '', offer.teach ? 'Can teach' : ''].filter(Boolean).join(' · ') || 'Interest recorded') + '</span>' + (offer.counts?.length ? '<span class="mq-muted">Player counts: ' + esc(offer.counts.join(', ')) + '</span>' : '') + (offer.pitch ? '<p class="mq-note">' + esc(offer.pitch) + '</p>' : '') + '</li>').join('') + '</ul>';
  return expanded ? content : '<details class="offers"><summary>Owners and teachers</summary>' + content + '</details>';
}
function filteredGames() {
  const q = state.query.trim().toLocaleLowerCase();
  return games().filter(g => (!q || g.title.toLocaleLowerCase().includes(q)) && (state.filter === 'all' || (state.filter === 'new' ? !rating(g.id) : rating(g.id) === state.filter)));
}
function gameCardsHTML() {
  const list = filteredGames();
  if (!list.length) return '<p class="empty-state">' + (games().length ? 'No games match this view.' : 'No games have been added yet.') + '</p>';
  return '<div class="mq-shelf">' + list.map(g => '<article class="mq-game" id="game-' + esc(g.id) + '"><div class="mq-badge">' + (same(prefs().priorityGameId, g.id) ? 'My current priority pick' : { want: 'Want to play', will: 'Will play', pass: 'Passed' }[rating(g.id)] || 'Unrated') + '</div><h3>' + esc(g.title) + '</h3><div class="mq-muted">' + bggLink(g) + '</div>' + offersHTML(g) + preferenceHTML(g) + '<button type="button" class="mq-small-action offer-edit" data-offer="' + esc(g.id) + '">My copy and teaching details</button></article>').join('') + '</div>';
}
function gamesHTML() {
  return '<div class="heading-row"><h2>Available games</h2><button type="button" data-view="add">Add a game</button></div><label class="search-label" for="catalogue-search">Find a game<input id="catalogue-search" type="search" value="' + esc(state.query) + '" placeholder="Game title" autocomplete="off"></label><div class="mq-tools filter-tools" role="group" aria-label="Filter games">' + [['all', 'All games'], ['new', 'Unrated'], ['want', 'Want'], ['will', 'Will play'], ['pass', 'Passed']].map(([id, label]) => '<button type="button" data-filter="' + id + '" aria-pressed="' + (state.filter === id) + '">' + label + '</button>').join('') + '</div><div id="game-list">' + gameCardsHTML() + '</div>';
}

function countsHTML(selected, group = 'game') {
  return '<div class="count-options" role="group" aria-label="Player counts I will play">' + Array.from({ length: 11 }, (_, i) => i + 2).map(n => '<button type="button" data-count="' + n + '" data-count-group="' + group + '" aria-pressed="' + selected.includes(n) + '" aria-label="' + n + ' players">' + n + '</button>').join('') + '</div>';
}
function searchResultsHTML() {
  if (state.searching) return '<p class="mq-muted" role="status">Searching…</p>';
  const results = state.searchResults;
  return (state.searchMessage ? '<p class="mq-muted" role="status">' + esc(state.searchMessage) + '</p>' : '') + results.map((g, index) => '<button type="button" class="mq-result" data-search-result="' + index + '"><span><span class="mq-result-title">' + esc(g.title) + '</span>' + (g.year ? '<span class="mq-muted">' + esc(g.year) + '</span>' : '') + '</span><span class="mq-muted">' + (g.existingGameId ? 'Already available' : 'Select game') + '</span></button>').join('');
}
function addHTML() {
  const d = state.gameDraft;
  const editing = Boolean(state.editingGameId);
  const attribution = '<p class="bgg-attribution">' + (state.data.config?.bggSearch ? 'External search data provided by ' : 'Game reference: ') + '<a href="https://boardgamegeek.com/" target="_blank" rel="noopener noreferrer">BoardGameGeek</a>.</p>';
  const lookup = editing ? '' : '<section class="search-section"><label class="mq-search-field" for="add-search">Search by title<input id="add-search" class="mq-input" type="search" maxlength="100" placeholder="Enter a game title" autocomplete="off" value="' + esc(state.searchQuery) + '"></label>' + (!state.data.config?.bggSearch ? '<p class="mq-muted">Search covers the group’s existing games. You can add another game using the form below.</p>' : '') + '<div class="mq-results" id="search-results">' + searchResultsHTML() + '</div>' + attribution + '</section>';
  return '<div class="heading-row"><h2>' + (editing ? 'My game details' : 'Add a game') + '</h2>' + (editing ? '<button type="button" class="mq-small-action" data-view="games">Available games</button>' : '') + '</div>' + lookup + '<form id="game-form" class="game-form form-stack' + (!editing ? ' mq-selected' : '') + '"><label>Game title<input name="title" value="' + esc(d.title) + '" required maxlength="120"' + (editing ? ' readonly' : '') + '></label><label>BGG link <span class="mq-muted">Optional</span><input name="bggUrl" type="url" value="' + esc(d.bggUrl) + '" placeholder="https://boardgamegeek.com/boardgame/…"' + (editing ? ' readonly' : '') + '></label>' + (state.selectedGame ? '<p class="mq-muted">Link filled from your selected game.</p>' : '') + '<div class="mq-inline"><label class="mq-checkbox"><input type="checkbox" name="own"' + (d.own ? ' checked' : '') + '>I own a copy</label><label class="mq-checkbox"><input type="checkbox" name="teach"' + (d.teach ? ' checked' : '') + '>I can teach it</label></div><fieldset class="count-fieldset"><legend>Player counts I will play</legend><p class="mq-muted">Total including you. Only selected counts are eligible.</p>' + countsHTML(d.counts) + '</fieldset><label>A short pitch <span class="mq-muted">Optional</span><textarea name="pitch" rows="3" maxlength="500" placeholder="What would you like the group to know?">' + esc(d.pitch) + '</textarea></label><div class="mq-inline"><button type="submit" class="mq-primary">' + (editing ? 'Save my details' : 'Add game') + '</button><button type="button" class="mq-small-action" data-action="cancel-game">Cancel</button></div></form>';
}
function startAdd() {
  state.selectedGame = null; state.editingGameId = null; state.gameDraft = emptyGameDraft(); state.searchQuery = ''; state.searchResults = []; state.searchMessage = ''; state.view = 'add';
}
function editOffer(game) {
  const offer = (game.offers || []).find(o => same(o.userId, state.data.user.id));
  state.editingGameId = game.id; state.selectedGame = null;
  state.gameDraft = { title: game.title, bggUrl: safeBGG(game) || '', own: Boolean(offer?.own), teach: Boolean(offer?.teach), counts: [...(offer?.counts || [])], pitch: offer?.pitch || '' };
  state.view = 'add';
}
function chooseSearchResult(index) {
  const selected = state.searchResults[index];
  if (!selected) return;
  const existing = gameById(selected.existingGameId) || games().find(g => selected.bggId && same(g.bggId, selected.bggId));
  if (existing) { editOffer(existing); announce('This game is already available. Add or update your own details.'); }
  else { state.selectedGame = selected; state.editingGameId = null; state.gameDraft = { ...emptyGameDraft(), title: selected.title, bggUrl: selected.bggId ? 'https://boardgamegeek.com/boardgame/' + selected.bggId : '' }; }
  render();
  main.querySelector('#game-form')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
}
async function runSearch(query) {
  const version = ++state.searchVersion;
  if (query.trim().length < 2) { state.searchResults = []; state.searchMessage = ''; state.searching = false; renderSearchResults(); return; }
  state.searching = true; state.searchMessage = ''; renderSearchResults();
  try {
    const response = await api('/api/search?q=' + encodeURIComponent(query.trim()));
    if (version !== state.searchVersion) return;
    state.searchResults = response.results || [];
    state.searchMessage = response.message || (state.searchResults.length ? '' : 'No matching games. You can enter the details below.');
  } catch (error) { if (version === state.searchVersion) { state.searchResults = []; state.searchMessage = error.message; } }
  finally { if (version === state.searchVersion) { state.searching = false; renderSearchResults(); } }
}
function renderSearchResults() { const el = document.getElementById('search-results'); if (el) el.innerHTML = searchResultsHTML(); }

function planHTML(organiser = false, plan = state.data.plan, meeting = state.data.meeting) {
  if (!plan?.tables?.length) return '<h2>Tables</h2><p class="mq-muted">Tables have not been arranged yet.</p>';
  const complete = meeting?.status === 'completed';
  let html = '<div class="heading-row"><h2>' + (complete ? 'Games played' : plan.locked ? 'Confirmed tables' : 'Proposed tables') + '</h2>' + (plan.revision ? '<span class="mq-muted">Revision ' + esc(plan.revision) + '</span>' : '') + '</div><div class="table-plans">';
  plan.tables.forEach((table, index) => {
    html += '<article class="table-plan"><div class="mq-badge">Table ' + (index + 1) + (table.fixed ? ' · Pre-arranged' : '') + '</div><h3>' + esc(gameName(table.gameId)) + '</h3><ul class="player-list">' + (table.memberIds || []).map(id => '<li' + (same(id, state.data.user.id) ? ' class="is-you"' : '') + '>' + esc(memberName(id)) + (same(id, state.data.user.id) ? ' <span class="mq-muted">You</span>' : '') + '</li>').join('') + '</ul><p class="mq-muted">' + (table.teacherId ? 'Teaching: ' + esc(memberName(table.teacherId)) + '<br>' : '') + (table.copyOwnerId ? 'Copy: ' + esc(memberName(table.copyOwnerId)) : '') + '</p>' + (table.reason ? '<p class="mq-note">' + esc(table.reason) + '</p>' : '') + '</article>';
  });
  html += '</div>';
  const unassigned = plan.unassignedMemberIds || [];
  if (organiser && unassigned.length) html += '<div class="inline-notice"><h3>Still need a table</h3><p>' + unassigned.map(id => esc(memberName(id))).join(', ') + '</p></div>';
  else if (unassigned.some(id => same(id, state.data.user.id))) html += '<p class="inline-notice">Your table is still being arranged.</p>';
  if (organiser && plan.warnings?.length) html += '<ul class="warnings">' + plan.warnings.map(w => '<li>' + esc(typeof w === 'string' ? w : w.message || 'This arrangement needs review.') + '</li>').join('') + '</ul>';
  return html;
}
function fixedFormHTML() {
  const selected = gameById(state.fixedGameId);
  const fixed = currentFixedTables();
  const reserved = new Set(fixed.flatMap(t => t.memberIds).map(String));
  const candidates = members().filter(m => m.coming && !reserved.has(String(m.id)));
  const offers = selected?.offers || [];
  const teachers = offers.filter(o => o.teach && state.fixedMembers.some(id => same(id, o.userId)));
  const owners = offers.filter(o => o.own);
  const options = list => list.map(o => '<option value="' + esc(o.userId) + '">' + esc(o.name || memberName(o.userId)) + '</option>').join('');
  return '<form id="fixed-form" class="form-stack"><label>Game<select name="gameId" id="fixed-game" required><option value="">Choose a game</option>' + games().map(g => '<option value="' + esc(g.id) + '"' + (same(g.id, state.fixedGameId) ? ' selected' : '') + '>' + esc(g.title) + '</option>').join('') + '</select></label><fieldset><legend>Agreed players</legend><p class="mq-muted">Only include players who agreed to this table. Their saved preferences must allow the game.</p><div class="member-options">' + candidates.map(m => '<label class="mq-checkbox"><input type="checkbox" name="memberIds" value="' + esc(m.id) + '"' + (state.fixedMembers.some(id => same(id, m.id)) ? ' checked' : '') + '>' + esc(m.name) + '</label>').join('') + '</div>' + (!candidates.length ? '<p class="mq-muted">No unassigned confirmed attendees.</p>' : '') + '</fieldset><div class="form-columns"><label>Teacher<select name="teacherId" required><option value="">Choose a teacher</option>' + options(teachers) + '</select></label><label>Game copy<select name="copyOwnerId" required><option value="">Choose a copy owner</option>' + options(owners) + '</select></label></div><p class="mq-muted">Teaching choices come from the selected players who offered to teach this game.</p><button type="submit">Reserve table</button></form>';
}
function privateLinkHTML() {
  const link = state.privateLink;
  return link ? '<section class="private-link"><h3>' + esc(link.title) + '</h3><p>Share this link privately with ' + esc(link.recipient) + '.</p><label>Private link<input id="private-link" value="' + esc(link.url) + '" readonly spellcheck="false"></label><button type="button" data-action="copy-private-link">Copy link</button></section>' : '';
}
function priorMeetingHTML() {
  const pending = (state.data.pendingMeetings || []).filter(m => m.date !== state.data.meeting?.date);
  if (!pending.length && !state.priorMeeting) return '';
  const prior = state.priorMeeting;
  let html = '<section class="mq-section spaced-section"><details class="organiser-details"' + (prior ? ' open' : '') + '><summary>Record an earlier meeting</summary><form id="prior-meeting-form" class="form-stack compact-form"><label>Meeting<select name="date" required><option value="">Choose a meeting</option>' + pending.map(m => '<option value="' + esc(m.date) + '"' + (prior?.meeting?.date === m.date ? ' selected' : '') + '>' + esc(dateLabel(m.date)) + '</option>').join('') + '</select></label><button type="submit">Review meeting</button></form>';
  if (prior) {
    const plan = prior.plan;
    html += '<div class="prior-plan"><h3>' + esc(dateLabel(prior.meeting?.date)) + '</h3>' + planHTML(true, plan, prior.meeting);
    if (plan?.tables?.length && prior.meeting?.status !== 'completed') {
      if (!plan.locked) html += '<p>Check this saved arrangement before confirming it.</p><button type="button" data-action="lock-prior"' + ((plan.unassignedMemberIds || []).length ? ' disabled' : '') + '>Confirm these tables</button>';
      else html += '<p>Record this meeting only if the displayed tables match what was actually played.</p><label class="mq-checkbox"><input id="confirm-prior-played" type="checkbox"' + (state.priorConfirmed ? ' checked' : '') + '>These tables match what was actually played.</label><button type="button" class="mq-primary" data-action="complete-prior"' + (!state.priorConfirmed ? ' disabled' : '') + '>Record this completed meeting</button>';
    }
    html += '</div>';
  }
  return html + '</details></section>';
}
function meetingManagementHTML() {
  const schedule = state.meetingSchedule;
  if (!schedule) return '';
  const entries = schedule.meetings || [];
  const rowHTML = m => '<li><div><strong>' + esc(dateLabel(m.date)) + '</strong><p class="mq-muted">' + (m.removedAt != null ? 'Removed' : m.status === 'completed' ? 'Recorded' : m.date === schedule.currentDate ? 'Next meeting · 10 am' : '10 am') + '</p></div>' + (m.status === 'completed' ? '' : '<button type="button" class="mq-small-action" data-' + (m.removedAt != null ? 'restore' : 'remove') + '-meeting="' + esc(m.date) + '">' + (m.removedAt != null ? 'Restore meeting' : 'Remove meeting') + '</button>') + '</li>';
  const upcoming = entries.filter(m => m.removedAt == null);
  const removed = entries.filter(m => m.removedAt != null);
  const earlier = schedule.earlierMeetings || [];
  return '<section class="mq-section spaced-section"><h2>Meetings</h2><p class="mq-muted">Fourth Sundays are listed automatically. Add another date or remove a meeting when needed. All meetings start at 10 am.</p><form id="create-meeting-form" class="form-stack compact-form"><label>Meeting date<input name="date" type="date" required min="' + esc(schedule.today) + '"></label><button type="submit" class="mq-primary">Add meeting</button></form><details class="organiser-details" open><summary>Upcoming meetings</summary><ul class="fixed-list">' + upcoming.map(rowHTML).join('') + '</ul></details>' + (removed.length ? '<details class="organiser-details"><summary>Removed meetings</summary><ul class="fixed-list">' + removed.map(rowHTML).join('') + '</ul></details>' : '') + (earlier.length ? '<details class="organiser-details"><summary>Earlier unrecorded meetings</summary><ul class="fixed-list">' + earlier.map(rowHTML).join('') + '</ul></details>' : '') + '</section>';
}
function organiseHTML() {
  const plan = state.data.plan;
  const fixed = currentFixedTables();
  const complete = state.data.meeting?.status === 'completed';
  return meetingManagementHTML() + '<div class="heading-row"><h2>Organise the meeting</h2><span class="mq-muted">' + esc(meetingLabel()) + '</span></div><div class="mq-inline admin-actions"><button type="button" class="mq-primary" data-action="recommend"' + (complete ? ' disabled' : '') + '>Recommend tables</button>' + (plan?.tables?.length && !plan.locked ? '<button type="button" data-action="lock-plan"' + ((plan.unassignedMemberIds || []).length ? ' disabled' : '') + '>Confirm these tables</button>' : '') + '</div>' + planHTML(true) + '<section class="mq-section spaced-section"><h2>Pre-arranged tables</h2>' + (fixed.length ? '<ul class="fixed-list">' + fixed.map((table, index) => '<li><div><strong>' + esc(gameName(table.gameId)) + '</strong><p class="mq-muted">' + table.memberIds.map(id => esc(memberName(id))).join(', ') + '</p></div><button type="button" class="mq-small-action" data-remove-fixed="' + index + '">Remove reservation</button></li>').join('') + '</ul>' : '<p class="mq-muted">No pre-arranged tables.</p>') + (!complete ? '<details class="organiser-details"><summary>Reserve an agreed table</summary><div id="fixed-form-container">' + fixedFormHTML() + '</div></details>' : '') + '</section>' + (plan?.locked && !complete ? '<section class="mq-section spaced-section"><h2>Record the meeting</h2><p>Check the tables above against what was actually played. If they differ, update the arrangements before recording the meeting.</p><label class="mq-checkbox"><input id="confirm-played" type="checkbox"' + (state.completionConfirmed ? ' checked' : '') + '>These tables match what was actually played.</label><button type="button" class="mq-primary" data-action="complete-meeting"' + (!state.completionConfirmed ? ' disabled' : '') + '>Record completed meeting</button></section>' : '') + priorMeetingHTML() + '<section class="mq-section spaced-section"><h2>Invite a member</h2><form id="invite-form" class="form-stack compact-form"><label>Email address<input name="email" type="email" required autocomplete="off" maxlength="254"></label><label>Name <span class="mq-muted">Optional</span><input name="name" maxlength="60" autocomplete="off"></label><button type="submit">Create invitation link</button></form></section><section class="mq-section spaced-section"><h2>Password recovery</h2><form id="admin-reset-form" class="form-stack compact-form"><label>Member<select name="userId" required><option value="">Choose a member</option>' + members().map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('') + '</select></label><button type="submit">Create private reset link</button></form></section>' + privateLinkHTML();
}
function historyHTML() {
  const items = state.data.history || [];
  if (!items.length) return '<h2>Past meetings</h2><p class="mq-muted">Completed meetings will appear here.</p>';
  return '<h2>Past meetings</h2><div class="history-list">' + items.map(item => {
    const label = item.label || dateLabel(item.meetingDate || item.date || item.meeting?.date);
    const title = item.gameTitle || item.title || (item.gameId ? gameName(item.gameId) : '');
    const tables = item.tables || [];
    return '<article class="history-entry"><h3>' + esc(label) + '</h3>' + (title ? '<p>' + esc(title) + '</p>' : '') + (tables.length ? '<ul>' + tables.map(t => '<li>' + esc(t.gameTitle || gameName(t.gameId)) + (t.memberIds?.length ? ' · ' + t.memberIds.map(id => esc(memberName(id))).join(', ') : '') + '</li>').join('') + '</ul>' : '') + (item.wasPriority || item.priorityFulfilled || (item.priorityGameId && same(item.priorityGameId, item.gameId)) ? '<p class="mq-muted">You played your priority pick.</p>' : '') + '</article>';
  }).join('') + '</div>';
}
function accountHTML() {
  const user = state.data.user;
  const emailEnabled = state.data.config?.emailNotifications;
  const emailControls = emailEnabled && !user.emailVerified ? '<div class="mq-inline"><button type="button" data-action="verify-email">Verify my email address</button></div>' : '';
  const emailHelp = !emailEnabled ? 'Email updates are not enabled yet.' : !user.emailVerified ? 'Meeting updates are delivered only after your email address is verified.' : 'Your email address is verified.';
  return '<section class="auth-panel"><h2>My account</h2><p>' + esc(user.email) + '</p>' + emailControls + '<form id="profile-form" class="form-stack account-form"><label>Name<input name="name" value="' + esc(user.name) + '" required maxlength="60" autocomplete="name"></label><label class="mq-checkbox"><input type="checkbox" name="notifications" aria-describedby="email-update-help"' + (user.notifications ? ' checked' : '') + (!emailEnabled ? ' disabled' : '') + '>Email meeting updates</label><p id="email-update-help" class="mq-muted">' + esc(emailHelp) + '</p><button class="mq-primary" type="submit">Save account details</button></form><section class="mq-section spaced-section"><h3>Change password</h3><form id="change-password-form" class="form-stack"><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>New password<input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" aria-describedby="change-password-help"></label><p id="change-password-help" class="mq-muted">Use 12–128 characters. Changing your password will sign you out on other devices.</p><button type="submit" class="mq-primary">Change password</button></form><button type="button" class="mq-small-action" data-action="forgot-password">Forgot my current password</button></section></section>';
}

function capturePreferenceUndo(gameId) {
  return { gameId, previousRating: rating(gameId), previousPriority: prefs().priorityGameId || null, review: structuredClone(state.review) };
}
async function saveRating(gameId, value, reviewing) {
  const undo = capturePreferenceUndo(gameId);
  await perform(() => post('/api/rating', { gameId, rating: value }), gameName(gameId) + ': ' + ({ want: 'Want', will: 'Will play', pass: 'Passed' }[value] || 'Unrated') + '.', () => { state.undo = undo; if (reviewing) state.review.index++; });
}
async function savePriority(gameId, reviewing) {
  const changedGame = gameId || prefs().priorityGameId;
  const undo = changedGame ? capturePreferenceUndo(changedGame) : null;
  await perform(() => post('/api/priority', { gameId }), gameId ? 'Current priority pick saved.' : 'Priority pick cleared.', () => { state.undo = undo; if (reviewing) state.review.index++; });
}
async function undoPreference() {
  const undo = state.undo;
  if (!undo) return;
  await perform(async () => {
    await post('/api/rating', { gameId: undo.gameId, rating: undo.previousRating });
    await post('/api/priority', { gameId: undo.previousPriority });
  }, 'Previous preference restored.', () => { state.review = undo.review; state.undo = null; });
}
function updateGameDraft(form) {
  const fd = new FormData(form);
  Object.assign(state.gameDraft, { title: String(fd.get('title') || '').trim(), bggUrl: String(fd.get('bggUrl') || '').trim(), own: fd.has('own'), teach: fd.has('teach'), pitch: String(fd.get('pitch') || '').trim() });
  if (state.selectedGame && state.gameDraft.bggUrl !== ('https://boardgamegeek.com/boardgame/' + state.selectedGame.bggId)) state.selectedGame = null;
}
async function saveGame(form) {
  updateGameDraft(form);
  const d = state.gameDraft;
  if (!state.editingGameId && !d.own && !d.teach) { showError(new Error('To add an available game, select “I own a copy” or “I can teach it”.')); return; }
  if (!d.counts.length) { showError(new Error('Select at least one player count you will play.')); return; }
  const payload = { title: d.title, own: d.own, teach: d.teach, counts: [...d.counts].sort((a, b) => a - b), pitch: d.pitch };
  if (d.bggUrl) payload.bggUrl = d.bggUrl;
  if (state.selectedGame?.bggId) payload.bggId = state.selectedGame.bggId;
  const editing = state.editingGameId;
  await perform(() => editing ? put('/api/games/' + encodeURIComponent(editing) + '/offer', payload) : post('/api/games', payload), editing ? 'Your game details have been saved.' : 'Game added.', () => { state.undo = null; state.view = 'games'; state.filter = 'all'; state.query = d.title; state.editingGameId = null; });
}
async function copyPrivateLink() {
  if (!state.privateLink?.url) return;
  try { await navigator.clipboard.writeText(state.privateLink.url); announce('Private link copied.'); }
  catch { const input = document.getElementById('private-link'); input?.focus(); input?.select(); announce('Select and copy the private link.'); }
}
function navigate(view) {
  clearError();
  if (view === 'add' && state.view !== 'add') startAdd();
  else state.view = view;
  state.completionConfirmed = false;
  render();
  main.focus({ preventScroll: true });
}

root.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled || state.busy) return;
  if (button.id === 'undo-button') { await undoPreference(); return; }
  const d = button.dataset;
  if (d.view) { navigate(d.view); return; }
  if (d.rate) { await saveRating(d.game, d.rate, d.review === 'true'); return; }
  if (d.priority) { await savePriority(same(prefs().priorityGameId, d.priority) ? null : d.priority, d.review === 'true'); return; }
  if (d.removeMeeting || d.restoreMeeting) {
    const date = d.removeMeeting || d.restoreMeeting;
    const schedule = state.meetingSchedule;
    const meeting = [...(schedule?.meetings || []), ...(schedule?.earlierMeetings || [])].find(m => m.date === date);
    if (!meeting || !isAdmin()) return;
    const removing = Boolean(d.removeMeeting);
    const message = removing
      ? 'Remove ' + dateLabel(date) + '? This hides the meeting and stops its reminders. Preferences and completed play history are unchanged. Future meetings can be restored later.'
      : 'Restore ' + dateLabel(date) + '? Previous attendance is kept, but tables will need to be planned again.';
    if (!window.confirm(message)) return;
    await perform(() => post('/api/admin/meetings/' + (removing ? 'remove' : 'restore'), {date, revision:meeting.revision}), removing ? 'Meeting removed.' : 'Meeting restored.', () => { state.priorMeeting = null; state.priorConfirmed = false; state.completionConfirmed = false; });
    return;
  }
  if (d.filter) { state.filter = d.filter; render(); return; }
  if (d.offer) { editOffer(gameById(d.offer)); render(); return; }
  if (d.count) {
    const n = Number(d.count); const counts = state.gameDraft.counts;
    state.gameDraft.counts = counts.includes(n) ? counts.filter(c => c !== n) : [...counts, n].sort((a, b) => a - b);
    button.setAttribute('aria-pressed', String(state.gameDraft.counts.includes(n))); return;
  }
  if (d.searchResult !== undefined) { chooseSearchResult(Number(d.searchResult)); return; }
  if (d.removeFixed !== undefined) {
    const tables = currentFixedTables().filter((_, i) => i !== Number(d.removeFixed));
    await perform(() => put('/api/admin/fixed', { tables }), 'Table reservation removed.'); return;
  }
  switch (d.action) {
    case 'sign-out':
      await perform(() => post('/api/auth/sign-out', {}), 'Signed out.', () => { state.undo = null; state.privateLink = null; state.view = 'meeting'; }); break;
    case 'forgot-password': information('Password recovery', 'Ask the organiser for a new private password-reset link.'); break;
    case 'verify-email':
      if (state.data.config?.emailNotifications && !state.data.user.emailVerified) await perform(() => post('/api/auth/send-verification-email', { email: state.data.user.email, callbackURL: location.origin }), 'Verification email sent. Open the link in that email to verify your address.');
      break;
    case 'attendance': {
      const coming = d.coming === 'true';
      const ok = await perform(() => post('/api/attendance', { coming }), coming ? 'You’re coming.' : 'Attendance updated.');
      if (ok && coming && unratedIds().length) { beginReview(); render(); }
      break;
    }
    case 'clear-priority': await savePriority(null, false); break;
    case 'review': beginReview(); render(); break;
    case 'skip-review': state.review.index++; render(); announce('Left unrated. This game cannot be assigned yet.'); break;
    case 'review-later': state.review.active = false; render(); break;
    case 'cancel-game': state.view = 'games'; render(); break;
    case 'recommend': await perform(() => post('/api/admin/plan', {}), 'Table recommendations updated.', () => { state.completionConfirmed = false; }); break;
    case 'lock-plan': await perform(() => post('/api/admin/lock', { revision: state.data.plan.revision }), 'Tables confirmed.'); break;
    case 'complete-meeting':
      if (state.completionConfirmed) await perform(() => post('/api/admin/complete', { revision: state.data.plan.revision }), 'Meeting recorded.', () => { state.completionConfirmed = false; });
      break;
    case 'copy-private-link': await copyPrivateLink(); break;
    case 'lock-prior': {
      const prior = state.priorMeeting;
      if (prior?.plan) await perform(() => post('/api/admin/lock', { revision: prior.plan.revision, meetingDate: prior.meeting.date }), 'Earlier meeting tables confirmed.', async () => {
        state.priorMeeting = null; state.priorConfirmed = false;
        try { state.priorMeeting = await api('/api/admin/meeting?date=' + encodeURIComponent(prior.meeting.date)); }
        catch { throw new Error('The tables were confirmed, but the details could not refresh. Review the earlier meeting again before recording it.'); }
      });
      break;
    }
    case 'complete-prior': {
      const prior = state.priorMeeting;
      if (prior?.plan && state.priorConfirmed) await perform(() => post('/api/admin/complete', { revision: prior.plan.revision, meetingDate: prior.meeting.date }), 'Earlier meeting recorded.', () => { state.priorMeeting = null; state.priorConfirmed = false; });
      break;
    }
  }
});
root.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'catalogue-search') { state.query = el.value; const list = document.getElementById('game-list'); if (list) list.innerHTML = gameCardsHTML(); }
  else if (el.id === 'add-search') { state.searchQuery = el.value; clearTimeout(searchTimer); state.searchVersion++; searchTimer = setTimeout(() => runSearch(state.searchQuery), 350); }
  else if (el.closest('#game-form')) updateGameDraft(el.closest('form'));
});
root.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'fixed-game') { state.fixedGameId = el.value; state.fixedMembers = []; document.getElementById('fixed-form-container').innerHTML = fixedFormHTML(); }
  else if (el.name === 'memberIds' && el.closest('#fixed-form')) {
    state.fixedMembers = Array.from(new FormData(el.closest('form')).getAll('memberIds'));
    document.getElementById('fixed-form-container').innerHTML = fixedFormHTML();
  } else if (el.id === 'confirm-played') { state.completionConfirmed = el.checked; const button = main.querySelector('[data-action="complete-meeting"]'); if (button) button.disabled = !el.checked; }
  else if (el.id === 'confirm-prior-played') { state.priorConfirmed = el.checked; const button = main.querySelector('[data-action="complete-prior"]'); if (button) button.disabled = !el.checked; }
  else if (el.closest('#game-form')) updateGameDraft(el.closest('form'));
});
root.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('form')) return;
  event.preventDefault();
  if (state.busy) return;
  const fd = new FormData(form);
  clearError();
  switch (form.id) {
    case 'sign-in-form': await perform(() => post('/api/auth/sign-in/email', { email: String(fd.get('email')).trim(), password: fd.get('password') }), 'Signed in.'); break;
    case 'register-form':
      await perform(() => post('/api/register', { token: inviteToken, name: String(fd.get('name')).trim(), email: String(fd.get('email')).trim(), password: fd.get('password') }), 'Account created.', () => { inviteToken = null; }); break;
    case 'reset-form':
      await perform(() => post('/api/auth/reset-password', { token: resetToken, newPassword: fd.get('newPassword') }), 'Password changed. You can sign in with your new password.', () => { resetToken = null; }); break;
    case 'game-form': await saveGame(form); break;
    case 'profile-form':
      await perform(() => post('/api/profile', { name: String(fd.get('name')).trim(), notifications: state.data.config?.emailNotifications ? fd.has('notifications') : Boolean(state.data.user.notifications) }), 'Account details saved.'); break;
    case 'change-password-form':
      await perform(() => post('/api/auth/change-password', { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword'), revokeOtherSessions: true }), 'Password changed. Other sessions have been signed out.'); break;
    case 'fixed-form': {
      const memberIds = fd.getAll('memberIds');
      if (!memberIds.length) { showError(new Error('Select the agreed players for this table.')); return; }
      const table = { gameId: fd.get('gameId'), memberIds, teacherId: fd.get('teacherId'), copyOwnerId: fd.get('copyOwnerId') };
      await perform(() => put('/api/admin/fixed', { tables: [...currentFixedTables(), table] }), 'Pre-arranged table saved.', () => { state.fixedGameId = ''; state.fixedMembers = []; }); break;
    }
    case 'invite-form': {
      const email = String(fd.get('email')).trim();
      await perform(() => post('/api/admin/invites', { email, name: String(fd.get('name') || '').trim() }), 'Invitation link created.', response => { state.privateLink = { title: 'Member invitation', recipient: email, url: response.url }; });
      document.getElementById('private-link')?.scrollIntoView({ block: 'nearest' }); break;
    }
    case 'admin-reset-form': {
      const userId = fd.get('userId');
      await perform(() => post('/api/admin/reset', { userId }), 'Private reset link created.', response => { state.privateLink = { title: 'Password-reset link', recipient: memberName(userId), url: response.url }; });
      document.getElementById('private-link')?.scrollIntoView({ block: 'nearest' }); break;
    }
    case 'create-meeting-form':
      await perform(() => post('/api/admin/meetings', {date:String(fd.get('date') || '')}), 'Meeting added.', () => { state.completionConfirmed = false; }); break;
    case 'prior-meeting-form':
      await perform(() => api('/api/admin/meeting?date=' + encodeURIComponent(fd.get('date'))), 'Earlier meeting loaded.', response => { state.priorMeeting = response; state.priorConfirmed = false; }, 'Loading meeting…'); break;
  }
});

try { await load(); render(); }
catch (error) { showError(error); main.innerHTML = '<p>The meeting details could not be loaded.</p><button type="button" id="retry-load">Try again</button>'; document.getElementById('retry-load').addEventListener('click', () => location.reload()); }
finally { main.setAttribute('aria-busy', 'false'); }
