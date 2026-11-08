import {allocateTables} from './allocation.mjs';
import {localDate, fourthSunday, TIME_ZONE} from './calendar.mjs';

export const PRIVATE_PLANNER_VERSION = '1.4.2';
export const PRIVATE_PAGE = '/admin/planner-test';
export const PRIVATE_API = '/api/admin/planner-test';
const headers = {
  'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer',
  'X-Robots-Tag':'noindex, nofollow',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (data, status=200) => Response.json(data, {status, headers});
class PrivatePlannerError extends Error {
  constructor(status, message) { super(message); this.status=status; }
}
const fail = (status, message) => { throw new PrivatePlannerError(status, message); };

/** Defence in depth: this path cannot prepare mutating SQL, including in auth. */
export function readOnlyDatabase(db) {
  const actual = new WeakMap();
  const wrap = statement => {
    const view = {
      bind(...values) { return wrap(statement.bind(...values)); },
      first(...args) { return statement.first(...args); },
      all(...args) { return statement.all(...args); },
      raw(...args) { return statement.raw(...args); },
      run(...args) { return statement.run(...args); }, // The statement is SELECT-only.
    };
    actual.set(view, statement);
    return Object.freeze(view);
  };
  const methods = {
    prepare(sql) {
      // Better Auth checks index metadata while validating its schema. Translate
      // only these two read-only PRAGMAs, not arbitrary PRAGMA commands.
      const inspection = typeof sql==='string' && /^\s*PRAGMA\s+(index_list|index_info)\(\s*('(?:[^'\u0000-\u001f;]|'')*')\s*\)\s*$/i.exec(sql);
      if (inspection) sql='SELECT * FROM pragma_'+inspection[1].toLowerCase()+'('+inspection[2]+')';
      if (typeof sql!=='string' || !/^\s*SELECT\b/i.test(sql) || /;/.test(sql)) {
        throw new Error('Private planner permits SELECT statements only.');
      }
      return wrap(db.prepare(sql));
    },
    batch(statements) {
      if (!Array.isArray(statements) || statements.some(s=>!actual.has(s))) {
        throw new Error('Private planner received an unverified statement.');
      }
      return db.batch(statements.map(s=>actual.get(s)));
    },
  };
  // Preserve D1's identity/prototype for the existing authentication adapter.
  return new Proxy(db, {get(target,key) {
    if (Object.hasOwn(methods,key)) return methods[key];
    const value=Reflect.get(target,key,target);
    if (key==='withSession' && typeof value==='function') return (...args)=>readOnlyDatabase(value.apply(target,args));
    if (typeof value==='function' && key!=='constructor') return ()=>{throw new Error('Database operation is not available in the private planner.');};
    return value;
  }});
}

async function requireAdmin(request, env, ctx, sessionFor) {
  // The real server-side session validator is injected by the entry module.
  // It disables refresh and bypasses HTTP auth rate-limit writes. The D1 guard
  // still rejects any unexpected mutation, including expired-session cleanup.
  let auth;
  try { auth=await sessionFor(request,env); }
  catch { fail(503,'Your sign-in could not be checked. Please try again. No meeting data has changed.'); }
  if (!auth?.user?.id || !auth?.session) fail(401,'Please sign in as an organiser.');
  const member = await env.DB.prepare('SELECT user_id,role,disabled FROM members WHERE user_id=?').bind(auth.user.id).first();
  if (!member || member.disabled || member.role!=='admin') fail(403,'Only organisers can use the private algorithm test.');
  return member;
}

function chooseMeeting(meetings, exclusions, today) {
  const removed = new Set(exclusions.map(row=>row.meeting_id));
  const [year, month] = today.split('-').map(Number);
  let regular;
  for (let offset=0; offset<removed.size+3; offset++) {
    const date=fourthSunday(year,month-1+offset);
    if (date>=today && !removed.has(date)) { regular=date; break; }
  }
  if (!regular) fail(409,'The next meeting date could not be determined.');
  const existing=meetings.filter(m=>m.id>=today && !removed.has(m.id)).sort((a,b)=>a.id.localeCompare(b.id))[0];
  const date=existing && existing.id<=regular ? existing.id : regular;
  const row=meetings.find(m=>m.id===date) || {id:date,status:'open',revision:0,fixed_json:'[]'};
  return {...row, date, label:new Intl.DateTimeFormat('en-AU', {
    timeZone:'UTC',weekday:'long',day:'numeric',month:'long',year:'numeric',
  }).format(new Date(date+'T00:00:00Z')), timeZone:TIME_ZONE};
}

/** A single read transaction; never calls ensureMeeting or savePlan. */
export async function readPrivateInput(env, now=new Date()) {
  const db=readOnlyDatabase(env.DB), today=localDate(now);
  const queries=[
    db.prepare('SELECT id,status,revision,fixed_json FROM meetings WHERE id>=? ORDER BY id').bind(today),
    db.prepare('SELECT meeting_id FROM meeting_exclusions WHERE meeting_id>=?').bind(today),
    db.prepare('SELECT m.user_id AS id,u.name,m.priority_game_id AS priorityGameId FROM members m JOIN user u ON u.id=m.user_id WHERE m.disabled=0 ORDER BY m.user_id'),
    db.prepare('SELECT meeting_id,user_id FROM attendance WHERE coming=1 AND meeting_id>=?').bind(today),
    db.prepare('SELECT id,title,bgg_id FROM games WHERE archived_at IS NULL ORDER BY title COLLATE NOCASE'),
    db.prepare('SELECT o.*,u.name FROM offers o JOIN user u ON u.id=o.user_id JOIN members m ON m.user_id=o.user_id JOIN games g ON g.id=o.game_id WHERE m.disabled=0 AND g.archived_at IS NULL'),
    db.prepare('SELECT user_id,game_id,value FROM ratings'),
    db.prepare('SELECT meeting_id,user_id,game_id,rating,priority_game_id,priority_feasible,fixed FROM history ORDER BY meeting_id'),
  ];
  const results=await db.batch(queries);
  if (results.some(r=>r.success===false || !Array.isArray(r.results))) fail(503,'The latest planning data could not be read.');
  const [meetings,exclusions,people,attendance,rows,offers,ratings,history]=results.map(r=>r.results);
  const meeting=chooseMeeting(meetings,exclusions,today);
  const attending=new Set(attendance.filter(a=>a.meeting_id===meeting.id).map(a=>a.user_id));
  const games=rows.map(g=>({id:g.id,title:g.title,bggId:g.bgg_id,offers:offers.filter(o=>o.game_id===g.id).map(o=>({
    userId:o.user_id,name:o.name,own:!!o.own,teach:!!o.teach,counts:JSON.parse(o.counts_json),pitch:o.pitch,
  }))}));
  // Keep these mappings identical to planningInput in src/api.mjs. The live
  // solver, including its history window and tie-break, is imported unchanged.
  const members=people.filter(p=>attending.has(p.id)).map(p=>({...p,
    ratings:Object.fromEntries(ratings.filter(r=>r.user_id===p.id).map(r=>[r.game_id,r.value])),
    restrictions:Object.fromEntries(games.flatMap(g=>g.offers.filter(o=>o.userId===p.id).map(o=>[g.id,o.counts]))),
    history:history.filter(h=>h.user_id===p.id).slice(-24).map(h=>({gameId:h.game_id,rating:h.rating,
      priorityGameId:h.priority_game_id,priorityFeasible:!!h.priority_feasible,fixed:!!h.fixed})),
  }));
  if (members.length>12) fail(422,'The live planner currently supports up to 12 attendees. This private test uses the same limit.');
  const fixedTables=JSON.parse(meeting.fixed_json);
  if (!Array.isArray(fixedTables)) fail(409,'The saved reservations need to be checked by an organiser.');
  return {meeting, input:{members,games,fixedTables,tieBreakSeed:meeting.id}};
}

export function describePrivateResult(meeting, input, result, now=new Date()) {
  const memberById=new Map(input.members.map(m=>[m.id,m]));
  const gameById=new Map(input.games.map(g=>[g.id,g]));
  const assignments=new Map(result.tables.flatMap(t=>t.memberIds.map(id=>[id,t])));
  const people=input.members.map(m=>{
    const table=assignments.get(m.id);
    const priority=gameById.get(m.priorityGameId);
    const activePriority=priority && m.ratings[priority.id]==='want';
    return {id:m.id,name:m.name,gameId:table?.gameId??null,gameTitle:gameById.get(table?.gameId)?.title??null,
      preference:table ? m.ratings[table.gameId] : null, prearranged:!!table?.fixed,
      priorityTitle:activePriority?priority.title:null,
      priorityMet:!!activePriority && table?.gameId===priority.id,
      priorityFeasible:!!activePriority && result.feasiblePriorityMemberIds.includes(m.id),
    };
  });
  return {
    private:true,persisted:false,generatedAt:now.toISOString(),
    meeting:{date:meeting.id,label:meeting.label,status:meeting.status,revision:meeting.revision},
    score:result.score,tieBreak:result.tieBreak??null,
    summary:{attendees:input.members.length,seated:result.score.seated,
      want:people.filter(p=>p.preference==='want').length,will:people.filter(p=>p.preference==='will').length,
      priorityMet:people.filter(p=>p.priorityMet).length,unseated:result.unassignedMemberIds.length,
      reservations:input.fixedTables.length},
    tables:result.tables.map(t=>({...t,title:gameById.get(t.gameId)?.title||'Unavailable game',
      teacherName:memberById.get(t.teacherId)?.name||'Unavailable member',
      copyOwnerName:memberById.get(t.copyOwnerId)?.name||'Unavailable member',
      players:t.memberIds.map(id=>people.find(p=>p.id===id)),
    })),
    people,unassigned:people.filter(p=>result.unassignedMemberIds.includes(p.id)),warnings:result.warnings,
  };
}

async function emptyRequest(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(415,'Send JSON with this request.');
  const reader=request.body?.getReader();let length=0;const chunks=[];
  if (reader) {
    try { for (;;) { const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>1024){await reader.cancel();fail(413,'This test request is too large.');}chunks.push(value); }
    } finally { reader.releaseLock(); }
  }
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{fail(400,'Send an empty JSON object.');}
  if (!body || Array.isArray(body) || typeof body!=='object' || Object.keys(body).length) {
    fail(400,'The private test uses current meeting data; it does not accept changes or a new tie-break seed.');
  }
}

export async function privateTestResponse(request, env, ctx, sessionFor, now=new Date()) {
  if (request.method!=='POST') return json({error:'Use POST to run a private test.'},405);
  try {
    if(request.headers.get('origin')!==env.APP_URL || request.headers.get('sec-fetch-site')==='cross-site') {
      fail(403,'Use the Collective website for this test.');
    }
    const safeEnv={...env,DB:readOnlyDatabase(env.DB)};
    await requireAdmin(request,safeEnv,ctx,sessionFor);
    await emptyRequest(request);
    const {meeting,input}=await readPrivateInput(safeEnv,now);
    return json(describePrivateResult(meeting,input,allocateTables(input),now));
  } catch(error) {
    return json({error:error instanceof PrivatePlannerError ? error.message : 'The private test could not run. No meeting data has been changed.'},error instanceof PrivatePlannerError ? error.status : 503);
  }
}

function page(message='') {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Private algorithm test · VHBC</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/media/private-planner.css?v=${PRIVATE_PLANNER_VERSION}"></head><body><div id="vhbc-monthly-planner"><header class="mq-header"><p class="mq-brand">Victorian Historical Boardgaming Collective</p><p class="mq-muted">Organiser tools</p></header><main class="mq-main" id="private-planner-root"><a href="/">Return to the planner</a><div class="ppt-heading"><span class="ppt-private">Private · administrator only</span><h1>Algorithm test</h1></div>${message?`<p role="alert">${message}</p>`:`<p>Seat the next meeting’s current attendees using their saved preferences, teachers, copies and existing pre-arranged tables.</p><p class="ppt-boundary"><strong>Nothing is published or saved.</strong> This does not change proposed or confirmed tables, attendance, ratings, play history or notifications.</p><button type="button" class="mq-primary" id="ppt-run">Run private test</button><p id="ppt-status" class="mq-muted" role="status" aria-live="polite">Each run reads the latest data. With the same meeting and inputs, the result stays the same.</p><div id="ppt-results"></div><script type="module" src="/media/private-planner.js?v=${PRIVATE_PLANNER_VERSION}"></script>`}</main></div></body></html>`;
}

export function withPrivatePlanner(base, assets, sessionFor) {
  return {...base,async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname;
    if(path===PRIVATE_API)return privateTestResponse(request,env,ctx,sessionFor);
    if(path===PRIVATE_PAGE){
      if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
      try {
        await requireAdmin(request,{...env,DB:readOnlyDatabase(env.DB)},ctx,sessionFor);
        return new Response(request.method==='HEAD'?null:page(),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      } catch(error) {
        const status=error instanceof PrivatePlannerError?error.status:503;
        // Fixed text only: never interpolate a database value or a thrown error.
        return new Response(request.method==='HEAD'?null:page(status===401 ? 'Sign in with an active organiser account to access this private area.' : status===403 ? 'Only active organisers can use the private algorithm test.' : 'Your sign-in could not be checked. Please try again. No meeting data has changed.'),{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      }
    }
    if(['/media/private-planner.js','/media/private-planner.css'].includes(path)){
      if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
      const js=path.endsWith('.js');
      return new Response(request.method==='HEAD'?null:js?assets.javascript:assets.css,{headers:{...headers,
        'Content-Type':js?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
    }
    const response=await base.fetch(request,env,ctx);
    if(path==='/api/health'&&response.ok)return json({...await response.json(),privatePlanner:PRIVATE_PLANNER_VERSION});
    if(path==='/'&&request.method==='GET'&&response.ok&&response.headers.get('content-type')?.includes('text/html')){
      const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');
      const html=(await response.text()).replace('</head>',`<link rel="stylesheet" href="/media/private-planner.css?v=${PRIVATE_PLANNER_VERSION}"></head>`).replace('</body>',`<script type="module" src="/media/private-planner.js?v=${PRIVATE_PLANNER_VERSION}"></script></body>`);
      return new Response(html,{status:response.status,headers:h});
    }
    return response;
  }};
}
