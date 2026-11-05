import {fourthSunday, localDate, TIME_ZONE} from './calendar.mjs';

export class MeetingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new MeetingError(status, message); };
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const first = (db, sql, ...args) => statement(db, sql, ...args).first();
const all = async (db, sql, ...args) => (await statement(db, sql, ...args).all()).results;
const active = 'NOT EXISTS (SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)';
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});

export function validateMeetingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Choose a valid meeting date.');
  const parsed = new Date(value+'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '2000-01-01') {
    fail(400, 'Choose a valid meeting date.');
  }
  return value;
}

export function describeMeeting(date) {
  validateMeetingDate(date);
  return {
    date,
    label: new Intl.DateTimeFormat('en-AU', {timeZone:'UTC', weekday:'long', day:'numeric', month:'long', year:'numeric'}).format(new Date(date+'T00:00:00Z')),
    startTime: '10 am', timeZone: TIME_ZONE,
  };
}

async function defaultDates(db, today, count) {
  const removed = new Set((await all(db, 'SELECT meeting_id FROM meeting_exclusions WHERE meeting_id>=?', today)).map(r => r.meeting_id));
  const [year, month] = today.split('-').map(Number);
  const dates = [];
  // There can be at most removed.size excluded dates ahead of the requested dates.
  for (let offset=0; dates.length<count && offset<count+removed.size+2; offset++) {
    const date = fourthSunday(year, month-1+offset);
    if (date >= today && !removed.has(date)) dates.push(date);
  }
  return dates;
}

/** Pick the earliest active meeting, whether manually added or a normal fourth Sunday. */
export async function ensureMeeting(env, requestedDate = null, now = new Date()) {
  if (requestedDate) {
    const date = validateMeetingDate(requestedDate);
    const row = await first(env.DB, 'SELECT * FROM meetings WHERE id=? AND '+active, date);
    if (!row) fail(409, 'This meeting has been removed or changed. Refresh the page before continuing.');
    return {...describeMeeting(row.id), ...row};
  }
  const today = localDate(now);
  const [regular] = await defaultDates(env.DB, today, 1);
  const existing = await first(env.DB, 'SELECT * FROM meetings WHERE id>=? AND '+active+' ORDER BY id LIMIT 1', today);
  const date = existing && existing.id <= regular ? existing.id : regular;
  await statement(env.DB, 'INSERT OR IGNORE INTO meetings(id,updated_at) VALUES (?,?)', date, Date.now()).run();
  const row = await first(env.DB, 'SELECT * FROM meetings WHERE id=? AND '+active, date);
  // A concurrent removal should not let a request act on the cancelled meeting.
  if (!row) fail(409, 'The meeting schedule changed. Refresh the page before continuing.');
  return {...describeMeeting(date), ...row};
}

export async function listMeetings(env, now = new Date()) {
  const today = localDate(now);
  const defaults = await defaultDates(env.DB, today, 6);
  if (defaults.length) await env.DB.batch(defaults.map(date => statement(env.DB, 'INSERT OR IGNORE INTO meetings(id,updated_at) VALUES (?,?)', date, Date.now())));
  const rows = await all(env.DB,
    'SELECT m.id AS date,m.status,m.revision,x.removed_at AS removedAt FROM meetings m LEFT JOIN meeting_exclusions x ON x.meeting_id=m.id WHERE m.id>=? ORDER BY m.id LIMIT 100', today);
  const earlier = await all(env.DB,
    "SELECT m.id AS date,m.status,m.revision,x.removed_at AS removedAt FROM meetings m LEFT JOIN meeting_exclusions x ON x.meeting_id=m.id WHERE m.id<? AND m.status!='completed' AND x.meeting_id IS NULL ORDER BY m.id DESC LIMIT 12", today);
  return {meetings:rows, earlierMeetings:earlier, today, currentDate:(await ensureMeeting(env, null, now)).date};
}

/** Called only after normal session and same-origin checks; recheck the role here too. */
export async function manageMeetings(request, env, member, body, now = new Date()) {
  const path = new URL(request.url).pathname;
  if (!['/api/admin/meetings','/api/admin/meetings/remove','/api/admin/meetings/restore'].includes(path)) return null;
  if (member?.role !== 'admin') fail(403, 'Only the organiser can manage meetings.');
  if (path === '/api/admin/meetings' && request.method === 'GET') return json(await listMeetings(env, now));
  if (request.method !== 'POST') fail(405, 'This method is not supported.');
  const date = validateMeetingDate(body.date);
  const today = localDate(now);
  const db = env.DB;
  const timestamp = Date.now();

  if (path === '/api/admin/meetings') {
    if (date < today) fail(400, 'Add a meeting for today or a future date.');
    const existing = await first(db, 'SELECT id FROM meetings WHERE id=?', date);
    if (existing) {
      const removed = await first(db, 'SELECT meeting_id FROM meeting_exclusions WHERE meeting_id=?', date);
      fail(409, removed ? 'This date was removed. Use Restore meeting to bring it back.' : 'A meeting is already scheduled for this date.');
    }
    const result = await db.batch([
      statement(db, 'INSERT OR IGNORE INTO meetings(id,updated_at) VALUES (?,?)', date, timestamp),
    ]);
    if (!result[0].meta.changes) fail(409, 'A meeting is already scheduled for this date.');
    await statement(db, 'INSERT INTO audit_log(id,actor_id,action,meeting_id,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), member.id, 'meeting.created', date, timestamp).run();
    return json({ok:true, date}, 201);
  }

  if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Refresh the meeting list and try again.');
  const row = await first(db, 'SELECT m.*,x.removed_at AS removedAt FROM meetings m LEFT JOIN meeting_exclusions x ON x.meeting_id=m.id WHERE m.id=?', date);
  if (!row) fail(404, 'Meeting not found.');
  if (row.status === 'completed') fail(409, 'Completed meetings are kept for play history and cannot be removed.');
  if (row.revision !== body.revision) fail(409, 'This meeting changed. Refresh the meeting list and try again.');

  if (path.endsWith('/remove')) {
    if (row.removedAt != null) fail(409, 'This meeting has already been removed.');
    const result = await db.batch([
      statement(db, "INSERT OR IGNORE INTO meeting_exclusions(meeting_id,removed_at,removed_by) SELECT id,?,? FROM meetings WHERE id=? AND revision=? AND status!='completed'", timestamp, member.id, date, body.revision),
      statement(db, "UPDATE meetings SET status='open',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status!='completed' AND EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)", timestamp, date, body.revision),
      statement(db, "INSERT INTO audit_log(id,actor_id,action,meeting_id,created_at) SELECT ?,?,'meeting.removed',?,? WHERE EXISTS(SELECT 1 FROM meetings m JOIN meeting_exclusions x ON x.meeting_id=m.id WHERE m.id=? AND m.revision=?)", crypto.randomUUID(), member.id, date, timestamp, date, body.revision+1),
    ]);
    if (!result[0].meta.changes || !result[1].meta.changes) fail(409, 'This meeting changed. Refresh the meeting list and try again.');
    return json({ok:true, date});
  }

  if (date < today) fail(400, 'Only today or future meetings can be restored.');
  if (row.removedAt == null) fail(409, 'This meeting is already on the schedule.');
  const result = await db.batch([
    statement(db, "UPDATE meetings SET status='open',plan_json=NULL,fixed_json='[]',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status!='completed' AND EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)", timestamp, date, body.revision),
    statement(db, "DELETE FROM meeting_exclusions WHERE meeting_id=? AND EXISTS(SELECT 1 FROM meetings WHERE id=? AND revision=? AND status='open')", date, date, body.revision+1),
    statement(db, "INSERT INTO audit_log(id,actor_id,action,meeting_id,created_at) SELECT ?,?,'meeting.restored',?,? WHERE EXISTS(SELECT 1 FROM meetings WHERE id=? AND revision=? AND status='open')", crypto.randomUUID(), member.id, date, timestamp, date, body.revision+1),
  ]);
  if (!result[0].meta.changes || !result[1].meta.changes) fail(409, 'This meeting changed. Refresh the meeting list and try again.');
  return json({ok:true, date});
}
