import test from 'node:test';
import assert from 'node:assert/strict';
import {runSizeChecks} from './table-size.checks.mjs';
test('table-size allocation portable checks',async()=>{const r=await runSizeChecks();for(const c of r.checks)assert.equal(c.passed,true,c.name+': '+c.error);console.log(r.checks.length+' checks passed');});
