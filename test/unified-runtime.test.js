import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createUnifiedRuntime } from "../src/unified-runtime.js";
import { createTools } from "../src/tools.js";
import { createInjector } from "../src/inject.js";
import { checkWorkspaceAccess } from "../src/workspace-gate.js";
import { unifiedSnapshot, saveUnifiedPolicy, unifiedGraph, saveUnifiedMemory } from "../src/unified-admin.js";
import { createRecentActivityCore } from '../src/recent-activity.js';
import { configureScene } from '../src/scene.js';
import { INTERNAL_AUTHORITY } from '../src/internal-authority.js';

test('Session graph uses canonical entity groups while retaining per-fact visibility after merge and revoke',()=>{
 const store=createStore(':memory:'),service=createService({store,mirror:null,config:{}});
 const sessions=new Map(['a','b'].map(id=>[id,{id,header:{createdAt:1}}]));
 const ctx={sessions:{get:id=>sessions.get(id)},qq:{sessionProvenanceVersion:1,classifySession:()=>({kind:'ordinary'})}};
 const runtime=createUnifiedRuntime({ctx,db:store.db,workspaceId:'w',authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),enabled:()=>true});
 const deps={store,service,unifiedRuntime:runtime};
 try {
  const entities=['a','b'].map(id=>{
   const entity=store.createEntity({name:'小明',type:'person'});
   runtime.authorize.run(sessions.get(id),()=>{
    const row=service.saveWithDedupe({type:'preference',title:'fact-'+id,content:'小明 fact '+id}).memory;
    store.saveAttr({entity_id:entity.id,attr_key:'fact-'+id,attr_value:id,memory_id:row.id});
   });return entity;
  });
  const report=service.identity.dryRunMerge({from_entity:entities[1].id,to_entity:entities[0].id,actor:'test'});
  service.identity.confirmMerge({report_id:report.report_id,actor:'test'});
  assert.equal(unifiedGraph(deps,null).nodes.length,1);
  assert.deepEqual(unifiedGraph(deps,'b').nodes.flatMap(n=>n.attrs.map(a=>a.attr_key)),['fact-b']);
  runtime.acl.setGrant(runtime.acl.identify('a').sourceKey,runtime.acl.identify('b').sourceKey,true);
  assert.deepEqual(unifiedGraph(deps,'b').nodes.flatMap(n=>n.attrs.map(a=>a.attr_key)).sort(),['fact-a','fact-b']);
  runtime.acl.setGrant(runtime.acl.identify('a').sourceKey,runtime.acl.identify('b').sourceKey,false);
  assert.deepEqual(unifiedGraph(deps,'b').nodes.flatMap(n=>n.attrs.map(a=>a.attr_key)),['fact-b']);
 } finally {runtime.dispose();store.close();}
});

test('standalone runtime attests new Host Sessions and quarantines historical provenance',async()=>{
 const store=createStore(':memory:'),sessions=new Map([['old',{id:'old',header:{createdAt:1000}}]]);
 const options={ctx:{sessions:{get:id=>sessions.get(id)}},db:store.db,workspaceId:'w',authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),enabled:()=>true};
 const runtime=createUnifiedRuntime(options);
 try {
  assert.equal(runtime.authorize(sessions.get('old')).allowed,false);
  await new Promise(resolve=>setTimeout(resolve,5));
  sessions.set('fresh',{id:'fresh',header:{createdAt:Date.now()}});
  assert.equal(runtime.authorize(sessions.get('fresh')).allowed,true);
  runtime.dispose();
  const restarted=createUnifiedRuntime(options);
  assert.equal(restarted.authorize(sessions.get('fresh')).allowed,true);
  sessions.set('fresh',{id:'fresh',header:{createdAt:1001}});
  assert.equal(restarted.authorize(sessions.get('fresh')).allowed,false);
  restarted.dispose();
 } finally {store.close();}
});

test("registered tools, real injector, admin grants and source jobs share the same ACL", async () => {
 const store=createStore(":memory:"), config={maxInjectedItems:20,importanceThreshold:1,hotMemoryEnabled:false,scopeEnabled:false};
 const service=createService({store,mirror:null,config}),settings=createSettings(store.db);
 const sessions=new Map(['a','b','c','d','q1','q2','owner','x'].map(id=>[id,{id,header:{createdAt:1,agentPreset:id==='c'?'custom-video':'standard'},snapshotEvents:()=>[]}]));
 const workspace={id:'w',title:'Synthetic',sessionIds:[...sessions.keys()].filter(id=>id!=='x')};
 const scenes=new Map(['q1','q2','owner'].map(id=>[id,{platform:'qq',kind:id==='owner'?'private':'group',id:'bot:'+id,verified:true,admin:id==='owner'}]));
 const registered=[],prompts=new Map();
 const ctx={sessions:{get:id=>sessions.get(id)},workspaceRegistry:{list:()=>[workspace,{id:'excluded',sessionIds:['x']}]},
   qq:{sessionProvenanceVersion:1,classifySession:id=>({kind:scenes.has(id)?'qq':'ordinary'}),resolveTrustedSessionScene:id=>scenes.get(id)},
   tools:{register:t=>{registered.push(t);return ()=>{};}},systemPrompt:{context:s=>{prompts.set(s.name,s.text);return ()=>{};}}};
 const runtime=createUnifiedRuntime({ctx,db:store.db,workspaceId:'w',authorizeWorkspace:s=>checkWorkspaceAccess(s,'w',ctx),enabled:()=>true});
 createTools(ctx,service,config,null,runtime.authorize);
 const dispose=createInjector(ctx,service,settings,config,null,runtime.authorize);
 const call=(name,id,args)=>registered.find(t=>t.name===name).execute(args,{agent:{session:sessions.get(id)}});
 const deps={ctx,store,service,settings,unifiedRuntime:runtime,activeWorkspaceId:'w'};
 const recent=createRecentActivityCore({db:store.db,workspaceId:'w',allowSession:runtime.authorize,
   resolveTrustedSession:id=>sessions.get(id),allowCrossSession:runtime.allowRecentPair});
 try {
  configureScene({enabled:true,strictQQ:true});
  const rows={};
  for(const id of workspace.sessionIds) rows[id]=await call('memory_save',id,{type:'preference',title:'fact-'+id,content:'private-'+id,importance:5});
  assert.equal(store.count(),7);
  assert.equal((await call('memory_get','a',{id:rows.a.id})).memory.id,rows.a.id);
  await call('memory_update','a',{id:rows.a.id,content:'private-a updated'});
  for(const id of workspace.sessionIds){
   const result=await call('memory_list',id,{limit:20});assert.deepEqual(result.items.map(r=>r.title),['fact-'+id]);
   const text=prompts.get('memory')({agent:{session:sessions.get(id)}});assert.match(text,new RegExp('private-'+id));
   if(id!=='a')assert.doesNotMatch(text,/private-a/);
  }
  await assert.rejects(call('memory_list','x',{limit:20}),/ACCESS_DENIED/);
  assert.equal(recent.setSourcePolicy(sessions.get('a'),{mode:'shared',sharedSessionIds:['c']}).ok,true);
  const recentPolicy=recent.getSourcePolicy(sessions.get('a'));
  assert.equal((await call('memory_list','c',{limit:20})).items.length,1);
  assert.equal(runtime.allowRecentPair('c','d'),true);
  assert.equal(runtime.allowRecentPair('q1','q2'),true);
  assert.equal(runtime.allowRecentPair('a','q1'),true);
  assert.equal(runtime.allowRecentPair('q1','x'),false);
  for(const [from,to] of [['q1','q2'],['q1','a'],['a','q1']]) {
   const now=Date.now(), events=[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Synthetic activity '+from}]}},
    {seq:2,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text:'Completed a bounded synthetic activity.'}]}}},{seq:3,type:'turn/end',data:{}}];
   sessions.get(from).snapshotEvents=()=>events;
   recent.setSourcePolicy(sessions.get(from),{mode:'self'});
   recent.recordTurnEnd(sessions.get(from),events[2],{now});
   assert.equal(recent.readRecentActivity(sessions.get(to),{now:now+1,includeSelf:false}).count,0);
   assert.equal(recent.setSourcePolicy(sessions.get(from),{mode:'shared',sharedSessionIds:[to]}).ok,true);
   assert.equal(recent.readRecentActivity(sessions.get(to),{now:now+1,includeSelf:false}).count,1);
   assert.equal((await call('memory_list',to,{limit:20})).items.length,1);
   recent.setSourcePolicy(sessions.get(from),{mode:'self'});
   assert.equal(recent.readRecentActivity(sessions.get(to),{now:now+1,includeSelf:false}).count,0);
  }
  assert.throws(()=>saveUnifiedMemory(deps,{type:'preference',title:'manual',content:'manual fact'}),/OWNERSHIP/);
  const manual=saveUnifiedMemory(deps,{owner_session_id:'a',type:'preference',title:'manual',content:'manual fact'});
  assert.throws(()=>service.update(manual.memory.id,{content:'forged'},{actor:'panel'}),/SCENE_DENIED/);
  service.update(manual.memory.id,{content:'authorized panel edit'},{actor:'panel',[INTERNAL_AUTHORITY]:true});
  assert.equal(runtime.acl.canReadMemory(runtime.acl.identify('a'),manual.memory),true);
  assert.equal(runtime.acl.canReadMemory(runtime.acl.identify('b'),manual.memory),false);
  service.remove(manual.memory.id);
  const admin=saveUnifiedMemory(deps,{owner_session_id:null,type:'preference',title:'admin only',content:'not shared'});
  assert.equal(runtime.acl.canReadMemory(runtime.acl.identify('a'),admin.memory),false);
  service.remove(admin.memory.id);
  assert.throws(()=>saveUnifiedMemory(deps,{owner_session_id:'x',type:'preference',title:'outside',content:'blocked'}),/INVALID/);
  recent.setSourcePolicy(sessions.get('a'),{mode:'shared',sharedSessionIds:['c']});
  const before = unifiedSnapshot(deps).revision;
  saveUnifiedPolicy(deps,{session_id:'a',owner_read:false,readers:['b'],revision:before});
  assert.throws(()=>saveUnifiedPolicy(deps,{session_id:'a',owner_read:false,readers:[],revision:before}),/CONFLICT/);
  assert.deepEqual(recent.getSourcePolicy(sessions.get('a')),recentPolicy);
  assert.equal((await call('memory_list','b',{limit:20})).items.length,2);
  assert.equal((await call('memory_get','b',{id:rows.a.id})).memory.id,rows.a.id);
  assert.match(prompts.get('memory')({agent:{session:sessions.get('b')}}),/private-a/);
  await assert.rejects(call('memory_update','b',{id:rows.a.id,content:'poison'}),/UNIFIED_WRITE_NOT_OWNED/);
  assert.equal((await call('memory_list','c',{limit:20})).items.length,1);
  saveUnifiedPolicy(deps,{session_id:'a',owner_read:false,readers:[]});
  assert.doesNotMatch(prompts.get('memory')({agent:{session:sessions.get('b')}}),/private-a/);
  const seen=[];
  await runtime.runSources(()=>{seen.push(store.list({limit:20}).length);return {ok:true};});
  assert.deepEqual(seen,Array(7).fill(1));
  assert.equal(unifiedSnapshot(deps).sessions.length,7);
  assert.deepEqual(unifiedGraph(deps,'b').nodes,[]);
  delete ctx.qq;
  assert.equal((await call('memory_list','b',{limit:20})).items.length,1);
  await assert.rejects(call('memory_list','q1',{limit:20}),/ACCESS_DENIED/);
 }finally{configureScene();dispose();runtime.dispose();store.close();}
});
