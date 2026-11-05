import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureMeeting, listMeetings, manageMeetings, validateMeetingDate, describeMeeting} from '../src/meetings.mjs';

const now = new Date('2026-11-05T01:00:00Z');
const admin = {id:'admin',role:'admin'};
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_auth.sql','0002_app.sql','0003_meeting_management.sql']) sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const db = {
    prepare(sql) { return {
      args:[], bind(...args) { this.args=args; return this; },
      async first() { return sqlite.prepare(sql).get(...this.args) ?? null; },
      async all() { return {results:sqlite.prepare(sql).all(...this.args)}; },
      async run() { const r=sqlite.prepare(sql).run(...this.args); return {meta:{changes:Number(r.changes)}}; },
    }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results=[]; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return {env:{DB:db},sqlite};
}
async function action(env, path, body, member=admin, method='POST') {
  return manageMeetings(new Request('https://collective.test/api/admin/meetings'+path,{method}),env,member,body,now);
}
async function removeCurrent(env) {
  const meeting=await ensureMeeting(env,null,now);
  await action(env,'/remove',{date:meeting.id,revision:meeting.revision});
  return meeting;
}
const rejectsStatus = (work,status) => assert.rejects(work,error=>error.status===status);

test('validate real dates and reject malformed or impossible dates',()=>{
  assert.equal(validateMeetingDate('2028-02-29'),'2028-02-29');
  for (const value of ['2026-02-29','2026-02-31','2026-13-01','2026-1-01','2026-11-05x',null,42,'1999-12-31']) assert.throws(()=>validateMeetingDate(value),e=>e.status===400);
  assert.equal(describeMeeting('2026-11-07').label,'Saturday 7 November 2026');
});

test('default meeting is the fourth Sunday and repeated loads do not duplicate it',async()=>{
  const {env,sqlite}=database();
  assert.equal((await ensureMeeting(env,null,now)).date,'2026-11-22');
  await ensureMeeting(env,null,now);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM meetings').get().n,1);
});

test('only admins can list, add, remove or restore meetings',async()=>{
  const {env}=database();
  for (const member of [null,{id:'member',role:'member'}]) {
    for (const [path,method] of [['','GET'],['','POST'],['/remove','POST'],['/restore','POST']]) await rejectsStatus(()=>action(env,path,{date:'2026-11-07',revision:0},member,method),403);
  }
});

test('an extra date before the regular meeting becomes the next meeting',async()=>{
  const {env}=database();
  await ensureMeeting(env,null,now);
  assert.equal((await action(env,'',{date:'2026-11-07'})).status,201);
  const current=await ensureMeeting(env,null,now);
  assert.equal(current.id,'2026-11-07');
  assert.equal(current.startTime,'10 am');
  assert.equal(current.label,'Saturday 7 November 2026');
});

test('manual later date is retained but does not hide an earlier normal meeting',async()=>{
  const {env}=database();
  await action(env,'',{date:'2026-12-05'});
  assert.equal((await ensureMeeting(env,null,now)).date,'2026-11-22');
  assert.ok((await listMeetings(env,now)).meetings.some(m=>m.date==='2026-12-05'));
});

test('reject duplicates, past dates and invalid dates without inserting meetings',async()=>{
  const {env,sqlite}=database();
  await action(env,'',{date:'2026-11-07'});
  await rejectsStatus(()=>action(env,'',{date:'2026-11-07'}),409);
  await rejectsStatus(()=>action(env,'',{date:'2026-11-04'}),400);
  await rejectsStatus(()=>action(env,'',{date:'2026-11-31'}),400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM meetings').get().n,1);
});

test('removed fourth Sunday does not reappear on refresh or when the schedule is listed',async()=>{
  const {env}=database();
  await removeCurrent(env);
  for(let i=0;i<3;i++) assert.equal((await ensureMeeting(env,null,now)).date,'2026-12-27');
  const schedule=await listMeetings(env,now);
  assert.ok(schedule.meetings.find(m=>m.date==='2026-11-22').removedAt);
  assert.equal(schedule.currentDate,'2026-12-27');
});

test('several cancelled defaults are skipped, including over a year boundary',async()=>{
  const {env}=database();
  for(let i=0;i<3;i++) await removeCurrent(env);
  assert.equal((await ensureMeeting(env,null,now)).date,'2027-02-28');
});

test('removing an extra meeting returns the next date to the standard schedule',async()=>{
  const {env}=database();
  await action(env,'',{date:'2026-11-07'});
  await removeCurrent(env);
  assert.equal((await ensureMeeting(env,null,now)).date,'2026-11-22');
});

test('stale revision and missing revision cannot remove a meeting',async()=>{
  const {env}=database();
  await ensureMeeting(env,null,now);
  await rejectsStatus(()=>action(env,'/remove',{date:'2026-11-22',revision:1}),409);
  await rejectsStatus(()=>action(env,'/remove',{date:'2026-11-22'}),400);
  assert.equal((await ensureMeeting(env,null,now)).date,'2026-11-22');
});

test('a stale browser cannot silently act on a different meeting after cancellation',async()=>{
  const {env}=database();
  await removeCurrent(env);
  await rejectsStatus(()=>ensureMeeting(env,'2026-11-22',now),409);
  await rejectsStatus(()=>ensureMeeting(env,'2026-99-22',now),400);
});

test('restore keeps the meeting record but requires tables to be planned again',async()=>{
  const {env,sqlite}=database();
  const meeting=await ensureMeeting(env,null,now);
  sqlite.prepare("UPDATE meetings SET plan_json='{}',fixed_json='[{\"gameId\":\"old\"}]',status='locked' WHERE id=?").run(meeting.id);
  await action(env,'/remove',{date:meeting.id,revision:0});
  await rejectsStatus(()=>action(env,'',{date:meeting.id}),409);
  await action(env,'/restore',{date:meeting.id,revision:1});
  const restored=await ensureMeeting(env,null,now);
  assert.equal(restored.date,meeting.date);assert.equal(restored.status,'open');assert.equal(restored.plan_json,null);assert.equal(restored.fixed_json,'[]');assert.equal(restored.revision,2);
  await rejectsStatus(()=>action(env,'/restore',{date:meeting.id,revision:2}),409);
});

test('completed meetings cannot be removed and stay out of earlier unrecorded meetings',async()=>{
  const {env,sqlite}=database();
  await ensureMeeting(env,null,now);
  sqlite.prepare("UPDATE meetings SET status='completed' WHERE id='2026-11-22'").run();
  await rejectsStatus(()=>action(env,'/remove',{date:'2026-11-22',revision:0}),409);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM meeting_exclusions').get().n,0);
});

test('unrecorded older meetings can be removed but cannot be restored into the past',async()=>{
  const {env,sqlite}=database();
  sqlite.prepare("INSERT INTO meetings(id,updated_at) VALUES ('2026-10-25',1)").run();
  assert.ok((await listMeetings(env,now)).earlierMeetings.some(m=>m.date==='2026-10-25'));
  await action(env,'/remove',{date:'2026-10-25',revision:0});
  assert.equal((await listMeetings(env,now)).earlierMeetings.length,0);
  await rejectsStatus(()=>action(env,'/restore',{date:'2026-10-25',revision:1}),400);
});

test('date selection follows Melbourne local date rather than UTC',async()=>{
  const {env}=database();
  assert.equal((await ensureMeeting(env,null,new Date('2026-11-21T14:00:00Z'))).date,'2026-11-22');
  assert.equal((await ensureMeeting(env,null,new Date('2026-11-22T14:00:00Z'))).date,'2026-12-27');
});

test('list response does not expose member identities or credentials',async()=>{
  const {env}=database();
  const response=await action(env,'',{},admin,'GET');
  const body=await response.json();
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(body.meetings.length,6);
  for(const m of body.meetings) assert.deepEqual(Object.keys(m).sort(),['date','removedAt','revision','status']);
});
