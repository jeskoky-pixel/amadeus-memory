import fs from 'node:fs';
import assert from 'node:assert/strict';

const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
assert.match(pkg.name,/^@fg-lab\/amadeus-(qq|memory|life|state|persona)$/);
assert.match(pkg.version,/^\d+\.\d+\.\d+$/);
assert.notEqual(pkg.private,true,'Private packages cannot be published');
assert.equal(pkg.publishConfig?.access,'public');
const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(pkg.name)+'/'+encodeURIComponent(pkg.version),{signal:AbortSignal.timeout(20000)});
if(response.status===200)throw new Error('This npm version already exists; never overwrite or reuse it.');
if(response.status!==404)throw new Error('Registry availability could not be verified (HTTP '+response.status+'); stop publishing.');
console.log('Registry preflight: target version does not exist. Scope authorization still requires npm authentication.');
