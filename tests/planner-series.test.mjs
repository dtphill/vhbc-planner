import test from 'node:test';
import assert from 'node:assert/strict';
import {runSeriesChecks} from './planner-series.checks.mjs';
test('sequential private meeting simulation regressions',async()=>{
 const result=await runSeriesChecks();
 for(const check of result.checks)assert.ok(check.passed,check.name+': '+(check.error||''));
});
