// Trusted, host-only acquisition receipts. No HTTP or model parameter can mint
// an evidence capability. Source text remains in Mneme, not in this ledger.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const capabilities = new WeakMap();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rootKey = r => JSON.stringify([r.source_key,r.origin_id,r.content_hash,r.channel,r.source_session_id]);

export function migrateLearning(db, now) {
  const version=db.prepare("SELECT value FROM unified_acl_meta WHERE key='schema_version'").get()?.value;
  if (version && !['1','2'].includes(version)) throw Error(`UNIFIED_ACL_SCHEMA_UNSUPPORTED: ${version}`);
  if (version==='2') return;
  if (db.isTransaction) throw Error('LEARNING_MIGRATION_REQUIRES_IDLE_DATABASE');
  const file=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main')?.file;
  // VACUUM INTO includes committed WAL data. Never overwrite the pre-v2 image.
  if (file) {
    const target=join(dirname(file),`memory.pre-unified-learning-v2-${Date.now()}-${randomUUID()}.db`);
    if (!existsSync(target)) db.prepare('VACUUM INTO ?').run(target);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns=new Set(db.prepare('PRAGMA table_info(unified_long_term_grants)').all().map(x=>x.name));
    if (!columns.has('mode')) db.exec("ALTER TABLE unified_long_term_grants ADD COLUMN mode TEXT NOT NULL DEFAULT 'borrow' CHECK(mode IN ('learn','borrow'))");
    if (!columns.has('legacy')) db.exec('ALTER TABLE unified_long_term_grants ADD COLUMN legacy INTEGER NOT NULL DEFAULT 1');
    if (!columns.has('grant_id')) db.exec('ALTER TABLE unified_long_term_grants ADD COLUMN grant_id TEXT');
    for(const row of db.prepare('SELECT rowid FROM unified_long_term_grants WHERE grant_id IS NULL').all())
      db.prepare('UPDATE unified_long_term_grants SET grant_id=? WHERE rowid=?').run(randomUUID(),row.rowid);
    db.exec(`
      CREATE TABLE IF NOT EXISTS unified_learning_receipts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
        learner_key TEXT NOT NULL, delivered_id TEXT NOT NULL, delivered_hash TEXT NOT NULL,
        roots_json TEXT NOT NULL, delivery_kind TEXT NOT NULL, first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL, acquired_at TEXT NOT NULL,
        UNIQUE(workspace_id,session_id,delivered_id,delivered_hash,roots_json,delivery_kind));
      CREATE INDEX IF NOT EXISTS idx_learning_receipt_session
        ON unified_learning_receipts(workspace_id,session_id,first_seq);
      CREATE TABLE IF NOT EXISTS unified_learning_dependencies (
        memory_id TEXT NOT NULL, root_key TEXT NOT NULL, source_key TEXT NOT NULL,
        origin_id TEXT NOT NULL, content_hash TEXT NOT NULL, mode TEXT NOT NULL,
        learner_key TEXT NOT NULL, receipt_id TEXT NOT NULL, grant_id TEXT,
        channel TEXT NOT NULL, source_session_id TEXT, expires_at INTEGER,
        allow_reshare INTEGER NOT NULL DEFAULT 0 CHECK(allow_reshare=0),
        PRIMARY KEY(memory_id,root_key));
      CREATE INDEX IF NOT EXISTS idx_learning_dependency_memory ON unified_learning_dependencies(memory_id);
      CREATE TABLE IF NOT EXISTS unified_recent_dependencies (
        event_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, roots_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unified_derivation_edges (
        memory_id TEXT NOT NULL, parent_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(memory_id,parent_id));
      CREATE TABLE IF NOT EXISTS unified_learning_migration (
        marker_key TEXT PRIMARY KEY, original_value TEXT NOT NULL,
        status TEXT NOT NULL, migrated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS trg_learning_memory_delete AFTER DELETE ON memories BEGIN
        DELETE FROM unified_learning_dependencies WHERE memory_id=OLD.id;
        DELETE FROM unified_derivation_edges WHERE memory_id=OLD.id;
      END;`);
    for(const row of db.prepare("SELECT key,value FROM unified_acl_meta WHERE key LIKE 'shared-history:%'").all())
      db.prepare('INSERT OR IGNORE INTO unified_learning_migration VALUES(?,?,?,?)')
        .run(row.key,row.value,'unknown-history-quarantined',now());
    db.prepare("INSERT OR REPLACE INTO unified_acl_meta(key,value) VALUES('schema_version','2')").run();
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}

export function createLearningLedger({db,workspaceId,now,grantFor,canRead,isCurrent,readableSources,sessionFor}) {
  const token={};
  const deps=id=>db.prepare('SELECT * FROM unified_learning_dependencies WHERE memory_id=? ORDER BY root_key').all(id);
  function evidence(roots=[],parents=[],legacy=false,userOnly=false) {
    const byRoot=new Map();
    for(const root of roots) {
      const key=rootKey(root),old=byRoot.get(key);
      // A mixed result retains the stricter acquisition if both contributed.
      if(!old || root.mode==='borrow')byRoot.set(key,Object.freeze({...root}));
    }
    const result=Object.freeze({roots:Object.freeze([...byRoot.values()]),parents:Object.freeze([...new Set(parents)]),legacy,userOnly});
    capabilities.set(result,token);return result;
  }
  function assertEvidence(value) {
    if(capabilities.get(value)!==token)throw Error('UNTRUSTED_LEARNING_EVIDENCE');
    return value;
  }
  function latestSeq(identity) {
    const session=sessionFor(identity.sessionId);
    const events=session?.snapshotEvents?.() ?? session?.events ?? [];
    return events.reduce((n,e)=>Number.isSafeInteger(e.seq)?Math.max(n,e.seq):n,0);
  }
  function originalRoots(memory) {
    const inherited=deps(memory.id);
    let sources=db.prepare('SELECT source_key FROM unified_memory_sources WHERE memory_id=?').all(memory.id).map(x=>x.source_key);
    if(!sources.length && memory.scene_scope)sources=[memory.scene_scope];
    return [...inherited,...sources.map(source_key=>({source_key,origin_id:memory.id,
      content_hash:hash([memory.title,memory.content]),channel:'memory',source_session_id:null,expires_at:null}))];
  }
  function acquisition(identity,root) {
    // Existing permanent learning belongs to this same stable source, not to
    // every future reader of the learned row.
    if(root.learner_key===identity.sourceKey && root.mode==='learn')return {...root};
    const grant=grantFor(root.source_key,identity.sourceKey);
    return {...root,mode:grant?.mode==='learn'?'learn':'borrow',grant_id:grant?.grant_id??null,
      learner_key:identity.sourceKey,allow_reshare:0};
  }
  function storeReceipt(identity,id,digest,roots,kind,seq) {
    if(!roots.length)return null;
    const receiptId=randomUUID(),text=JSON.stringify(roots.map(r=>{
      const {memory_id,root_key,receipt_id,...rest}=r;return rest;
    }).sort((a,b)=>rootKey(a).localeCompare(rootKey(b))));
    db.prepare(`INSERT INTO unified_learning_receipts
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,session_id,delivered_id,delivered_hash,roots_json,delivery_kind)
      DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)`)
      .run(receiptId,workspaceId,identity.sessionId,identity.sourceKey,id,digest,text,kind,seq,seq,now());
    return db.prepare(`SELECT id FROM unified_learning_receipts WHERE workspace_id=? AND session_id=?
      AND delivered_id=? AND delivered_hash=? AND roots_json=? AND delivery_kind=?`)
      .get(workspaceId,identity.sessionId,id,digest,text,kind).id;
  }
  function recordDelivery(identity,rows,kind='tool',seq=latestSeq(identity)) {
    if(!isCurrent(identity)||!Number.isSafeInteger(seq)||seq<0)throw Error('LEARNING_DELIVERY_DENIED');
    const prepared=[];
    for(const delivered of rows) {
      const row=db.prepare('SELECT * FROM memories WHERE id=?').get(delivered.id);
      if(!row||!canRead(identity,row))throw Error('LEARNING_DELIVERY_DENIED');
      const roots=originalRoots(row).filter(r=>r.source_key!==identity.sourceKey).map(r=>acquisition(identity,r));
      prepared.push([row.id,hash([delivered.title??row.title,delivered.content??row.content]),roots]);
    }
    // All deliveries are checked before any credential is persisted.
    return prepared.map(([id,digest,roots])=>storeReceipt(identity,id,digest,roots,kind,seq)).filter(Boolean);
  }
  function recordRecent(identity,sourceIdentity,items,seq=latestSeq(identity)) {
    if(!isCurrent(identity)||!isCurrent(sourceIdentity))throw Error('LEARNING_DELIVERY_DENIED');
    for(const item of items) {
      const digest=hash(item.summary),id=`recent:${sourceIdentity.sessionId}:${item.occurredAt}:${digest}`;
      const inherited=item.provenanceKey ? recentRoots(item.provenanceKey) : [];
      const roots=([...inherited,{source_key:sourceIdentity.sourceKey,origin_id:id,content_hash:digest,
        channel:'recent',source_session_id:sourceIdentity.sessionId,expires_at:item.expiresAt??Date.now()}])
        .filter(r=>r.source_key!==identity.sourceKey).map(r=>acquisition(identity,r));
      storeReceipt(identity,id,digest,roots,'recent',seq);
    }
  }
  function historyEvidence(identity,{sinceSeq=-1,untilSeq=Number.MAX_SAFE_INTEGER,window=false}={}) {
    if(!isCurrent(identity))throw Error('UNIFIED_SESSION_INVALID');
    const records=db.prepare(`SELECT * FROM unified_learning_receipts
      WHERE workspace_id=? AND session_id=? AND first_seq<=? ORDER BY first_seq,id`).all(workspaceId,identity.sessionId,untilSeq);
    const legacy=Boolean(db.prepare('SELECT 1 FROM unified_learning_migration WHERE marker_key=?').get(`shared-history:${workspaceId}:${identity.sessionId}`));
    const roots=records.flatMap(row=>JSON.parse(row.roots_json).map(r=>({...r,receipt_id:row.id})));
    // A fresh distillation request can isolate new, original human messages
    // from ambiguous older assistant/tool history. It is not a context reset.
    const newDeliveries=records.some(row=>row.last_seq>sinceSeq && row.first_seq<=untilSeq);
    const expiredBorrow=roots.some(r=>r.mode==='borrow'&&!rootPermitted(identity,r,identity.sourceKey));
    if(window && (legacy || expiredBorrow || (roots.length>0&&!newDeliveries)))return evidence([],[],false,true);
    return evidence(roots,records.map(r=>r.delivered_id),legacy,false);
  }
  function memoryEvidence(identity,ids) {
    const roots=[];
    for(const id of new Set(ids)) {
      const row=db.prepare('SELECT id,scene_scope FROM memories WHERE id=?').get(id);
      if(!row||!canRead(identity,row))throw Error('LEARNING_PARENT_DENIED');
      roots.push(...deps(id));
    }
    return evidence(roots,ids);
  }
  function combine(...values) {
    values.forEach(assertEvidence);
    return evidence(values.flatMap(x=>x.roots),values.flatMap(x=>x.parents),values.some(x=>x.legacy));
  }
  function rootPermitted(identity,root,ownerKey) {
    if(root.source_key===identity.sourceKey)return true;
    if(root.mode==='learn' && root.learner_key===identity.sourceKey && ownerKey===identity.sourceKey)return true;
    if(root.channel==='memory'||root.mode==='learn')return readableSources(identity).has(root.source_key);
    if(!(root.expires_at>Date.now()))return false;
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='recent_activity_source_policy'").get())return false;
    const policy=db.prepare('SELECT * FROM recent_activity_source_policy WHERE workspace_id=? AND source_session_id=?')
      .get(workspaceId,root.source_session_id);
    if(!policy?.enabled)return false;
    if(policy.mode==='owner')return identity.owner===true;
    if(policy.mode!=='shared')return false;
    try{return JSON.parse(policy.allowlist).includes(identity.sessionId);}catch{return false;}
  }
  function canUseEvidence(identity,value) {
    assertEvidence(value);
    return !value.legacy && value.roots.every(root=>rootPermitted(identity,root,identity.sourceKey));
  }
  function recentRoots(key) {
    const row=db.prepare('SELECT roots_json FROM unified_recent_dependencies WHERE event_key=?').get(key);
    return row?JSON.parse(row.roots_json):[];
  }
  function saveRecentEvidence(key,identity,value) {
    assertEvidence(value);if(!canUseEvidence(identity,value))throw Error('LEARNING_BORROW_EXPIRED');
    db.prepare('INSERT OR REPLACE INTO unified_recent_dependencies VALUES(?,?,?)')
      .run(key,identity.sourceKey,JSON.stringify(value.roots));
  }
  function canReadRecent(key,identity) {
    const row=db.prepare('SELECT * FROM unified_recent_dependencies WHERE event_key=?').get(key);
    return !row || JSON.parse(row.roots_json).every(root=>rootPermitted(identity,root,row.owner_key));
  }
  function attach(id,identity,value) {
    assertEvidence(value);
    if(!isCurrent(identity))throw Error('UNIFIED_SESSION_INVALID');
    if(value.legacy)throw Error('LEGACY_HISTORY_REQUIRES_CLEAN_INPUT');
    if(!canUseEvidence(identity,value))throw Error('LEARNING_BORROW_EXPIRED');
    for(const root of value.roots) {
      const receipt=db.prepare('SELECT 1 FROM unified_learning_receipts WHERE id=? AND workspace_id=?').get(root.receipt_id,workspaceId);
      if(!receipt)throw Error('LEARNING_RECEIPT_MISSING');
      db.prepare(`INSERT INTO unified_learning_dependencies
        (memory_id,root_key,source_key,origin_id,content_hash,mode,learner_key,receipt_id,grant_id,channel,source_session_id,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id,root_key) DO UPDATE SET
        mode=CASE WHEN mode='borrow' OR excluded.mode='borrow' THEN 'borrow' ELSE 'learn' END`)
        .run(id,rootKey(root),root.source_key,root.origin_id,root.content_hash,root.mode,identity.sourceKey,
          root.receipt_id,root.grant_id??null,root.channel,root.source_session_id??null,root.expires_at??null);
    }
    for(const parent of value.parents)if(parent!==id)db.prepare('INSERT OR IGNORE INTO unified_derivation_edges VALUES(?,?,?)').run(id,parent,now());
  }
  function restrictionSql(identity,alias) {
    const sources=[...readableSources(identity)],marks=sources.map(()=>'?').join(',')||'NULL';
    const recentTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recent_activity_source_policy'").get();
    const recent=recentTable ? `(ld.channel='recent' AND ld.mode='borrow' AND ld.expires_at>? AND EXISTS (
        SELECT 1 FROM recent_activity_source_policy rp WHERE rp.workspace_id=? AND rp.source_session_id=ld.source_session_id
        AND rp.enabled=1 AND ((rp.mode='shared' AND EXISTS(SELECT 1 FROM json_each(rp.allowlist) WHERE value=?))
          OR (rp.mode='owner' AND ?=1))))` : '0';
    return {sql:`NOT EXISTS (SELECT 1 FROM unified_learning_dependencies ld WHERE ld.memory_id=${alias}.id AND NOT (
      (ld.mode='learn' AND ld.learner_key=? AND ${alias}.scene_scope=?)
      OR ld.source_key=?
      OR ((ld.channel='memory' OR ld.mode='learn') AND ld.source_key IN (${marks}))
      OR ${recent}))`,
      params:[identity.sourceKey,identity.sourceKey,identity.sourceKey,...sources,
        ...(recentTable?[Date.now(),workspaceId,identity.sessionId??'',identity.owner?1:0]:[])]};
  }
  function permitted(identity,id) {
    const predicate=restrictionSql(identity,'m');
    return Boolean(db.prepare(`SELECT 1 FROM memories m WHERE id=? AND (${predicate.sql})`).get(id,...predicate.params));
  }
  return {recordDelivery,recordRecent,historyEvidence,memoryEvidence,combine,attach,restrictionSql,permitted,
    canUseEvidence,saveRecentEvidence,canReadRecent,derivationFor:deps,emptyEvidence:()=>evidence(),assertEvidence,
    learningStats:()=>({receipts:db.prepare('SELECT COUNT(*) n FROM unified_learning_receipts WHERE workspace_id=?').get(workspaceId).n})};
}
