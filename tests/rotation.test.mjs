import test from 'node:test';
import assert from 'node:assert/strict';
import {runRotationChecks} from './rotation.checks.mjs';
test('rotation and simulation runtime regressions',async()=>{const r=await runRotationChecks();for(const c of r.checks)assert.ok(c.passed,c.name+': '+(c.error||''));});
