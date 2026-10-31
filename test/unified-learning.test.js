import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNIFIED_SESSION_ACL_SCHEMA } from '../src/unified-session-acl.js';
import { migrateLearning } from '../src/unified-learning.js';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createUnifiedSessionAcl, runWithUnifiedSession } from '../src/unified-session-acl.js';

function fixture() {
  const store=createStore(':memory:');
  const sessions=new Map(['a','b','c','d'].map(id=>[id,{id,header:{createdAt:1},events:[]} ]));
  const options={db:store.db,workspaceId:'w',resolveTrustedSession:id=>sessions.get(id),
    authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),confirmOrdinarySession:()=>true};
  const acl=createUnifiedSessionAcl(options);
  const ids=Object.fromEntries([...sessions.keys()].map(id=>[id,acl.identify(id)]));
  const own=(id,title)=>runWithUnifiedSession(acl,ids[id],()=>store.save({type:'preference',title,content:title,importance:4}));
  const derive=(id,title,evidence)=>runWithUnifiedSession(acl,ids[id],()=>store.save({type:'preference',title,content:title,importance:4}),{evidence});
  return {store,sessions,options,acl,ids,own,derive};
}

test('new grants default Learn; obtaining permission alone records no delivery',()=>{
 const f=fixture();try {
  const a=f.own('a','basketball');assert.equal(f.acl.canReadMemory(f.ids.b,a),false);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  assert.equal(f.acl.grantDetails(f.ids.a.sourceKey,f.ids.b.sourceKey).mode,'learn');
  f.acl.readableSources(f.ids.b);assert.equal(f.acl.learningStats().receipts,0);
  assert.equal(f.acl.canDeriveSessionHistory(f.ids.b),true);
 }finally{f.store.close();}
});

test('delivered Learn permit survives revoke, delayed save, restart and blocks reshare',()=>{
 const f=fixture();try {
  const a=f.own('a','basketball');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.recordDelivery(f.ids.b,[a],'tool',10);
  const evidence=f.acl.historyEvidence(f.ids.b,{untilSeq:10});
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  const learned=f.derive('b','learned basketball',evidence);
  assert.equal(f.acl.canReadMemory(f.ids.b,a),false);
  assert.equal(f.acl.canReadMemory(f.ids.b,learned),true);
  f.acl.setGrant(f.ids.b.sourceKey,f.ids.c.sourceKey,true);
  assert.equal(f.acl.canReadMemory(f.ids.c,learned),false);
  const own=f.own('b','independent job');assert.equal(f.acl.canReadMemory(f.ids.c,own),true);
  const restored=createUnifiedSessionAcl(f.options);
  assert.equal(restored.canReadMemory(restored.identify('b'),learned),true);
  assert.equal(restored.canReadMemory(restored.identify('c'),learned),false);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.c.sourceKey,true,'borrow');
  assert.equal(f.acl.canReadMemory(f.ids.c,learned),true);
 }finally{f.store.close();}
});

test('Borrow derivative is restricted after revoke without freezing independent writes',()=>{
 const f=fixture();try {
  const a=f.own('a','basketball');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true,'borrow');
  f.acl.recordDelivery(f.ids.b,[a],'injection',2);
  const borrowed=f.derive('b','borrowed basketball',f.acl.historyEvidence(f.ids.b,{untilSeq:2}));
  assert.equal(f.acl.canReadMemory(f.ids.b,borrowed),true);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  assert.equal(f.acl.canReadMemory(f.ids.b,borrowed),false);
  const own=f.own('b','new clean fact');assert.equal(f.acl.canReadMemory(f.ids.b,own),true);
  assert.equal(f.acl.canDeriveSessionHistory(f.ids.b),true);
 }finally{f.store.close();}
});

test('mixed and second-generation derivations keep every root and restriction',()=>{
 const f=fixture();try {
  const a=f.own('a','basketball'),c=f.own('c','private music');
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true,'learn');
  f.acl.setGrant(f.ids.c.sourceKey,f.ids.b.sourceKey,true,'borrow');
  f.acl.recordDelivery(f.ids.b,[a,c],'tool',3);
  const first=f.derive('b','mixed',f.acl.historyEvidence(f.ids.b,{untilSeq:3}));
  const second=f.derive('b','second generation',f.acl.memoryEvidence(f.ids.b,[first.id]));
  assert.equal(f.acl.derivationFor(second.id).length,2);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  assert.equal(f.acl.canReadMemory(f.ids.b,second),true);
  f.acl.setGrant(f.ids.c.sourceKey,f.ids.b.sourceKey,false);
  assert.equal(f.acl.canReadMemory(f.ids.b,second),false);
  f.acl.setGrant(f.ids.b.sourceKey,f.ids.d.sourceKey,true);
  assert.equal(f.acl.canReadMemory(f.ids.d,second),false);
 }finally{f.store.close();}
});

test('undelivered ids, forged evidence and post-revoke new reads never mint Learn permits',()=>{
 const f=fixture();try {
  const a=f.own('a','private');
  assert.throws(()=>f.acl.recordDelivery(f.ids.b,[a],'tool',1),/DENIED/);
  assert.throws(()=>f.derive('b','forged',{roots:[],trusted:true}),/EVIDENCE/);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  assert.throws(()=>f.acl.recordDelivery(f.ids.b,[a],'tool',2),/DENIED/);
  assert.equal(f.acl.learningStats().receipts,0);
 }finally{f.store.close();}
});


test('revoked Borrow write rolls back memory and provenance atomically',()=>{
 const f=fixture();try {
  const a=f.own('a','borrow source');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true,'borrow');
  f.acl.recordDelivery(f.ids.b,[a],'tool',1);
  const pending=f.acl.historyEvidence(f.ids.b);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  const count=f.store.all().length;
  assert.throws(()=>f.derive('b','must rollback',pending),/BORROW_EXPIRED/);
  assert.equal(f.store.all().length,count);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM unified_learning_dependencies').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM unified_memory_sources').get().n,count);
 }finally{f.store.close();}
});

test('old acquisition does not authorize a changed or newly created source memory',()=>{
 const f=fixture();try {
  const a=f.own('a','original version');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.recordDelivery(f.ids.b,[a],'tool',1);
  const receipt=f.acl.historyEvidence(f.ids.b);
  const oldHash=receipt.roots[0].content_hash;
  runWithUnifiedSession(f.acl,f.ids.a,()=>f.store.update(a.id,{content:'new private version'}));
  const newer=f.own('a','new private fact');
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  const learned=f.derive('b','prior knowledge',receipt);
  assert.equal(f.acl.derivationFor(learned.id)[0].content_hash,oldHash);
  assert.equal(f.acl.canReadMemory(f.ids.b,newer),false);
  assert.equal(f.acl.canReadMemory(f.ids.b,a),false);
  assert.throws(()=>f.acl.recordDelivery(f.ids.b,[newer],'tool',2),/DENIED/);
 }finally{f.store.close();}
});

test('fresh summary window excludes old Borrow history without clearing its audit',()=>{
 const f=fixture();try {
  const a=f.own('a','old borrowed');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true,'borrow');
  f.acl.recordDelivery(f.ids.b,[a],'tool',2);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  const fresh=f.acl.historyEvidence(f.ids.b,{window:true,sinceSeq:3,untilSeq:9});
  assert.equal(fresh.userOnly,true);assert.deepEqual(fresh.roots,[]);
  const own=f.derive('b','fresh human fact',fresh);
  assert.equal(f.acl.canReadMemory(f.ids.b,own),true);
  assert.equal(f.acl.learningStats().receipts,1);
 }finally{f.store.close();}
});


test('schema-1 migration preserves Borrow grants, audit and a restorable disk snapshot',()=>{
 const dir=mkdtempSync(join(tmpdir(),'amadeus-learning-migration-'));
 let store,backup;
 try {
  store=createStore(join(dir,'memory.db'));
  store.db.exec(UNIFIED_SESSION_ACL_SCHEMA);
  store.db.prepare("INSERT INTO unified_acl_meta VALUES('schema_version','1')").run();
  store.db.prepare("INSERT INTO unified_acl_meta VALUES('shared-history:w:b','old-unresolved')").run();
  store.db.prepare("INSERT INTO unified_long_term_grants VALUES('w','dsh:session:a','dsh:session:b','original-time')").run();
  const row=store.save({type:'preference',title:'survives',content:'original data'});
  migrateLearning(store.db,()=>new Date().toISOString());
  const grant=store.db.prepare('SELECT * FROM unified_long_term_grants').get();
  assert.equal(grant.mode,'borrow');assert.equal(grant.legacy,1);assert.equal(grant.created_at,'original-time');
  assert.ok(grant.grant_id);
  assert.equal(store.db.prepare('SELECT status FROM unified_learning_migration').get().status,'unknown-history-quarantined');
  migrateLearning(store.db,()=>new Date().toISOString());
  const snapshots=readdirSync(dir).filter(x=>x.startsWith('memory.pre-unified-learning'));
  assert.equal(snapshots.length,1);
  backup=createStore(join(dir,snapshots[0]));
  assert.equal(backup.db.prepare("SELECT value FROM unified_acl_meta WHERE key='schema_version'").get().value,'1');
  assert.equal(backup.getById(row.id).content,'original data');
  assert.equal(backup.db.prepare('PRAGMA table_info(unified_long_term_grants)').all().some(c=>c.name==='mode'),false);
  assert.equal(store.getById(row.id).content,'original data');
 } finally {backup?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});


test('third-party learning retains both original ancestry and immediate contributor',()=>{
 const f=fixture();try {
  const a=f.own('a','root A');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.recordDelivery(f.ids.b,[a],'tool',1);
  const b=f.derive('b','A plus B contribution',f.acl.historyEvidence(f.ids.b));
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.c.sourceKey,true);f.acl.setGrant(f.ids.b.sourceKey,f.ids.c.sourceKey,true);
  f.acl.recordDelivery(f.ids.c,[b],'tool',2);
  const c=f.derive('c','third generation',f.acl.historyEvidence(f.ids.c));
  assert.deepEqual(new Set(f.acl.derivationFor(c.id).map(r=>r.source_key)),new Set([f.ids.a.sourceKey,f.ids.b.sourceKey]));
  f.acl.setGrant(f.ids.c.sourceKey,f.ids.d.sourceKey,true);f.acl.setGrant(f.ids.a.sourceKey,f.ids.d.sourceKey,true);
  assert.equal(f.acl.canReadMemory(f.ids.d,c),false);
 }finally{f.store.close();}
});


test('unrelated new Learn delivery cannot revive an expired Borrow or freeze fresh human summaries',()=>{
 const f=fixture();try {
  const a=f.own('a','expired source'),c=f.own('c','new permitted source');
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true,'borrow');f.acl.recordDelivery(f.ids.b,[a],'tool',1);
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,false);
  f.acl.setGrant(f.ids.c.sourceKey,f.ids.b.sourceKey,true);f.acl.recordDelivery(f.ids.b,[c],'injection',6);
  const value=f.acl.historyEvidence(f.ids.b,{window:true,sinceSeq:4,untilSeq:8});
  assert.equal(value.userOnly,true);assert.deepEqual(value.roots,[]);
  assert.equal(f.acl.canReadMemory(f.ids.b,a),false);
 }finally{f.store.close();}
});


test('metadata-only maintenance does not falsely attribute native knowledge to shared content',()=>{
 const f=fixture();try {
  const a=f.own('a','shared'),native=f.own('b','native');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.recordDelivery(f.ids.b,[a],'tool',1);const evidence=f.acl.historyEvidence(f.ids.b);
  runWithUnifiedSession(f.acl,f.ids.b,()=>f.store.update(native.id,{importance:5}),{evidence});
  assert.equal(f.acl.derivationFor(native.id).length,0);
  runWithUnifiedSession(f.acl,f.ids.b,()=>f.store.update(native.id,{content:'new content using source'}),{evidence});
  assert.equal(f.acl.derivationFor(native.id).length,1);
 }finally{f.store.close();}
});


test('derived recent activity also requires its publisher own independent Learn permission',()=>{
 const f=fixture();try {
  const a=f.own('a','source A');f.acl.setGrant(f.ids.a.sourceKey,f.ids.b.sourceKey,true);
  f.acl.recordDelivery(f.ids.b,[a],'tool',1);
  f.acl.saveRecentEvidence('event-b',f.ids.b,f.acl.historyEvidence(f.ids.b));
  f.acl.setGrant(f.ids.a.sourceKey,f.ids.c.sourceKey,true);
  f.acl.recordRecentDelivery(f.ids.c,f.ids.b,[{summary:'A fact plus B activity',occurredAt:1,expiresAt:Date.now()+60000,provenanceKey:'event-b'}],2);
  const roots=f.acl.historyEvidence(f.ids.c).roots;
  assert.equal(roots.find(r=>r.source_key===f.ids.a.sourceKey)?.mode,'learn');
  assert.equal(roots.find(r=>r.source_key===f.ids.b.sourceKey)?.mode,'borrow');
 }finally{f.store.close();}
});

test('1.3 metadata upgrade reopens schema 2 without changing persisted rows or learned rights',()=>{
 const dir=mkdtempSync(join(tmpdir(),'amadeus-v13-reopen-'));let store;
 try {
  const path=join(dir,'memory.db');store=createStore(path);
  const sessions=new Map(['a','b','c'].map(id=>[id,{id,header:{createdAt:1},events:[]} ]));
  const options=()=>({db:store.db,workspaceId:'w',resolveTrustedSession:id=>sessions.get(id),authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),confirmOrdinarySession:()=>true});
  let acl=createUnifiedSessionAcl(options());let a=acl.identify('a'),b=acl.identify('b'),c=acl.identify('c');
  const root=runWithUnifiedSession(acl,a,()=>store.save({type:'preference',title:'original',content:'synthetic retained fact',importance:4}));
  acl.setGrant(a.sourceKey,b.sourceKey,true,'learn');acl.recordDelivery(b,[root],'tool',7);
  const learned=runWithUnifiedSession(acl,b,()=>store.save({type:'preference',title:'learned',content:'synthetic derived fact',importance:4}),{evidence:acl.historyEvidence(b)});
  acl.setGrant(a.sourceKey,b.sourceKey,false);acl.setGrant(b.sourceKey,c.sourceKey,true);
  const snapshot=()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()]));
  const before=snapshot();store.close();store=createStore(path);acl=createUnifiedSessionAcl(options());
  assert.deepEqual(snapshot(),before,'all persisted tables, not just row counts, remain intact');
  assert.equal(store.db.prepare("SELECT value FROM unified_acl_meta WHERE key='schema_version'").get().value,'2');
  assert.equal(store.getById(root.id).content,'synthetic retained fact');
  assert.equal(acl.canReadMemory(acl.identify('b'),learned),true);
  assert.equal(acl.canReadMemory(acl.identify('c'),learned),false);
  assert.equal(acl.canReadMemory(acl.identify('b'),root),false);
 } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
