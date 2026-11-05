import {createAuth, mailEnabled, randomToken, tokenHash, sendMail} from './auth.mjs';
import {localDate} from './calendar.mjs';
import {ensureMeeting, describeMeeting, manageMeetings} from './meetings.mjs';
import {allocateTables} from './allocation.mjs';
import {parseBggId, searchBgg} from './bgg.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const statement = (db, sql, ...params) => db.prepare(sql).bind(...params);

export async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415, 'Send JSON with this request.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const parts = []; let length = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32768) { await reader.cancel(); fail(413, 'This request is too large.'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'This request is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.');
  return value;
}

function cleanText(value, max, label, required = true) {
  if (typeof value !== 'string') { if (!required && value == null) return ''; fail(400, `${label} is required.`); }
  const text = value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if ((required && !text) || text.length > max) fail(400, `${label} must be ${required ? 'between 1 and' : 'no longer than'} ${max} characters.`);
  return text;
}
const emailAddress = value => {
  const email = cleanText(value, 254, 'Email address').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  return email;
};
export function validateOffer(body) {
  if (typeof body.own !== 'boolean' || typeof body.teach !== 'boolean') fail(400, 'Choose whether you own this game and can teach it.');
  if (!Array.isArray(body.counts) || !body.counts.length || body.counts.length > 11 || body.counts.some(n => !Number.isInteger(n) || n < 2 || n > 12)) fail(400, 'Select at least one player count between 2 and 12.');
  return {own:body.own, teach:body.teach, counts:[...new Set(body.counts)].sort((a,b)=>a-b), pitch:cleanText(body.pitch ?? '', 500, 'Pitch', false)};
}

async function rateLimit(env, request, bucket, max = 15) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const key = await tokenHash(`${bucket}:${ip}:${Math.floor(Date.now()/60000)}`);
  const row = await env.DB.prepare('INSERT INTO request_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, Date.now()+120000).first();
  if (row.count > max) fail(429, 'Please wait a minute before trying again.');
}

const invalidate = (db, date) => statement(db, "UPDATE meetings SET plan_json=NULL,status='open',revision=revision+1,updated_at=? WHERE id=? AND status!='completed'", Date.now(), date);
const invalidateUpcoming = db => statement(db, "UPDATE meetings SET plan_json=NULL,status='open',revision=revision+1,updated_at=? WHERE id>=? AND status!='completed' AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)", Date.now(), localDate());
const audit = (db, actor, action, meeting = null) => statement(db, 'INSERT INTO audit_log(id,actor_id,action,meeting_id,created_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), actor, action, meeting, Date.now());

async function getMember(env, auth, request, required = true) {
  const session = await auth.api.getSession({headers:request.headers});
  if (!session) { if (required) fail(401, 'Please sign in.'); return null; }
  const member = await first(env.DB, 'SELECT * FROM members WHERE user_id=? AND disabled=0', session.user.id);
  if (!member) { if (required) fail(403, 'This account does not have an active group invitation.'); return null; }
  return {...member, id:session.user.id, name:session.user.name, email:session.user.email, emailVerified:session.user.emailVerified};
}

async function gameList(env) {
  const rows = await all(env.DB, 'SELECT * FROM games ORDER BY title COLLATE NOCASE');
  const offers = await all(env.DB, 'SELECT o.*,u.name FROM offers o JOIN user u ON u.id=o.user_id JOIN members m ON m.user_id=o.user_id WHERE m.disabled=0');
  return rows.map(g => ({id:g.id,title:g.title,bggId:g.bgg_id,bggUrl:g.bgg_id ? `https://boardgamegeek.com/boardgame/${g.bgg_id}` : null,offers:offers.filter(o=>o.game_id===g.id).map(o=>({userId:o.user_id,name:o.name,own:!!o.own,teach:!!o.teach,counts:JSON.parse(o.counts_json),pitch:o.pitch}))}));
}

async function bootstrap(env, auth, request) {
  const member = await getMember(env, auth, request, false);
  const meeting = await ensureMeeting(env);
  const base = {user:null,meeting:{...describeMeeting(meeting.id),status:meeting.status},config:{bggSearch:!!env.BGG_TOKEN,emailNotifications:mailEnabled(env)}};
  if (!member) return json(base);
  const [games, ratings, members, history, pending] = await Promise.all([
    gameList(env),
    all(env.DB, 'SELECT game_id,value FROM ratings WHERE user_id=?', member.id),
    all(env.DB, 'SELECT m.user_id AS id,u.name,COALESCE(a.coming,0) AS coming FROM members m JOIN user u ON u.id=m.user_id LEFT JOIN attendance a ON a.user_id=m.user_id AND a.meeting_id=? WHERE m.disabled=0 ORDER BY u.name', meeting.date),
    all(env.DB, 'SELECT h.meeting_id AS date,h.game_id AS gameId,g.title,h.rating,h.fixed,h.priority_game_id AS priorityGameId FROM history h JOIN games g ON g.id=h.game_id WHERE h.user_id=? ORDER BY h.meeting_id DESC LIMIT 24', member.id),
    member.role === 'admin' ? all(env.DB, "SELECT id AS date,status,revision FROM meetings WHERE id<? AND status!='completed' AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id) AND plan_json IS NOT NULL ORDER BY id DESC LIMIT 12", meeting.date) : Promise.resolve([]),
  ]);
  const plan = meeting.plan_json ? JSON.parse(meeting.plan_json) : null;
  if (plan) delete plan.snapshot;
  return json({...base,user:{id:member.id,name:member.name,email:member.email,emailVerified:member.emailVerified,role:member.role,notifications:!!member.notifications},meeting:{...describeMeeting(meeting.id),status:meeting.status},games,preferences:{ratings:Object.fromEntries(ratings.map(r=>[r.game_id,r.value])),priorityGameId:member.priority_game_id},attendance:{coming:!!members.find(m=>m.id===member.id)?.coming},members:members.map(m=>({...m,coming:!!m.coming})),fixedTables:JSON.parse(meeting.fixed_json),plan:plan ? {...plan,locked:meeting.status==='locked',completed:meeting.status==='completed',revision:meeting.revision} : null,history,pendingMeetings:pending});
}

async function register(request, env, ctx) {
  await rateLimit(env, request, 'registration', 5);
  const body = await readJson(request);
  const email = emailAddress(body.email);
  const name = cleanText(body.name, 60, 'Display name');
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) fail(403, 'This invitation is invalid or has expired.');
  const hash = await tokenHash(body.token);
  const invitation = await first(env.DB, 'SELECT * FROM invites WHERE token_hash=? AND email=? AND used_at IS NULL AND expires_at>?', hash,email,Date.now());
  if (!invitation) fail(403, 'This invitation is invalid, already used or for a different email address.');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'Use a password between 12 and 128 characters.');
  const auth = createAuth(env, ctx, invitation);
  const response = await auth.api.signUpEmail({body:{email,name,password:body.password},headers:request.headers,asResponse:true});
  if (!response.ok) return response;
  const result = await response.clone().json();
  if (!result.user?.id) fail(500, 'The account could not be completed. Please contact the organiser.');
  try {
    const saved = await env.DB.batch([
      statement(env.DB,'INSERT INTO members(user_id,role,created_at) SELECT ?,role,? FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?',result.user.id,Date.now(),hash,Date.now()),
      statement(env.DB,'UPDATE invites SET used_at=?,claimed_by=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM members WHERE user_id=?)',Date.now(),result.user.id,hash,Date.now(),result.user.id),
      audit(env.DB,result.user.id,'member.registered'),
    ]);
    if (!saved[0].meta.changes || !saved[1].meta.changes) fail(409,'This invitation changed while you were registering. Ask the organiser for a new one.');
  } catch (error) {
    // Compensate only for the new orphan created by this attempt; established members are untouched.
    await statement(env.DB,'DELETE FROM user WHERE id=? AND NOT EXISTS(SELECT 1 FROM members WHERE user_id=?)',result.user.id,result.user.id).run();
    throw error;
  }
  return response;
}

async function planningInput(env, meeting) {
  const [people, games, ratings, history] = await Promise.all([
    all(env.DB,'SELECT m.user_id AS id,u.name,m.priority_game_id AS priorityGameId FROM members m JOIN user u ON u.id=m.user_id JOIN attendance a ON a.user_id=m.user_id WHERE m.disabled=0 AND a.meeting_id=? AND a.coming=1 ORDER BY m.user_id',meeting.id),
    gameList(env),
    all(env.DB,'SELECT user_id,game_id,value FROM ratings'),
    all(env.DB,'SELECT * FROM history ORDER BY meeting_id'),
  ]);
  if (people.length > 12) fail(422,'This version can plan up to 12 attendees. Please arrange larger meetings manually.');
  return {members:people.map(p=>({...p,ratings:Object.fromEntries(ratings.filter(r=>r.user_id===p.id).map(r=>[r.game_id,r.value])),restrictions:Object.fromEntries(games.flatMap(g=>g.offers.filter(o=>o.userId===p.id).map(o=>[g.id,o.counts]))),history:history.filter(h=>h.user_id===p.id).slice(-24).map(h=>({gameId:h.game_id,rating:h.rating,priorityGameId:h.priority_game_id,priorityFeasible:!!h.priority_feasible,fixed:!!h.fixed}))})),games,fixedTables:JSON.parse(meeting.fixed_json)};
}

function planSnapshot(input, result) {
  return Object.fromEntries(input.members.map(m=>[m.id,{ratings:m.ratings,priorityGameId:m.priorityGameId,priorityFeasible:result.feasiblePriorityMemberIds?.includes(m.id) || false}]));
}

async function savePlan(env, member, meeting, input, fixedTables = null) {
  const result = allocateTables(input);
  if (result.tables.filter(t=>t.fixed).length !== input.fixedTables.length) fail(422, result.warnings.join(' ') || 'A pre-arranged table has invalid players, counts, teacher or copy.');
  const plan = {...result,snapshot:planSnapshot(input,result)};
  const saved = await statement(env.DB,"UPDATE meetings SET plan_json=?,fixed_json=?,status='open',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status!='completed'",JSON.stringify(plan),JSON.stringify(input.fixedTables),Date.now(),meeting.id,meeting.revision).run();
  if (!saved.meta.changes) fail(409,'Preferences or attendance changed. Refresh and try again.');
  await audit(env.DB,member.id,'meeting.planned',meeting.id).run();
  delete plan.snapshot;
  return json({...plan,revision:meeting.revision+1,locked:false});
}

async function notifyPlan(env, meeting, plan) {
  if (!mailEnabled(env)) return;
  const users = await all(env.DB,'SELECT m.user_id,u.email,u.name FROM members m JOIN user u ON u.id=m.user_id WHERE m.notifications=1 AND m.disabled=0 AND u.emailVerified=1');
  const games = await gameList(env);
  const statements = [];
  for (const u of users) {
    const table = plan.tables.find(t=>t.memberIds.includes(u.user_id));
    if (!table) continue;
    const title = games.find(g=>g.id===table.gameId)?.title || 'your game';
    const body = `${u.name}, your game for ${meeting.id} is ${title}. We begin at 10 am.\n\nView the confirmed tables: ${env.APP_URL}\n\nYou can change meeting email preferences in your account.`;
    statements.push(statement(env.DB,"INSERT OR IGNORE INTO notification_outbox(id,user_id,meeting_id,revision,kind,subject,body,created_at) VALUES (?,?,?,?,'confirmed',?,?,?)",`${meeting.id}:${meeting.revision}:confirmed:${u.user_id}`,u.user_id,meeting.id,meeting.revision,'Your Collective game is confirmed',body,Date.now()));
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function flushNotifications(env) {
  if (!mailEnabled(env)) return;
  const pending = await all(env.DB,"SELECT n.*,u.email FROM notification_outbox n JOIN user u ON u.id=n.user_id JOIN members m ON m.user_id=n.user_id WHERE n.sent_at IS NULL AND u.emailVerified=1 AND m.notifications=1 AND m.disabled=0 AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=COALESCE(n.meeting_id,substr(n.id,1,10))) AND (n.kind!='confirmed' OR EXISTS(SELECT 1 FROM meetings x WHERE x.id=n.meeting_id AND x.revision=n.revision AND x.status='locked')) ORDER BY n.created_at LIMIT 30");
  for (const mail of pending) {
    // Providers may occasionally retry delivery; no credentials or message content are logged.
    try {
      await sendMail(env,{to:mail.email,subject:mail.subject,text:mail.body});
      await statement(env.DB,'UPDATE notification_outbox SET sent_at=? WHERE id=? AND sent_at IS NULL',Date.now(),mail.id).run();
    } catch { console.error(JSON.stringify({event:'notification.failed'})); break; }
  }
}

export async function scheduledTasks(env) {
  await statement(env.DB,'DELETE FROM request_limits WHERE expires_at<?',Date.now()).run();
  await statement(env.DB,'DELETE FROM bgg_cache WHERE expires_at<?',Date.now()).run();
  if (!mailEnabled(env)) return;
  const meeting = await ensureMeeting(env);
  const days = (Date.parse(meeting.date)-Date.parse(localDate()))/86400000;
  if (days === 7) {
    const users = await all(env.DB,'SELECT m.user_id,u.name FROM members m JOIN user u ON u.id=m.user_id WHERE m.disabled=0 AND m.notifications=1 AND u.emailVerified=1');
    if (users.length) await env.DB.batch(users.map(u=>statement(env.DB,'INSERT OR IGNORE INTO notification_outbox(id,user_id,meeting_id,subject,body,created_at) VALUES (?,?,?,?,?,?)',`${meeting.date}:reminder:${u.user_id}`,u.user_id,meeting.date,'Next Collective meeting',`${u.name}, our next meeting is ${meeting.label} at 10 am.\n\nLet the group know if you are coming: ${env.APP_URL}\n\nYour standing game choices are already saved.`,Date.now())));
  }
  await flushNotifications(env);
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!['GET','POST','PUT'].includes(request.method)) fail(405,'This method is not supported.');
  if (request.method !== 'GET') {
    if (request.headers.get('origin') !== env.APP_URL) fail(403,'This request must come from the Collective website.');
    if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403,'Cross-site requests are not accepted.');
  }
  if (path === '/api/health' && request.method === 'GET') return json({ok:true,version:'1.1.0'});
  if (path === '/api/register' && request.method === 'POST') return register(request,env,ctx);
  const auth = createAuth(env,ctx);
  if (path.startsWith('/api/auth/')) {
    const operation = path.slice('/api/auth'.length);
    if (!['/sign-in/email','/sign-out','/get-session','/reset-password','/request-password-reset','/send-verification-email','/verify-email','/change-password'].includes(operation)) fail(404,'This account action is not available.');
    if (['/request-password-reset','/send-verification-email'].includes(operation) && !mailEnabled(env)) fail(503,'Email delivery is not configured. Ask the organiser for a private recovery link.');
    if (request.method !== 'GET') {
      // Bound authentication request bodies too; preserve Better Auth's own validation.
      const body = await readJson(request);
      request = new Request(request.url,{method:request.method,headers:request.headers,body:JSON.stringify(body)});
    }
    return auth.handler(request);
  }
  if (path === '/api/bootstrap' && request.method === 'GET') return bootstrap(env,auth,request);
  const member = await getMember(env,auth,request);
  const meeting = await ensureMeeting(env, request.headers.get('x-vhbc-meeting'));
  const body = request.method === 'GET' ? {} : await readJson(request);

  if (path === '/api/attendance' && request.method === 'POST') {
    if (typeof body.coming !== 'boolean') fail(400,'Choose whether you are coming.');
    if (meeting.status === 'completed') fail(409,'This meeting has been recorded.');
    await env.DB.batch([statement(env.DB,'INSERT INTO attendance(meeting_id,user_id,coming) VALUES (?,?,?) ON CONFLICT(meeting_id,user_id) DO UPDATE SET coming=excluded.coming',meeting.id,member.id,+body.coming),invalidate(env.DB,meeting.id)]);
    return json({ok:true});
  }
  if (path === '/api/rating' && request.method === 'POST') {
    if (!['want','will','pass',null].includes(body.rating)) fail(400,'Choose Want, Will play or Pass.');
    if (!await first(env.DB,'SELECT id FROM games WHERE id=?',body.gameId ?? '')) fail(404,'This game is not available.');
    const changes = [body.rating === null ? statement(env.DB,'DELETE FROM ratings WHERE user_id=? AND game_id=?',member.id,body.gameId) : statement(env.DB,'INSERT INTO ratings(user_id,game_id,value,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,game_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',member.id,body.gameId,body.rating,Date.now()),invalidateUpcoming(env.DB)];
    if (body.rating !== 'want') changes.push(statement(env.DB,'UPDATE members SET priority_game_id=NULL WHERE user_id=? AND priority_game_id=?',member.id,body.gameId));
    await env.DB.batch(changes); return json({ok:true});
  }
  if (path === '/api/priority' && request.method === 'POST') {
    if (body.gameId !== null && !await first(env.DB,'SELECT id FROM games WHERE id=?',body.gameId ?? '')) fail(404,'This game is not available.');
    const changes = [statement(env.DB,'UPDATE members SET priority_game_id=? WHERE user_id=?',body.gameId,member.id),invalidateUpcoming(env.DB)];
    if (body.gameId) changes.push(statement(env.DB,"INSERT INTO ratings(user_id,game_id,value,updated_at) VALUES (?,?,'want',?) ON CONFLICT(user_id,game_id) DO UPDATE SET value='want',updated_at=excluded.updated_at",member.id,body.gameId,Date.now()));
    await env.DB.batch(changes); return json({ok:true});
  }
  if (path === '/api/profile' && request.method === 'POST') {
    const name = cleanText(body.name ?? member.name,60,'Display name');
    if (body.notifications !== undefined && typeof body.notifications !== 'boolean') fail(400,'Choose a notification preference.');
    await env.DB.batch([statement(env.DB,'UPDATE user SET name=?,updatedAt=? WHERE id=?',name,Date.now(),member.id),statement(env.DB,'UPDATE members SET notifications=? WHERE user_id=?',+(body.notifications ?? !!member.notifications),member.id)]);
    return json({ok:true});
  }
  if (path === '/api/games' && request.method === 'POST') {
    const offer = validateOffer(body);
    if (!offer.own && !offer.teach) fail(400,'An available game needs a copy or someone willing to teach it.');
    const title = cleanText(body.title,120,'Game title');
    const normalized = title.normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
    let bggId = body.bggId ?? null;
    if (body.bggUrl) { bggId = parseBggId(body.bggUrl); if (!bggId) fail(400,'Use a BoardGameGeek game page link.'); }
    if (bggId !== null && (!Number.isSafeInteger(bggId) || bggId <= 0)) fail(400,'This BoardGameGeek ID is invalid.');
    const existing = bggId ? await first(env.DB,'SELECT * FROM games WHERE bgg_id=? OR normalized_title=? ORDER BY bgg_id=? DESC',bggId,normalized,bggId) : await first(env.DB,'SELECT * FROM games WHERE normalized_title=?',normalized);
    if (existing && existing.bgg_id && bggId && existing.bgg_id !== bggId) fail(409,'That title already has a different BGG edition. Add an edition name to distinguish it.');
    const id = existing?.id || crypto.randomUUID();
    await env.DB.batch([
      existing ? statement(env.DB,'UPDATE games SET bgg_id=COALESCE(bgg_id,?) WHERE id=?',bggId,id) : statement(env.DB,'INSERT INTO games(id,title,normalized_title,bgg_id,created_by,created_at) VALUES (?,?,?,?,?,?)',id,title,normalized,bggId,member.id,Date.now()),
      statement(env.DB,'INSERT INTO offers(user_id,game_id,own,teach,counts_json,pitch) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,game_id) DO UPDATE SET own=excluded.own,teach=excluded.teach,counts_json=excluded.counts_json,pitch=excluded.pitch',member.id,id,+offer.own,+offer.teach,JSON.stringify(offer.counts),offer.pitch),invalidateUpcoming(env.DB),
    ]);
    return json({ok:true,gameId:id,existing:!!existing});
  }
  const offerMatch = /^\/api\/games\/([^/]+)\/offer$/.exec(path);
  if (offerMatch && request.method === 'PUT') {
    const id = offerMatch[1]; const offer = validateOffer(body);
    if (!await first(env.DB,'SELECT id FROM games WHERE id=?',id)) fail(404,'This game is not available.');
    await env.DB.batch([statement(env.DB,'INSERT INTO offers(user_id,game_id,own,teach,counts_json,pitch) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,game_id) DO UPDATE SET own=excluded.own,teach=excluded.teach,counts_json=excluded.counts_json,pitch=excluded.pitch',member.id,id,+offer.own,+offer.teach,JSON.stringify(offer.counts),offer.pitch),invalidateUpcoming(env.DB)]);
    return json({ok:true});
  }
  if (path === '/api/search' && request.method === 'GET') {
    await rateLimit(env,request,'bgg-search',10);
    const query = cleanText(url.searchParams.get('q'),100,'Search');
    if (query.length < 2) fail(400,'Type at least two characters.');
    const games = await gameList(env);
    const local = games.filter(g=>g.title.toLowerCase().includes(query.toLowerCase())).map(g=>({title:g.title,bggId:g.bggId,existingGameId:g.id,year:null}));
    const external = await searchBgg(query,env);
    const results = [...local,...external.results.filter(g=>!local.some(l=>l.bggId===g.bggId)).map(g=>({...g,existingGameId:games.find(l=>l.bggId===g.bggId)?.id ?? null}))];
    return json({...external,results});
  }
  if (!path.startsWith('/api/admin/')) fail(404,'This action could not be found.');
  if (member.role !== 'admin') fail(403,'Only the organiser can use this action.');
  const meetingAction = await manageMeetings(request, env, member, body);
  if (meetingAction) return meetingAction;

  if (path === '/api/admin/invites' && request.method === 'POST') {
    const email = emailAddress(body.email);
    if (await first(env.DB,'SELECT m.user_id FROM members m JOIN user u ON u.id=m.user_id WHERE u.email=?',email)) fail(409,'That email already belongs to a member.');
    const token = randomToken(); const hash = await tokenHash(token);
    await env.DB.batch([statement(env.DB,'UPDATE invites SET expires_at=? WHERE email=? AND used_at IS NULL',Date.now(),email),statement(env.DB,"INSERT INTO invites(token_hash,email,role,expires_at,created_by,created_at) VALUES (?,?,'member',?,?,?)",hash,email,Date.now()+14*86400000,member.id,Date.now()),audit(env.DB,member.id,'member.invited')]);
    return json({url:`${env.APP_URL}/#invite=${token}`,expiresInDays:14});
  }
  if (path === '/api/admin/invites' && request.method === 'GET') return json({invites:await all(env.DB,'SELECT email,expires_at AS expiresAt,used_at AS usedAt FROM invites ORDER BY created_at DESC LIMIT 50')});
  if (path === '/api/admin/reset' && request.method === 'POST') {
    const target = await first(env.DB,'SELECT u.email FROM user u JOIN members m ON m.user_id=u.id WHERE u.id=? AND m.disabled=0',body.userId ?? '');
    if (!target) fail(404,'Member not found.');
    let resetUrl;
    const recoveryAuth = createAuth(env,null,null,url=>{resetUrl=url;});
    await recoveryAuth.api.requestPasswordReset({body:{email:target.email,redirectTo:env.APP_URL},headers:request.headers});
    if (!resetUrl) fail(500,'A recovery link could not be created.');
    await audit(env.DB,member.id,'member.recovery-created').run();
    return json({url:resetUrl,expiresInMinutes:30});
  }
  if (path === '/api/admin/plan' && request.method === 'POST') {
    if (meeting.status === 'completed') fail(409,'This meeting is already recorded.');
    return savePlan(env,member,meeting,await planningInput(env,meeting));
  }
  if (path === '/api/admin/fixed' && request.method === 'PUT') {
    if (!Array.isArray(body.tables) || body.tables.length > 8) fail(400,'Provide a valid list of pre-arranged tables.');
    if (meeting.status === 'completed') fail(409,'This meeting is already recorded.');
    const input = await planningInput(env,meeting);
    for (const t of body.tables) if (!t || typeof t.gameId !== 'string' || !Array.isArray(t.memberIds) || t.memberIds.some(id=>typeof id!=='string') || typeof t.teacherId!=='string' || typeof t.copyOwnerId!=='string') fail(400,'Each table needs a game, players, a teacher and a copy.');
    input.fixedTables = body.tables;
    return savePlan(env,member,meeting,input,body.tables);
  }
  if (path === '/api/admin/lock' && request.method === 'POST') {
    const target = body.meetingDate ? await first(env.DB,'SELECT * FROM meetings WHERE id=? AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)',cleanText(body.meetingDate,10,'Meeting date')) : meeting;
    if (!target || !target.plan_json || target.revision !== body.revision || target.status !== 'open') fail(409,'The plan has changed. Refresh it before confirming.');
    const plan = JSON.parse(target.plan_json);
    if (plan.unassignedMemberIds.length) fail(422,'Some attendees do not yet have a game. Resolve the unmatched players before confirming.');
    const saved = await statement(env.DB,"UPDATE meetings SET status='locked',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='open'",Date.now(),target.id,target.revision).run();
    if (!saved.meta.changes) fail(409,'The plan has changed. Refresh and try again.');
    await audit(env.DB,member.id,'meeting.confirmed',target.id).run();
    if (target.id >= localDate()) ctx.waitUntil(notifyPlan(env,{...target,revision:target.revision+1},plan).then(()=>flushNotifications(env)));
    return json({ok:true});
  }
  if (path === '/api/admin/meeting' && request.method === 'GET') {
    const date = url.searchParams.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(400,'Choose a meeting date.');
    const row = await first(env.DB,'SELECT * FROM meetings WHERE id=? AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)',date);
    if (!row) fail(404,'Meeting not found.');
    const plan = row.plan_json ? JSON.parse(row.plan_json) : null;
    if (plan) { delete plan.snapshot; plan.revision=row.revision; plan.locked=row.status==='locked'; }
    return json({meeting:{date,status:row.status},plan});
  }
  if (path === '/api/admin/complete' && request.method === 'POST') {
    const target = body.meetingDate ? await first(env.DB,'SELECT * FROM meetings WHERE id=? AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)',cleanText(body.meetingDate,10,'Meeting date')) : meeting;
    if (!target || !target.plan_json || target.revision !== body.revision || target.status !== 'locked') fail(409,'Confirm the current tables before recording what was played.');
    if (target.id > localDate()) fail(422,'Record actual play on the meeting date or afterwards.');
    const plan = JSON.parse(target.plan_json);
    if (!plan.tables.length) fail(422,'There are no games to record.');
    const now = Date.now();
    // A conditional parent-state check on every history write prevents stale concurrent completion.
    const changes = plan.tables.flatMap(t=>t.memberIds.map(id=>{const s=plan.snapshot[id];return statement(env.DB,"INSERT INTO history(meeting_id,user_id,game_id,rating,priority_game_id,priority_feasible,fixed) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM meetings WHERE id=? AND revision=? AND status='locked')",target.id,id,t.gameId,s.ratings[t.gameId],s.priorityGameId ?? null,+s.priorityFeasible,+!!t.fixed,target.id,target.revision);}));
    changes.push(statement(env.DB,"UPDATE meetings SET status='completed',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='locked'",now,target.id,target.revision),audit(env.DB,member.id,'meeting.recorded',target.id));
    const results = await env.DB.batch(changes);
    if (!results.at(-2).meta.changes) fail(409,'This meeting has already been recorded or changed.');
    if (target.id !== meeting.id) await invalidate(env.DB,meeting.id).run();
    return json({ok:true});
  }
  fail(404,'This organiser action could not be found.');
}
