# Mneme-lite final review snapshot (2026-10-28)

Branch: `codex/memory-mneme-lite`. Package: `@modusensus/dsh-mneme@1.0.0`.
This is a review candidate, not a production deployment approval.

## Architecture and data boundary

- Original Mneme remains the sole long-term engine. Hot Memory, retrieval,
  importance, autoSummarize, autoDream, Sleep, entity graph and original GUI
  remain mounted. The old Scene jobs, Life trusted-intake path and old Recent
  Context buffer are retired from the lite runtime.
- One stable Workspace Registry ID is selected in the owner GUI. Model tools,
  injection, summarization and recent activity recheck trusted Session
  membership. Missing Registry/binding denies model-side work.
- Each selected Workspace uses its own digest-named data directory. The legacy
  root `memory.db` is never silently adopted. Changing the binding denies the
  current runtime immediately; a plugin restart/remount opens the new store.
- Recent activity uses separate SQLite tables and exact Session IDs. Self,
  Host-verified Owner and explicitly shared modes are checked on each read.
  Revocation affects the next request. Recent rows do not enter long-term
  memory, Dream or Sleep.
- Tag/entity weights are bounded preferences; identity and alias operations
  reuse Mneme entities. SQLite backup and staged restore retain their
  confirmation and restart requirements.

## Isolated Desktop evidence

The official DeepSeek V4.1 Flash 1017 model ran in a separate DSH Desktop
Profile. A1, A2 and A3 were real Sessions in the selected test Workspace;
B1 was in an unselected Workspace. No production DSH Profile, QQ Bridge,
Memory database or key was changed.

- A2 used real `memory_save`, then `memory_search` in keyword mode returned the
  saved record with matching ID and content. A later model turn showed the
  memory in automatic context.
- A1 called `memory_recent_activity` on real model turns. Before sharing it
  saw only A1. After granting A3 → A1 in the GUI, the next context included
  A3 and the tool returned A1 and A3. After GUI revocation, the next context
  omitted A3 and the tool returned only A1. The GUI server preview showed
  one A3 summary and about 98 tokens while the grant was active.
- The recent-activity GUI showed Session titles, last activity, policy
  editing and server preview. The complete memory browser opened in card and
  timeline modes. Entity nodes and a one-hop graph rendered. The status page
  rendered its token cards and chart. The dark theme was inspected. Existing
  real screenshots are in [`screenshots/`](screenshots/).
- The isolated Profile reports Embedding unconfigured. Real vector search,
  provider connectivity and reindexing were **not** verified. Keyword search
  and automatic long-term injection were verified.

## Automated checks

- `npm test`: 708/708 pass, including source/lib synchronization and focused
  Workspace, recent activity, authorization, client and regression tests.
- `npm run privacy:package`: pass; no keys, databases, logs, symlinks or
  temporary task files in the package.
- `git diff --check`: pass.
- The packaged `lib/client.js` SHA-256 matched the working-tree client bundle
  during this review.
- Local recent-activity microbenchmark: 50 rows and 1,000 authorized reads;
  median 0.3093 ms, P95 0.3888 ms. See
  [`MNEME_LITE_PERFORMANCE.md`](MNEME_LITE_PERFORMANCE.md) for scope and gaps.

## Review limits and rollout

- The selected Workspace's existing legacy root database is not migrated by
  this build. Keep it untouched; take a verified snapshot, make an explicit
  migration decision, and test restore on an isolated copy before rollout.
- A binding change needs a plugin restart/remount to activate the new store.
  The old runtime denies immediately; the GUI labels the pending state.
- Narrow-window layout and every original Mneme setting control were not
  exercised end to end in the Desktop. The native Settings sheet's retrieval
  subtab did not reliably display its panel during this pass; the complete
  memory browser and other settings surfaces remained accessible. Treat this
  as a GUI follow-up, not as a validated control.
- Full DSH prompt assembly A/B timing and real vector retrieval remain
  unmeasured. Do not claim a latency or retrieval-quality gain from the local
  SQLite microbenchmark.
- Before production use, configure an Embedding provider in an isolated
  Profile, run semantic search/reindex and an A/B turn trace, then rehearse
  backup/restore. Preserve the previous package and database snapshots for
  rollback. No automatic migration or deployment is performed here.
