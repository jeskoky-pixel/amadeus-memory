import { runWithSceneJob } from "./scene-job.js";
import { createUnifiedSessionAcl, runWithUnifiedSession, currentUnifiedSession } from "./unified-session-acl.js";
import { runWithTrustedScene } from "./scene.js";

function host(ctx, name) {
  try { return typeof ctx.reflect?.get === "function" ? ctx.reflect.get(name) : ctx[name]; }
  catch { return undefined; }
}

export function createUnifiedRuntime({ ctx, db, workspaceId, authorizeWorkspace, enabled }) {
  let disposed = false;
  let qqMarked = false;
  const observingSince = Date.now();
  const session = id => host(ctx, "sessions")?.get?.(id) ?? null;
  function ordinaryStamp(s, { create = false, observed = false } = {}) {
    const raw = s.header?.createdAt;
    const created = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(created)) return false;
    const key = `ordinary:${workspaceId}:${s.id}`;
    const prior = db.prepare('SELECT value FROM unified_acl_meta WHERE key=?').get(key);
    if (prior) return prior.value === String(created);
    if (!create || (!observed && (created <= observingSince || created > Date.now()))) return false;
    db.prepare('INSERT OR IGNORE INTO unified_acl_meta(key,value) VALUES(?,?)').run(key,String(created));
    return true;
  }
  // Persist the dependency so disabling QQ cannot reclassify its old Sessions.
  const markQQ = () => {
    const qq = host(ctx, "qq");
    if (qq && !qqMarked) {
      db.prepare("INSERT OR IGNORE INTO unified_acl_meta(key,value) VALUES('qq_contract_required','1')").run();
      qqMarked = true;
    }
    return qq;
  };
  const acl = createUnifiedSessionAcl({ db, workspaceId,
    resolveTrustedSession: session,
    authorizeWorkspace: s => !disposed && enabled() ? authorizeWorkspace(s) : { allowed: false },
    resolveTrustedQQScene: id => {
      const qq = markQQ();
      try { return qq?.resolveTrustedSessionScene?.(id) ?? null; } catch { return null; }
    },
    confirmOrdinarySession: s => {
      const qq = markQQ();
      if (!qq) {
        if (ordinaryStamp(s)) return true;
        if (db.prepare("SELECT 1 FROM unified_acl_meta WHERE key='qq_contract_required'").get()) return false;
        // Standalone installs also quarantine historical provenance. Persist
        // only Host Sessions actually observed during this runtime lifetime.
        return ordinaryStamp(s,{create:true});
      }
      if (qq.sessionProvenanceVersion !== 1) return false;
      const classification = qq.classifySession?.(s.id);
      if (classification?.kind === 'qq') return false;
      if (classification?.kind === 'ordinary') {
        return ordinaryStamp(s,{create:true,observed:true});
      }
      if (ordinaryStamp(s)) return true;
      return qq.sessionCreationDisabled === true && classification?.reason === 'qq-unconfigured'
        && ordinaryStamp(s,{create:true});
    },
    isTrustedOwner: s => {
      try { const scene = markQQ()?.resolveTrustedSessionScene?.(s.id); return scene?.verified === true && scene.kind === "private" && scene.admin === true; }
      catch { return false; }
    }
  });
  function authorize(s) {
    const identity = acl.identify(s?.id);
    return identity ? { allowed: true, workspaceId, identity } : { allowed: false, reason: "unified-identity-unverified", workspaceId: null };
  }
  authorize.noteSharedRead = (target,items=[]) => {
    const to=authorize(target);if(!to.allowed)throw Error('UNIFIED_SESSION_INVALID');
    for(const id of new Set(items.map(x=>x.sourceSessionId))) {
      if(id===target.id)continue;
      const from=acl.identify(id);if(!from)throw Error('UNIFIED_SESSION_INVALID');
      acl.recordRecentDelivery(to.identity,from,items.filter(x=>x.sourceSessionId===id));
    }
  };
  authorize.derive = authorize;
  authorize.prepareSummary = (s,range) => {
    const access=authorize(s);if(!access.allowed)throw Error('UNIFIED_SESSION_INVALID');
    const evidence=acl.historyEvidence(access.identity,{...range,window:true});
    if(!evidence.userOnly)return {session:s,evidence};
    const from=(range?.sinceSeq??-1)+1,to=range?.untilSeq??Number.MAX_SAFE_INTEGER;
    const events=(s.snapshotEvents?.(from,to+1)??s.events??[]).filter(e=>
      Number.isSafeInteger(e.seq) && e.seq>=from && e.seq<=to &&
      (e.type==='turn/end' || (e.type==='user/message' && e.data?.source?.kind==='user')));
    return {session:{id:s.id,header:s.header,snapshotEvents:()=>events},evidence};
  };
  authorize.prepareRecent = (s,event) => {
    const untilSeq=event.seq??Number.MAX_SAFE_INTEGER;
    const events=s.snapshotEvents?.(Math.max(0,untilSeq-4096),untilSeq)??s.events??[];
    const sinceSeq=events.reduce((last,e)=>e.type==='turn/end' && Number.isSafeInteger(e.seq) && e.seq<untilSeq ? Math.max(last,e.seq) : last,-1);
    return authorize.prepareSummary(s,{sinceSeq,untilSeq});
  };
  authorize.saveRecent = (key,s,evidence) => {
    const identity=acl.identify(s.id);if(!identity)throw Error('UNIFIED_SESSION_INVALID');
    acl.saveRecentEvidence(key,identity,evidence);
  };
  authorize.canReadRecent = (key,s) => {
    const identity=acl.identify(s.id);return !!identity && acl.canReadRecent(key,identity);
  };
  authorize.delivery = (s,rows,kind) => {
    const access=authorize(s);if(!access.allowed)throw Error('UNIFIED_SESSION_INVALID');
    return acl.recordDelivery(access.identity,rows,kind);
  };
  authorize.run = (s, fn, options = {}) => {
    const result = authorize(s);
    if (!result.allowed) throw new Error("UNIFIED_SESSION_INVALID");
    const evidence=options.evidence ?? (options.purpose==='model' ? acl.historyEvidence(result.identity) : null);
    return runWithUnifiedSession(acl, result.identity, () => {
      const execute = () => {
        const value = fn();
        if (value && typeof value.then === "function") return value.then(output => { currentUnifiedSession(); return output; });
        currentUnifiedSession(); return value;
      };
      return result.identity.scene ? runWithTrustedScene(result.identity.scene, execute) : execute();
    },{...options,evidence});
  };
  async function runSources(operation) {
    const bindings = db.prepare("SELECT session_id, source_key FROM unified_session_bindings WHERE workspace_id=?").all(workspaceId);
    const done = new Set(), results = [];
    for (const binding of bindings) {
      if (done.has(binding.source_key)) continue;
      const anchor = acl.identify(binding.session_id);
      if (!anchor || anchor.sourceKey !== binding.source_key) continue;
      done.add(anchor.sourceKey);
      results.push(await runWithSceneJob(anchor.sourceKey, () => runWithUnifiedSession(acl, acl.sourceJob(anchor), operation,{purpose:"job",evidence:acl.emptyEvidence()})));
    }
    return { ok: results.every(r => r?.ok !== false), results, sources: done.size,
      skipped: done.size === 0, reason: done.size ? "source-jobs" : "no-live-trusted-sources" };
  }
  function allowRecentPair(sourceId, targetId) {
    const source = acl.identify(sourceId), target = acl.identify(targetId);
    if (!source || !target) return false;
    // This gate verifies identity only. The recent-activity core independently
    // requires the source's directional policy on every read and after awaits.
    // Long-term grants must never authorize recent activity implicitly.
    return true;
  }
  return { acl, authorize, allowRecentPair, runSources, dispose: () => { disposed = true; } };
}
