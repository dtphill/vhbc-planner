import test from 'node:test';
import assert from 'node:assert/strict';
import {fourthSunday,nextMeeting,localDate} from '../src/calendar.mjs';
test('Fourth Sunday is not the last Sunday in a five-Sunday month',()=>assert.equal(fourthSunday(2026,10),'2026-11-22'));
test('Upcoming meeting on and after meeting day uses Melbourne calendar',()=>{
  assert.equal(nextMeeting(new Date('2026-11-21T23:00:00Z')).date,'2026-11-22');
  assert.equal(nextMeeting(new Date('2026-11-22T13:01:00Z')).date,'2026-12-27');
  assert.equal(nextMeeting(new Date('2026-12-27T13:01:00Z')).date,'2027-01-24');
});
test('Every calculated monthly date is a Sunday between 22nd and 28th',()=>{
  for(let year=2025;year<=2032;year++)for(let month=0;month<12;month++){
    const d=new Date(fourthSunday(year,month)+'T00:00:00Z');
    assert.equal(d.getUTCDay(),0);assert.ok(d.getUTCDate()>=22&&d.getUTCDate()<=28);assert.equal(d.getUTCMonth(),month);
  }
  assert.equal(localDate(new Date('2026-11-02T14:00:00Z')),'2026-11-03');
});
