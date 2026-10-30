import { listWorkspaceSessionIds } from "./workspace-gate.js";
import { createHash } from "node:crypto";

function revision(deps) {
  const db = deps.store.db, w = deps.activeWorkspaceId;
  return createHash('sha256').update(JSON.stringify([
    db.prepare('SELECT * FROM unified_long_term_policies WHERE workspace_id=? ORDER BY source_key').all(w),
    db.prepare('SELECT * FROM unified_long_term_grants WHERE workspace_id=? ORDER BY source_key,reader_key').all(w)
  ])).digest('hex');
}

export async function unifiedDisplay(ctx, snapshot) {
  // Display projection only: titles never contribute to authorization.
  try {
    const controller = ctx.reflect?.get?.('sessionController') ?? ctx.sessionController;
    const listed = await controller?.list?.({});
    const items = new Map((listed?.items ?? []).map(item=>[item.sessionId,item]));
    for (const row of snapshot.sessions) {
      const item = items.get(row.id), title = item?.projections?.values?.title;
      if (typeof title === 'string') row.title = title.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200);
      if (Number.isFinite(item?.updatedAt)) row.last_activity = new Date(item.updatedAt).toISOString();
    }
  } catch { /* Missing optional title projection is shown as the stable ID. */ }
  return snapshot;
}

export function unifiedSnapshot(deps) {
  const runtime = deps.unifiedRuntime;
  const ids = listWorkspaceSessionIds(deps.ctx, deps.activeWorkspaceId).sessionIds ?? [];
  const db = deps.store.db;
  const sessions = ids.map(id => {
    const identity = runtime?.acl.identify(id);
    const source = identity?.sourceKey;
    let session;
    try { session = (deps.ctx.reflect?.get?.('sessions') ?? deps.ctx.sessions)?.get?.(id); } catch {}
    return { id, title: String(session?.header?.title ?? session?.title ?? id).slice(0,200),
      last_activity: session?.header?.updatedAt ?? session?.header?.createdAt ?? null,
      verified: Boolean(identity), source: source ?? null,
      owner_read: source ? Boolean(db.prepare("SELECT owner_read FROM unified_long_term_policies WHERE workspace_id=? AND source_key=?").get(deps.activeWorkspaceId,source)?.owner_read) : false,
      outgoing: source ? db.prepare("SELECT reader_key FROM unified_long_term_grants WHERE workspace_id=? AND source_key=?").all(deps.activeWorkspaceId,source).map(r=>r.reader_key) : [],
      incoming: source ? db.prepare("SELECT source_key FROM unified_long_term_grants WHERE workspace_id=? AND reader_key=?").all(deps.activeWorkspaceId,source).map(r=>r.source_key) : [] };
  });
  return { enabled: Boolean(runtime), configured: (deps.settings.getFeatureFlags().unifiedSessionAclEnabled ?? deps.config?.unifiedSessionAclEnabled) === true,
    workspace_id: deps.activeWorkspaceId, sessions, revision: revision(deps),
    limitations: ['历史来源无法验证的会话拒绝访问；可创建新会话。', '全局别名、稳定 ID 和合并管理只对管理员开放。', '连续性文件救援与自动工作流提议暂不在统一 ACL 模式运行。', '后台任务只处理仍有可信会话的来源，不继承读取共享。', '模型写入后的全库 Markdown 镜像延后至管理员同步或重启恢复，避免来源视图覆盖完整镜像。'],
    migration: { legacy_count: db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scene_scope IS NULL").get().n,
      legacy_preview: db.prepare("SELECT id,title FROM memories WHERE scene_scope IS NULL ORDER BY id LIMIT 20").all(),
      action: '隔离保留，升级前使用备份页创建一致性快照；不自动分配旧记忆来源。' } };
}

export function saveUnifiedPolicy(deps, body) {
  const runtime = deps.unifiedRuntime;
  if (!runtime) throw new Error("UNIFIED_RESTART_REQUIRED");
  const source = runtime.acl.identify(body.session_id);
  if (!source || typeof body.owner_read !== "boolean" || !Array.isArray(body.readers) || body.readers.length > 200) throw new Error("UNIFIED_POLICY_INVALID");
  const readers = [...new Set(body.readers)].map(id => runtime.acl.identify(id));
  if (readers.some(reader => !reader || reader.sourceKey === source.sourceKey)) throw new Error("UNIFIED_READER_INVALID");
  deps.service.transaction(() => {
    if (body.revision !== undefined && body.revision !== revision(deps)) throw new Error('UNIFIED_POLICY_CONFLICT: reload before saving');
    deps.store.db.prepare("DELETE FROM unified_long_term_grants WHERE workspace_id=? AND source_key=?").run(deps.activeWorkspaceId,source.sourceKey);
    runtime.acl.setOwnerRead(source.sourceKey,body.owner_read);
    for (const reader of readers) runtime.acl.setGrant(source.sourceKey,reader.sourceKey,true);
  });
  return unifiedSnapshot(deps);
}

export function unifiedGraph(deps, sessionId) {
  const render = () => {
    const nodes = deps.store.listEntities({limit:200});
    const ids = new Set(nodes.map(n=>n.id)), edges = new Map();
    for (const node of nodes) {
      node.attrs = deps.store.getCurrentAttrs(node.id);
      for (const edge of deps.store.getRelations(node.id)) {
        if(ids.has(edge.from_entity) && ids.has(edge.to_entity)) edges.set(edge.id,edge);
      }
    }
    return { nodes, edges:[...edges.values()], truncated:nodes.length===200 };
  };
  if (!sessionId) return render();
  if (!deps.unifiedRuntime) throw new Error("UNIFIED_RESTART_REQUIRED");
  return deps.unifiedRuntime.authorize.run({id:sessionId},render);
}
