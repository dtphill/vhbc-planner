import {normalizeSizePreferences, SIZE_BUCKETS, TABLE_SIZE_POLICY} from './table-size-policy.mjs';
export const SIZE_VERSION = '1.6.0';
export const SIZE_API = '/api/meeting-size-preferences';
const HEADERS = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'};
const json = (body, status=200) => Response.json(body,{status,headers:HEADERS});
class SizeError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail = (status,message) => {throw new SizeError(status,message);};
export const LIVE_PEOPLE_QUERY = 'SELECT m.user_id AS id,u.name,m.priority_game_id AS priorityGameId FROM members m JOIN user u ON u.id=m.user_id JOIN attendance a ON a.user_id=m.user_id WHERE m.disabled=0 AND a.meeting_id=? AND a.coming=1 ORDER BY m.user_id';
export const PRIVATE_PEOPLE_QUERY = 'SELECT m.user_id AS id,u.name,m.priority_game_id AS priorityGameId FROM members m JOIN user u ON u.id=m.user_id WHERE m.disabled=0 ORDER BY m.user_id';
const QUERIES = new Map([
  [LIVE_PEOPLE_QUERY, LIVE_PEOPLE_QUERY.replace(' FROM members', ",COALESCE((SELECT p.preferences_json FROM meeting_size_preferences p WHERE p.meeting_id=a.meeting_id AND p.user_id=m.user_id),'[]') AS tableSizePreferencesJson FROM members")],
  [PRIVATE_PEOPLE_QUERY, PRIVATE_PEOPLE_QUERY.replace(' FROM members', ",COALESCE((SELECT json_group_object(p.meeting_id,json(p.preferences_json)) FROM meeting_size_preferences p WHERE p.user_id=m.user_id),'{}') AS tableSizePreferencesByMeeting FROM members")],
]);
/** Add meeting-scoped inputs to the two existing planning snapshots. No extra
 * queries in the solver, no account-query changes, no replacement auth adapter. */
export function sizePreferencesSql(sql) {return QUERIES.get(sql)||sql;}
export function sizePreferencesDb(db) {
  return new Proxy(db,{get(target,key){
    if(key==='prepare')return sql=>target.prepare(sizePreferencesSql(sql));
    const value=Reflect.get(target,key,target);
    return typeof value==='function'&&key!=='constructor'?value.bind(target):value;
  }});
}
export function validateSizeChoice(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['meetingDate','preferences'].includes(k)))fail(400,'Choose a table-size preference for this meeting.');
  if(typeof body.meetingDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.meetingDate))fail(400,'Choose the current meeting.');
  if(!Array.isArray(body.preferences)||body.preferences.length>3||body.preferences.some(v=>!SIZE_BUCKETS.includes(v)))fail(400,'Choose 2 players, 3–4 players, 5+ players, or no preference.');
  return {meetingDate:body.meetingDate,preferences:normalizeSizePreferences(body.preferences)};
}
async function readBody(request) {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail(415,'Send JSON with this request.');
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();fail(413,'This preference request is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'Send valid preference details.');}
}
export async function getSizeChoice(env, userId, meetingDate) {
  const row=await env.DB.prepare('SELECT preferences_json FROM meeting_size_preferences WHERE meeting_id=? AND user_id=?').bind(meetingDate,userId).first();
  return normalizeSizePreferences(row?.preferences_json);
}
export async function saveSizeChoice(env, user, data, body) {
  const {meetingDate,preferences}=validateSizeChoice(body);
  if(!user?.id)fail(401,'Please sign in.');
  if(data.meeting?.date!==meetingDate)fail(409,'The next meeting has changed. Refresh before saving.');
  if(!data.attendance?.coming)fail(409,'Mark yourself as coming before choosing a table size.');
  const row=await env.DB.prepare('SELECT id,status,revision FROM meetings WHERE id=? AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=meetings.id)').bind(meetingDate).first();
  if(!row)fail(409,'This meeting has been removed. Refresh the planner.');
  if(row.status!=='open')fail(409,'These tables are confirmed or the meeting is completed. Ask the organiser about changes.');
  if(JSON.stringify(await getSizeChoice(env,user.id,meetingDate))===JSON.stringify(preferences))return {ok:true,meetingDate,preferences,changed:false};
  const changeId=crypto.randomUUID(),stamp=Date.now(),encoded=JSON.stringify(preferences);
  // Both statements run in one D1 transaction. The unique change token prevents
  // invalidating a plan unless this exact authorised preference write succeeded.
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO meeting_size_preferences(meeting_id,user_id,preferences_json,change_id,updated_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM meetings mt JOIN attendance a ON a.meeting_id=mt.id
      JOIN members m ON m.user_id=a.user_id WHERE mt.id=? AND mt.revision=? AND mt.status='open'
      AND a.user_id=? AND a.coming=1 AND m.disabled=0
      AND NOT EXISTS(SELECT 1 FROM meeting_exclusions x WHERE x.meeting_id=mt.id))
      ON CONFLICT(meeting_id,user_id) DO UPDATE SET preferences_json=excluded.preferences_json,change_id=excluded.change_id,updated_at=excluded.updated_at`)
      .bind(meetingDate,user.id,encoded,changeId,stamp,meetingDate,row.revision,user.id),
    env.DB.prepare(`UPDATE meetings SET plan_json=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND status='open' AND EXISTS(SELECT 1 FROM meeting_size_preferences p
      WHERE p.meeting_id=meetings.id AND p.user_id=? AND p.change_id=?)`)
      .bind(stamp,meetingDate,row.revision,user.id,changeId),
  ]);
  if(result.some(r=>r.success===false)||!result[0].meta?.changes||!result[1].meta?.changes)fail(409,'Attendance or meeting details changed. Refresh and try again.');
  return {ok:true,meetingDate,preferences,changed:true};
}
export function withMeetingSizePreferences(base,assets) {
  return {...base,async fetch(request,env,ctx){
    const path=new URL(request.url).pathname;
    try{
      if(['/media/meeting-size.js','/media/meeting-size.css'].includes(path)){
        if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
        const js=path.endsWith('.js');return new Response(request.method==='HEAD'?null:js?assets.javascript:assets.css,{headers:{...HEADERS,'Content-Type':js?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
      }
      const scoped={...env,DB:sizePreferencesDb(env.DB)};
      if(path===SIZE_API){
        if(request.method!=='POST')return json({error:'Use POST to save a preference.'},405);
        if(request.headers.get('origin')!==env.APP_URL||request.headers.get('sec-fetch-site')==='cross-site')fail(403,'Use the Collective website to save a preference.');
        const body=validateSizeChoice(await readBody(request));
        const response=await base.fetch(new Request(new URL('/api/bootstrap',request.url),{headers:request.headers}),scoped,ctx);
        if(!response.ok)fail(503,'The meeting could not be loaded. Please try again.');
        const data=await response.json();if(!data.user)fail(401,'Please sign in.');
        return json(await saveSizeChoice(scoped,data.user,data,body));
      }
      const response=await base.fetch(request,scoped,ctx);
      if(path==='/api/bootstrap'&&response.ok){
        const data=await response.json();
        if(data.user)data.tableSizeChoice={meetingDate:data.meeting.date,preferences:await getSizeChoice(scoped,data.user.id,data.meeting.date),editable:data.meeting.status==='open'&&!!data.attendance?.coming};
        return json(data);
      }
      if(path==='/api/health'&&response.ok)return json({...await response.json(),tableSizePreferences:SIZE_VERSION,tableSizePolicy:TABLE_SIZE_POLICY});
      if((path==='/'||path==='/admin/planner-test')&&request.method==='GET'&&response.ok&&response.headers.get('content-type')?.includes('text/html')){
        const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');h.set('Cache-Control',path.startsWith('/admin/')?'private, no-store':'no-cache');
        const html=(await response.text()).replace('</head>',`<link rel="stylesheet" href="/media/meeting-size.css?v=${SIZE_VERSION}"></head>`).replace('<script ',`<script type="module" src="/media/meeting-size.js?v=${SIZE_VERSION}"></script><script `);
        return new Response(html,{status:response.status,headers:h});
      }
      return response;
    }catch(error){
      if(!(error instanceof SizeError))console.error(JSON.stringify({event:'meeting.size-preferences.failed',name:error?.name||'Error'}));
      return json({error:error instanceof SizeError?error.message:'Meeting preferences could not be loaded. Please refresh and try again.'},error instanceof SizeError?error.status:503);
    }
  }};
}
