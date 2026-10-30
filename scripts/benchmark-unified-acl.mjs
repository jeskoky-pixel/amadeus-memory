// Synthetic, no network. node scripts/benchmark-unified-acl.mjs <baseline-package-root> <output.json>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createUnifiedRuntime } from '../src/unified-runtime.js';
const roots=[['baseline',path.resolve(process.argv[2])],['candidate',path.resolve('.')]];
const results=[];
for(const [mode,root] of roots) {
 const mod=name=>import(pathToFileURL(path.join(root,'src',name+'.js')));
 const {createStore}=await mod('store'),{createService}=await mod('service');
 const {configureScene,mintTrustedScene,runWithTrustedScene}=await mod('scene');
 const {runWithSceneJob}=await mod('scene-job');
 const {createDreamScheduler}=await mod('dream'),{runSleep}=await mod('dream/sleep');
 for(const count of [1000,10000]) {
  const store=createStore(':memory:'),config={bm25SearchEnabled:true,recallRecordDefault:false,entityRecallEnabled:true,graphEnabled:true,graphMaxHops:2};
  const service=createService({store,mirror:null,config});
  const scenes=Array.from({length:5},(_,i)=>mintTrustedScene({platform:'qq',kind:'group',id:`bot:g${i}`,verified:true}));
  store.db.exec('BEGIN');
  for(let i=0;i<count;i++)store.save({id:`bench-${i}`,type:'history',title:`topic${i%32} fact ${i}`,content:`Synthetic topic${i%32} memory ${i}: Entity${i%40} links Entity${(i+1)%40}`,importance:3,scene_scope:scenes[i%5].sceneId,embedding:Array.from({length:64},(_,j)=>j===i%64?1:0)});
  const entities=Array.from({length:40},(_,i)=>store.createEntity({name:`Entity${i}`,type:'concept'}));
  for(let i=0;i<200;i++) {
   store.saveAttr({entity_id:entities[i%40].id,attr_key:'fact'+i,attr_value:`topic${i%32}`,memory_id:`bench-${i}`});
   store.saveRelation({from_entity:entities[i%40].id,to_entity:entities[(i+1)%40].id,relation_type:'links',memory_id:`bench-${i}`});
  }
  store.db.exec('COMMIT');
  configureScene({enabled:true,strictQQ:true,hostContract:false});
  let hostChecks=0,sql=0;
  const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=(...args)=>{const st=prepare(...args);for(const key of ['all','get','run']){const fn=st[key].bind(st);st[key]=(...a)=>{sql++;return fn(...a);};}return st;};
  const session={id:'a',header:{agentPreset:'synthetic'}};
  const runtime=mode==='candidate'?createUnifiedRuntime({ctx:{sessions:{get:()=>{hostChecks++;return session;}},qq:{resolveTrustedSessionScene:()=>({platform:'qq',kind:'group',id:'bot:g0',verified:true})}},db:store.db,workspaceId:'w',authorizeWorkspace:()=>({allowed:true,workspaceId:'w'}),enabled:()=>true}):null;
  const run=fn=>runtime?runtime.authorize.run(session,fn):runWithTrustedScene(scenes[0],fn);
  const vector=Array.from({length:64},(_,i)=>i===0?1:0);
  service.setEmbedder({embed:async()=>vector});
  const measure=async fn=>{
   for(let i=0;i<3;i++)await run(()=>fn(i));
   const times=[];let resultItems=0;sql=0;hostChecks=0;
   for(let i=0;i<25;i++){const start=performance.now();const value=await run(()=>fn(i));resultItems+=Array.isArray(value)?value.length:0;times.push(performance.now()-start);}
   times.sort((a,b)=>a-b);return {p50Ms:+times[12].toFixed(3),p95Ms:+times[23].toFixed(3),sqlCallsPerOp:sql/25,hostChecksPerOp:hostChecks/25,resultItemsPerOp:resultItems/25};
  };
  const measurements={};
  measurements.list=await measure(()=>service.list({limit:10}));
  for(const search of ['keyword','vector','hybrid'])measurements[search]=await measure(i=>service.searchMemories(`topic${i%32}`,{mode:search,topK:10,threshold:0,useRerank:false,recordRecall:false}));
  measurements.graph=await measure(()=>service.getRelations(entities[0].id));
  measurements.multiHop=await measure(()=>{
   let frontier=[entities[0].id];for(let hop=0;hop<2;hop++)frontier=[...new Set(frontier.flatMap(id=>service.getRelations(id).map(e=>e.from_entity===id?e.to_entity:e.from_entity)))];return frontier;
  });
  measurements.injectionCandidates=await measure(()=>service.injectCandidates({maxItems:5,threshold:1}));
  if(runtime)measurements.identity=await measure(()=>runtime.authorize(session));
  let modelCalls=0;
  const ctx={logger:{warn(){},info(){}},agentDefaultModel:{currentSelection:()=>({provider:'mock',model:'synthetic'})},llm:{async *stream(options){modelCalls++;yield {type:'text-delta',text:options.messages.some(m=>JSON.stringify(m.content).includes('id='))?'[]':'Synthetic source summary'};yield {type:'finish',reason:{kind:'ok'}};}}};
  const dream=createDreamScheduler({thresholdCount:1,thresholdChars:0,delayMs:0});
  const background=fn=>runtime?runtime.runSources(fn):runWithSceneJob(scenes[0].sceneId,fn);
  measurements.backgroundDream=await measure(()=>background(()=>dream.runDream(ctx,service,{dreamProvider:'mock',dreamModel:'synthetic'})));
  measurements.backgroundSleep=await measure(()=>background(()=>runSleep(ctx,service,{sleepModeEnabled:true,sleepPatternMinMemories:20000,sleepArchiveDays:365,sleepCompressDays:365},ctx.logger)));
  dream.dispose();measurements.syntheticBackgroundModelCalls=modelCalls;
  results.push({mode,count,dimensions:64,sourceCount:5,samples:25,measurements});
  store.close();
 }
}
fs.writeFileSync(process.argv[3],JSON.stringify({node:process.version,synthetic:true,remoteEmbedding:false,results},null,2));
console.log(JSON.stringify(results));
