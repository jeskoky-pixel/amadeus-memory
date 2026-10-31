import { createRecentActivityCore } from '../src/recent-activity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { createUnifiedRuntime } from '../src/unified-runtime.js';
import { createSummarizer } from '../src/summarize.js';
import { createDreamScheduler } from '../src/dream.js';
import { runSleep } from '../src/dream/sleep.js';
import { mockCtx } from './helpers/dream-mock.js';

function setup() {
 const store=createStore(':memory:'),service=createService({store,mirror:null,config:{}});
 const sessions=new Map(['a','b'].map(id=>[id,{id,header:{createdAt:1,agentPreset:'custom'},
  requestHeader:()=>({config:{provider:'mock',model:'synthetic'}}),
  events:[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'private-'+id}]}},{seq:2,type:'turn/end'}]}]));
 const ctx={sessions:{get:id=>sessions.get(id)},qq:{sessionProvenanceVersion:1,classifySession:()=>({kind:'ordinary'})}};
 const runtime=createUnifiedRuntime({ctx,db:store.db,workspaceId:'w',authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),enabled:()=>true});
 return {store,service,sessions,ctx,runtime};
}

test('autoSummarize stamps ordinary custom Session sources and refuses disposed runtime writes',async()=>{
 const f=setup(),handlers=[];let invalidate=false;
 Object.assign(f.ctx,{on:(n,fn)=>{handlers.push(fn);return()=>{};},logger:{warn(){}},llm:{async *stream(){
  if(invalidate)f.runtime.dispose();
  yield {type:'text-delta',text:JSON.stringify([{type:'decision',title:'summary',content:'synthetic decision',importance:4}])};
  yield {type:'finish',reason:{kind:'ok'}};
 }}});
 const summarizer=createSummarizer(f.ctx,f.service,{autoSummarize:true},{authorizeModelWork:f.runtime.authorize});
 try {
  await handlers[0](f.sessions.get('a'),{type:'turn/end',seq:2});
  assert.equal(f.store.all().length,1);
  assert.equal(f.store.all()[0].scene_scope,'dsh:session:a');
  invalidate=true;
  await handlers[0](f.sessions.get('b'),{type:'turn/end',seq:2});
  assert.equal(f.store.all().length,1);
 } finally {summarizer.dispose();f.store.close();}
});

test('Dream and Sleep source jobs never inherit shared reads or merge another source',async()=>{
 const f=setup(),inputs=[];
 try {
  for(const id of ['a','b'])f.runtime.authorize.run(f.sessions.get(id),()=>f.service.saveWithDedupe({type:'preference',title:'fact-'+id,content:'PRIVATE_'+id,importance:5}));
  f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',true);
  const ctx=mockCtx({onConsolidation:text=>{inputs.push(text);return '[]';}});
  const dream=createDreamScheduler({thresholdCount:1,thresholdChars:0,delayMs:0});
  try {
   await f.runtime.runSources(()=>dream.runDream(ctx,f.service,{dreamProvider:'mock',dreamModel:'synthetic'}));
   await f.runtime.runSources(()=>runSleep(ctx,f.service,{sleepModeEnabled:true,sleepPatternMinMemories:100,sleepArchiveDays:365,sleepCompressDays:365},ctx.logger));
  } finally {dream.dispose();}
  assert.ok(inputs.length>=2);
  for(const input of inputs)assert.ok(!(input.includes('PRIVATE_a')&&input.includes('PRIVATE_b')));
  for(const id of ['a','b'])assert.equal(f.runtime.authorize.run(f.sessions.get(id),()=>f.store.all().filter(m=>m.title==='fact-'+id).length),1);
  assert.equal(f.store.all().filter(m=>m.type==='preference').length,2);
 } finally {f.store.close();}
});

test('unused grants do not freeze automatic summaries',async()=>{
 const f=setup(),handlers=[];let calls=0;
 Object.assign(f.ctx,{on:(n,fn)=>{handlers.push(fn);return()=>{};},logger:{warn(){}},llm:{async *stream(){calls++;
  yield {type:'text-delta',text:JSON.stringify([{type:'decision',title:'copied',content:'PRIVATE_a',importance:4}])};
  yield {type:'finish',reason:{kind:'ok'}};
 }}});
 const summarizer=createSummarizer(f.ctx,f.service,{autoSummarize:true},{authorizeModelWork:f.runtime.authorize});
 try {
  f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',true);
  await handlers[0](f.sessions.get('b'),{type:'turn/end',seq:2});
  assert.equal(calls,1);assert.equal(f.store.all().length,1);
  f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',false);
  await handlers[0](f.sessions.get('b'),{type:'turn/end',seq:2});
  assert.equal(calls,1);assert.equal(f.store.all().length,1);
 } finally {summarizer.dispose();f.store.close();}
});


test('actual shared recent read records Borrow ancestry without freezing the Session',()=>{
 const f=setup();
 const options={db:f.store.db,workspaceId:'w',allowSession:f.runtime.authorize,
  resolveTrustedSession:id=>f.sessions.get(id),allowCrossSession:f.runtime.allowRecentPair};
 const preview=createRecentActivityCore(options);
 const core=createRecentActivityCore({...options,onSharedRead:f.runtime.authorize.noteSharedRead,
  prepareRecord:f.runtime.authorize.prepareRecent,saveProvenance:f.runtime.authorize.saveRecent,
  canReadProvenance:f.runtime.authorize.canReadRecent});
 try {
  const a=f.sessions.get('a'),b=f.sessions.get('b');
  assert.equal(core.recordTurnEnd(a,{type:'turn/end',seq:2}).ok,true);
  core.setSourcePolicy(a,{mode:'shared',sharedSessionIds:['b']});
  assert.equal(preview.readRecentActivity(b,{includeSelf:false}).count,1);
  assert.equal(f.runtime.acl.learningStats().receipts,0);
  assert.equal(f.runtime.authorize.derive(b).allowed,true);
  assert.equal(core.readRecentActivity(b,{includeSelf:false}).count,1);
  assert.equal(f.runtime.authorize.derive(b).allowed,true);
  assert.equal(f.runtime.acl.learningStats().receipts,1);
  const evidence=f.runtime.acl.historyEvidence(f.runtime.acl.identify('b'));
  assert.equal(evidence.roots[0].mode,'borrow');
  assert.equal(core.recordTurnEnd(b,{type:'turn/end',seq:2}).ok,true);
  core.setSourcePolicy(a,{mode:'self'});
  assert.equal(core.readRecentActivity(b,{includeSelf:false}).count,0);
  assert.equal(f.runtime.authorize.derive(b).allowed,true);
 } finally {f.runtime.dispose();f.store.close();}
});


for(const mode of ['learn','borrow'])test(`summary in flight uses historical ${mode} permission after revoke`,async()=>{
 const f=setup(),handlers=[];
 const a=f.sessions.get('a'),b=f.sessions.get('b');
 const original=f.runtime.authorize.run(a,()=>f.service.saveWithDedupe({type:'preference',title:'source',content:'basketball source'})).memory;
 f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',true,mode);
 f.runtime.acl.recordDelivery(f.runtime.acl.identify('b'),[original],'tool',1);
 Object.assign(f.ctx,{on:(n,fn)=>{handlers.push(fn);return()=>{};},logger:{warn(){}},llm:{async *stream(){
  f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',false);
  yield {type:'text-delta',text:JSON.stringify([{type:'decision',title:'derived',content:'basketball learned from source',importance:4}])};
  yield {type:'finish',reason:{kind:'ok'}};
 }}});
 const summarizer=createSummarizer(f.ctx,f.service,{autoSummarize:true},{authorizeModelWork:f.runtime.authorize});
 try {
  await handlers[0](b,{type:'turn/end',seq:2});
  const derived=f.store.all().find(m=>m.title==='derived');
  if(mode==='learn') {
   assert.ok(derived);assert.equal(f.runtime.acl.derivationFor(derived.id)[0].origin_id,original.id);
   assert.equal(f.runtime.authorize.run(b,()=>f.store.getById(derived.id))?.id,derived.id);
  } else assert.equal(derived,undefined);
  assert.equal(f.runtime.authorize.run(b,()=>f.store.getById(original.id)),undefined);
 }finally{summarizer.dispose();f.store.close();}
});


test('repeated original Dream and Sleep keep learned roots after source revoke',async()=>{
 const f=setup();const a=f.sessions.get('a'),b=f.sessions.get('b');
 const source=f.runtime.authorize.run(a,()=>f.service.saveWithDedupe({type:'preference',title:'root',content:'synthetic root A',importance:5})).memory;
 f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',true);
 f.runtime.acl.recordDelivery(f.runtime.acl.identify('b'),[source],'tool',1);
 f.runtime.authorize.run(b,()=>f.service.saveWithDedupe({type:'preference',title:'learned B',content:'synthetic root A and B',importance:5}),{evidence:f.runtime.acl.historyEvidence(f.runtime.acl.identify('b'))});
 f.runtime.acl.setGrant('dsh:session:a','dsh:session:b',false);
 const ctx=mockCtx({summaryText:'synthetic learned summary'});
 const stream=ctx.llm.stream;ctx.llm.stream=function(options){assert.ok(['a','b'].includes(options.sessionId));return stream(options);};
 const dream=createDreamScheduler({thresholdCount:1,thresholdChars:0,delayMs:0});
 try {
  for(let i=0;i<2;i++){
   await f.runtime.runSources(()=>dream.runDream(ctx,f.service,{dreamProvider:'mock',dreamModel:'synthetic'}));
   await f.runtime.runSources(()=>runSleep(ctx,f.service,{sleepModeEnabled:true,sleepPatternMinMemories:100,sleepArchiveDays:365,sleepCompressDays:365},ctx.logger));
  }
  const summaries=f.store.all().filter(m=>m.scene_scope==='dsh:session:b'&&m.type==='summary');
  assert.ok(summaries.length);
  for(const row of summaries){assert.ok(f.runtime.acl.derivationFor(row.id).some(r=>r.origin_id===source.id));assert.equal(f.runtime.acl.canReadMemory(f.runtime.acl.identify('b'),row),true);}
 }finally{dream.dispose();f.store.close();}
});
