import {allocateTables} from './allocation.mjs';
import {allocationBonuses, ROTATION_POLICY} from './rotation-policy.mjs';
import {fourthSunday} from './calendar.mjs';
import {PRIVATE_PAGE, readOnlyDatabase, readPrivateInput, describePrivateResult} from './private-planner.mjs';

export const SERIES_VERSION = '1.5.0';
export const SERIES_API = '/api/admin/planner-series';
const HEADERS = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'};
const json = (body,status=200) => Response.json(body,{status,headers:HEADERS});
export class SeriesError extends Error { constructor(status,message){super(message);this.status=status;} }

export function validateSeriesOptions(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!['meetings','clearFulfilled'].includes(k))) {
    throw new SeriesError(400,'Choose only the number of meetings and whether to clear fulfilled priorities.');
  }
  const meetings=value.meetings??6, clearFulfilled=value.clearFulfilled??false;
  if (!Number.isInteger(meetings)||meetings<2||meetings>12) throw new SeriesError(400,'Choose between 2 and 12 dummy meetings.');
  if (typeof clearFulfilled!=='boolean') throw new SeriesError(400,'Choose a valid priority setting.');
  return {meetings,clearFulfilled};
}

// Use exactly the same history policy as the live allocator, not a duplicated formula.
export function allocationMemberBonuses(member, games) {
  const candidate = member.priorityGameId;
  const available = candidate != null && games.some(g => String(g.id) === String(candidate));
  return allocationBonuses(member, available ? candidate : null);
}

async function readOptions(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new SeriesError(415,'Send JSON with this request.');
  const reader=request.body?.getReader(),parts=[];let length=0;
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1024){await reader.cancel();throw new SeriesError(413,'This test request is too large.');}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  let value;try{value=JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{throw new SeriesError(400,'Send valid test options.');}
  return validateSeriesOptions(value);
}

/** Pure sandbox: every history/priority change affects a deep copy, never the supplied snapshot. */
export function simulateMeetingSeries(snapshot, options={}, now=new Date()) {
  const settings=validateSeriesOptions(options);
  const {meeting,input:original}=snapshot;
  if(original.members.length>12)throw new SeriesError(422,'This test uses the live planner limit of 12 attendees.');
  const input=structuredClone(original), rounds=[];
  const start=meeting.id;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||new Date(start+'T00:00:00Z').toISOString().slice(0,10)!==start)throw new SeriesError(409,'The starting meeting date is invalid.');
  const [year,month]=start.split('-').map(Number);
  const initialPriorities=new Map(input.members.map(m=>[m.id,m.priorityGameId]));
  let stoppedReason=null;
  if(!input.members.length)stoppedReason='No one is marked as coming to the next meeting. No dummy plays were generated.';
  for(let index=0;index<settings.meetings && !stoppedReason;index++) {
    const date=index===0?start:fourthSunday(year,month-1+index);
    input.tieBreakSeed=date;
    // Reservations belong to the real next meeting only, not every later month.
    if(index>0)input.fixedTables=[];
    const current={...meeting,id:date,date,label:new Intl.DateTimeFormat('en-AU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(date+'T00:00:00Z'))};
    const before=new Map(input.members.map(m=>[m.id,allocationMemberBonuses(m,input.games)]));
    const allocation=allocateTables(input);
    const result=describePrivateResult(current,input,allocation,now);
    const complete=allocation.unassignedMemberIds.length===0 && allocation.warnings.length===0;
    result.round=index+1;result.simulated=true;result.advanced=complete;
    const byId=new Map(result.people.map(p=>[p.id,p]));
    if(complete){
      for(const member of input.members){
        const person=byId.get(member.id);
        member.history=[...(member.history||[]),{
          gameId:person.gameId,rating:person.preference,priorityGameId:member.priorityGameId??null,
          priorityFeasible:allocation.feasiblePriorityMemberIds.includes(member.id),fixed:person.prearranged,
        }].slice(-24);
        if(settings.clearFulfilled&&person.priorityMet)member.priorityGameId=null;
      }
    }
    for(const member of input.members){
      const person=byId.get(member.id);person.before=before.get(member.id);person.after=allocationMemberBonuses(member,input.games);
      person.priorityCleared=complete&&settings.clearFulfilled&&person.priorityMet;
    }
    rounds.push(result);
    if(!complete)stoppedReason='Stopped at dummy meeting '+(index+1)+': the plan has unseated players or warnings. It cannot be treated as a completed meeting, so no history from this round was carried forward.';
  }
  const totals=original.members.map(m=>{
    const plays=rounds.filter(r=>r.advanced).map(r=>r.people.find(p=>p.id===m.id));
    return {id:m.id,name:m.name,initialPriority:original.games.find(g=>g.id===initialPriorities.get(m.id))?.title??null,
      played:plays.length,want:plays.filter(p=>p.preference==='want').length,will:plays.filter(p=>p.preference==='will').length,
      priorityMet:plays.filter(p=>p.priorityMet).length,firstPriorityRound:rounds.find(r=>r.advanced&&r.people.find(p=>p.id===m.id)?.priorityMet)?.round??null};
  });
  return {private:true,persisted:false,simulation:true,version:SERIES_VERSION,generatedAt:now.toISOString(),
    sourceMeeting:{date:start,revision:meeting.revision,status:meeting.status},settings,requestedMeetings:settings.meetings,
    completedMeetings:rounds.filter(r=>r.advanced).length,stoppedReason,rounds,totals};
}

export async function seriesResponse(request,env,ctx,base,now=new Date()) {
  if(request.method!=='POST')return json({error:'Use POST to simulate meetings.'},405);
  if(request.headers.get('origin')!==env.APP_URL||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Use the Collective website for this test.'},403);
  try{
    // Delegate to the existing protected page: signed session + current admin role,
    // read-only schema inspection, no session refresh or rate-limit database writes.
    const access=await base.fetch(new Request(new URL(PRIVATE_PAGE,env.APP_URL),{method:'HEAD',headers:request.headers}),env,ctx);
    if(access.status!==200)return json({error:access.status===401?'Please sign in as an organiser.':access.status===403?'Only active organisers can run simulations.':'Your sign-in could not be checked. Please try again.'},[401,403].includes(access.status)?access.status:503);
    const options=await readOptions(request);
    const snapshot=await readPrivateInput({...env,DB:readOnlyDatabase(env.DB)},now);
    return json(simulateMeetingSeries(snapshot,options,now));
  }catch(error){return json({error:error instanceof SeriesError?error.message:'The simulation could not finish. No meeting data has changed.'},error instanceof SeriesError?error.status:503);}
}

export function withPlannerSeries(base,assets) {
  return {...base,async fetch(request,env,ctx){
    const path=new URL(request.url).pathname;
    if(path===SERIES_API)return seriesResponse(request,env,ctx,base);
    if(['/media/planner-series.js','/media/planner-series.css'].includes(path)){
      if(!['GET','HEAD'].includes(request.method))return json({error:'Use GET.'},405);
      const js=path.endsWith('.js');return new Response(request.method==='HEAD'?null:js?assets.javascript:assets.css,{headers:{...HEADERS,'Content-Type':js?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'public, max-age=300'}});
    }
    const response=await base.fetch(request,env,ctx);
    if(path==='/api/health'&&response.ok)return json({...await response.json(),plannerSeries:SERIES_VERSION,rotationPolicy:ROTATION_POLICY});
    if(path===PRIVATE_PAGE&&request.method==='GET'&&response.ok&&response.headers.get('content-type')?.includes('text/html')){
      const h=new Headers(response.headers);h.delete('Content-Length');h.delete('ETag');h.set('Cache-Control','private, no-store');
      const html=(await response.text()).replaceAll('/media/private-planner.js?v=1.4.2','/media/private-planner.js?v='+SERIES_VERSION).replace('</head>',`<link rel="stylesheet" href="/media/planner-series.css?v=${SERIES_VERSION}"></head>`).replace('</body>',`<script type="module" src="/media/planner-series.js?v=${SERIES_VERSION}"></script></body>`);
      return new Response(html,{status:response.status,headers:h});
    }
    return response;
  }};
}
