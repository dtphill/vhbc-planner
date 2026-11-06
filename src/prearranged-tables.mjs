/** Member-created agreed tables; no admin permission is delegated to the client. */
export const PREARRANGED_VERSION = '1.3.1';
const HEADERS = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const json = (data, status = 200) => Response.json(data, {status, headers:HEADERS});
export class ReservationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ReservationError(status, message); };
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const first = (db, sql, ...args) => statement(db, sql, ...args).first();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100;

async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'Send JSON with this request.');
  if (!request.body) fail(400, 'Enter the table details.');
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); fail(413, 'This request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'Enter valid table details.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Enter valid table details.');
  return body;
}

/** Validate the new table without changing preferences or existing reservations. */
export function validateReservation(data, fixed, body, ratings) {
  if (body.agreed !== true) fail(400, 'Confirm that everyone at this table has agreed.');
  if (!id(body.gameId) || !id(body.teacherId) || !id(body.copyOwnerId)
      || !Array.isArray(body.memberIds) || body.memberIds.length < 2 || body.memberIds.length > 12
      || body.memberIds.some(value => !id(value)) || new Set(body.memberIds).size !== body.memberIds.length) {
    fail(400, 'Choose a game, distinct players, a teacher and a copy.');
  }
  if (data.user.role !== 'admin' && !body.memberIds.includes(data.user.id)) fail(403, 'You must be one of the players at the table you reserve.');
  if (fixed.length >= 8) fail(422, 'Ask the organiser before adding another table.');
  const game = data.games.find(g => g.id === body.gameId);
  if (!game) fail(404, 'This game is not available.');
  const attendees = new Map(data.members.filter(m => m.coming).map(m => [m.id, m]));
  const reserved = new Set(fixed.flatMap(table => table.memberIds || []));
  for (const userId of body.memberIds) {
    if (!attendees.has(userId)) fail(422, 'Every player must mark themselves as coming first.');
    const name = attendees.get(userId).name;
    if (reserved.has(userId)) fail(409, `${name} is already in a pre-arranged table.`);
    if (!['want','will'].includes(ratings.get(userId))) fail(422, `${name} needs to mark this game Want or Will play first.`);
    const offer = game.offers.find(o => o.userId === userId);
    if (offer && !offer.counts.includes(body.memberIds.length)) fail(422, `${name} has not selected this player count for this game.`);
  }
  const teacher = game.offers.find(o => o.userId === body.teacherId && o.teach);
  if (!body.memberIds.includes(body.teacherId) || !teacher?.counts.includes(body.memberIds.length)) {
    fail(422, 'Choose a player who has offered to teach at this exact player count.');
  }
  if (!attendees.has(body.copyOwnerId) || !game.offers.some(o => o.userId === body.copyOwnerId && o.own)) {
    fail(422, 'Choose an attending member who has offered a copy.');
  }
  if (fixed.some(table => table.gameId === body.gameId && table.copyOwnerId === body.copyOwnerId)) fail(409, 'That copy is already reserved for another table.');
  return {gameId:game.id, memberIds:[...body.memberIds].sort(), teacherId:body.teacherId, copyOwnerId:body.copyOwnerId};
}

async function handleReservation(request, env, ctx, base) {
  const path = new URL(request.url).pathname;
  const reading = path === '/api/prearranged/options';
  if (request.method !== (reading ? 'GET' : 'POST')) fail(405, reading ? 'Use GET.' : 'Use POST.');
  if (!reading && (request.headers.get('origin') !== env.APP_URL || request.headers.get('sec-fetch-site') === 'cross-site')) fail(403, 'Use the Collective website for this action.');
  const body = reading ? null : await readBody(request);
  const response = await base.fetch(new Request(new URL('/api/bootstrap', request.url), {headers:request.headers}), env, ctx);
  if (!response.ok) fail(503, 'The meeting could not be loaded. Please refresh.');
  const data = await response.json(); if (!data.user) fail(401, 'Please sign in.');
  const meeting = await first(env.DB, 'SELECT * FROM meetings WHERE id=? AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)', data.meeting.date);
  if (!meeting) fail(409, 'The meeting changed. Refresh before reserving a table.');
  const fixed = JSON.parse(meeting.fixed_json);
  if (reading) return json({user:{id:data.user.id, role:data.user.role}, meeting:{date:meeting.id,label:data.meeting.label,status:meeting.status,revision:meeting.revision}, games:data.games, members:data.members.filter(m => m.coming).map(m => ({id:m.id,name:m.name})), fixedTables:fixed});
  if (body.meetingDate !== meeting.id || !Number.isInteger(body.revision) || body.revision !== meeting.revision) fail(409, 'The meeting changed. Close and reopen this option before trying again.');
  if (meeting.status !== 'open') fail(409, 'The tables are already confirmed or recorded. Ask the organiser to make changes.');
  const rows = (await statement(env.DB, 'SELECT user_id,value FROM ratings WHERE game_id=?', typeof body.gameId === 'string' ? body.gameId : '').all()).results;
  const table = validateReservation(data, fixed, body, new Map(rows.map(row => [row.user_id,row.value])));
  // Every relevant attendance/preference change increments the meeting revision.
  // Conditional audit + update share one D1 transaction, so a competing save cannot overwrite reservations.
  const condition = "id=? AND revision=? AND status='open' AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)";
  const now = Date.now();
  const saved = await env.DB.batch([
    statement(env.DB, `INSERT INTO audit_log(id,actor_id,action,meeting_id,created_at) SELECT ?,?,'meeting.table-reserved',?,? WHERE EXISTS(SELECT 1 FROM meetings WHERE ${condition})`, crypto.randomUUID(),data.user.id,meeting.id,now,meeting.id,meeting.revision),
    statement(env.DB, `UPDATE meetings SET fixed_json=?,plan_json=NULL,revision=revision+1,updated_at=? WHERE ${condition}`, JSON.stringify([...fixed,table]),now,meeting.id,meeting.revision),
  ]);
  if (!saved[1].meta.changes) fail(409, 'The meeting changed while you were saving. Close and reopen this option.');
  return json({ok:true,meetingDate:meeting.id,revision:meeting.revision+1});
}

export function withPrearrangedTables(base, assets) {
  return {...base, async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/api/prearranged/options' || path === '/api/prearranged/reserve') {
      try { return await handleReservation(request,env,ctx,base); }
      catch (error) { return json({error:error instanceof ReservationError ? error.message : 'The table could not be saved. Refresh and try again.'},error instanceof ReservationError ? error.status : 500); }
    }
    if (path === '/media/prearranged.js' || path === '/media/prearranged.css') {
      if (!['GET','HEAD'].includes(request.method)) return json({error:'Use GET.'},405);
      const script = path.endsWith('.js');
      return new Response(request.method === 'HEAD' ? null : script ? assets.javascript : assets.css, {headers:{...HEADERS,'Content-Type':script?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
    }
    const response = await base.fetch(request,env,ctx);
    if (path === '/api/health' && response.ok) return json({...await response.json(),prearrangedTables:PREARRANGED_VERSION});
    if (path !== '/' || request.method !== 'GET' || !response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;
    const headers = new Headers(response.headers); headers.delete('Content-Length'); headers.delete('ETag');
    const html = (await response.text()).replace('</head>',`<link rel="stylesheet" href="/media/prearranged.css?v=${PREARRANGED_VERSION}"></head>`).replace('</body>',`<script type="module" src="/media/prearranged.js?v=${PREARRANGED_VERSION}"></script></body>`);
    return new Response(html,{status:response.status,headers});
  }};
}
