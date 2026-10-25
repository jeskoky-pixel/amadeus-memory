# Amadeus Memory — Final Productization Report

日期：2026-10-25
分支：`codex/memory-enhancer`
包版本：`0.9.5-amadeus.1`（未改包名、插件 ID 或版本）
本轮未提交 Git、未安装到生产 Profile、未修改生产/默认 `~/.dsh/memory`、未调用真实远端 Embedding。

## 0. 本轮改动文件

修改：

- `.gitignore`
- `README.md`
- `dsh-mneme/README.md`
- `dsh-mneme/docs/BACKUP_ROLLBACK.md`
- `dsh-mneme/docs/INSTALL.md`
- `dsh-mneme/docs/USER_GUIDE.zh.md`
- `dsh-mneme/src/index.js` / `dsh-mneme/lib/index.js`
- `dsh-mneme/src/store.js` / `dsh-mneme/lib/store.js`
- `dsh-mneme/src/admin-api.js` / `dsh-mneme/lib/admin-api.js`
- `dsh-mneme/lib/client.js`
- `dsh-mneme/test/memory-productization.test.js`
- `dsh-mneme/test/memory-enhancer-quality-extra.test.js`
- `dsh-mneme/package.json`

新增：

- `dsh-mneme/src/backup.js` / `dsh-mneme/lib/backup.js`
- `dsh-mneme/src/qa-guard.js` / `dsh-mneme/lib/qa-guard.js`
- `dsh-mneme/test/qa-guard.test.js`
- `dsh-mneme/test/backup.test.js`
- `dsh-mneme/test/memory-management-api.test.js`
- `dsh-mneme/test/lifecycle-productization.test.js`
- `dsh-mneme/scripts/qa-guard.mjs`
- `dsh-mneme/scripts/quality.mjs`
- `dsh-mneme/scripts/privacy-check.mjs`
- `dsh-mneme/scripts/safe-test-tmp.mjs`
- `dsh-mneme/scripts/compat-windows.mjs`
- `dsh-mneme/scripts/package-hash.mjs`
- `dsh-mneme/scripts/privacy-check.mjs`
- `dsh-mneme/scripts/safe-test-tmp.mjs`
- `dsh-mneme/scripts/compat-windows.mjs`
- `dsh-mneme/scripts/clean-test-tmp.mjs`
- `dsh-mneme/scripts/measure-productization.mjs`
- `dsh-mneme/docs/PERFORMANCE.md`
- `dsh-mneme/docs/QA_GUARD.md`
- `dsh-mneme/test/safe-clean.test.js`
- `dsh-mneme/test/store-concurrent-init.test.js`
- `dsh-mneme/test/helpers/store-init-worker.mjs`
- `dsh-mneme/test/release-package-workflow.test.js`
- `docs/QA_FAILURE_INVENTORY.md`
- `docs/WINDOWS_COMPATIBILITY.md`
- `docs/CREATOR_FINAL_PRODUCTIZATION.md`

## 1. P0 QA/install memoryDir guard

`src/qa-guard.js` (synced to `lib/`) is a reusable QA/install preflight. It is
not imported by production `apply()`, so existing end-user configurations are
unchanged.

- Requires an explicit **absolute** `qaRoot` and an explicit absolute `memoryDir`.
- Canonicalizes with `realpathSync.native`; Windows junctions/symlinks, case and
  8.3/long-path aliases resolve to one identity.
- Rejects equal to or inside `~/.dsh/memory` (derived from `homedir()`) plus any
  caller-supplied `forbiddenDirs` / `--forbid` production roots.
- Resolves the nearest existing ancestor before creating the target, so a
  junction/symlink in the parent chain cannot write through to a user directory.
- Rejects traversal, other volumes and escape from the selected QA root; rejects
  equal-to-root; fails closed when identity is unresolved or the target is not a
  directory.
- Allowed nested path under an explicit QA root is canonicalized and returned.

CLI: `node scripts/qa-guard.mjs --qa-root <abs> --memory-dir <abs>`.
API: `assertIsolatedMemoryDir(target, { qaRoot, forbiddenDirs })`.

`test/qa-guard.test.js` covers default derivation, synthetic private root, junction alias
to a custom forbidden directory, traversal, missing root, non-directory target
and an allowed nested path. `backup.test.js`, `memory-management-api.test.js`,
`lifecycle-productization.test.js` and the measurement script invoke the guard
before creating a store/plugin. No test uses an implicit/default memoryDir.

### Safe test-temp cleanup

`scripts/safe-test-tmp.mjs` removes only the exact canonical
`<repo>/.test-tmp`; it rejects a root symlink/junction and walks children without
following reparse points. `scripts/quality.mjs` and
`scripts/clean-test-tmp.mjs` use it. `test/safe-clean.test.js` covers the allowed
directory, a root alias and a nested alias; targets outside `.test-tmp` remain
untouched. Cleanup fails closed instead of following a junction.

### Privacy scan

`scripts/privacy-check.mjs` scans both the source tree and the packed `.tgz`
contents (minimal tar parser) for:

- the actual local user profile path (derived from `homedir()`),
- caller-provided private roots via `AMADEUS_PRIVATE_PATHS`,
- creator/cordis session-ID patterns,
- credential patterns (private keys, AWS/GitHub/Slack/OpenAI-style tokens).

Known synthetic security-test fixtures are explicitly allowlisted. A matching
path/credential fails the package gate.

## 2. 本轮产品实现

### 日常记忆管理（原生 Settings 页面）

`lib/client.js` 的 **Amadeus 记忆 / Amadeus Memory** 页新增：

- 搜索框（标题/正文关键词）、归档筛选、每页 20 条、上一页/下一页；
- 新建记忆：类型、标题、正文、重要度 1–5、标签；
- 编辑：title/content/importance/tags，使用 `updated_at` 乐观并发检查；
- 归档/取消归档；
- 删除：二次确认，确认文案明确不可撤销，并提示先创建备份；
- 所有操作走 owner 同源 Host API，普通用户不需要手写 JSON、token 或内部 API；
- 失败/冲突/加载/禁用状态可见；编辑冲突显示“已被其他页面修改”，不会静默覆盖。

### 安全备份、恢复、升级与回滚

新增 `src/backup.js`、`lib/backup.js`，并在开启数据库前应用暂存恢复：

- 备份使用 SQLite `VACUUM INTO` 生成一致性快照；
- 备份校验：SQLite 文件头、`PRAGMA quick_check`、`memories` 表、SHA-256；
- 恢复只接受 `memoryDir/backups/` 下的普通 `.db` 文件名，拒绝路径穿越；
- **运行中不覆盖数据库**：恢复先写 marker，下次启动在 `createStore()` 前执行；
- 应用前先复制当前 `memory.db`、`-wal`、`-shm` 到 `backups/pre-restore-<UTC>/`；
- 任一步失败时保留/恢复原文件集，marker 改名为 `.failed-*`，不会启动空库；
- 恢复后保留安全现场，可人工回滚；
- 设置页“恢复默认参数”只 unset 配置字段；“恢复默认权重”只清权重表，均不删除记忆；
- 备份文件含 Memory 数据/可能含向量配置，文档说明按敏感数据保护。

API（owner、same-origin、写请求标记）：

- `GET /api/amadeus-memory/admin/memories`
- `GET /api/amadeus-memory/admin/memory?id=`
- `POST /api/amadeus-memory/admin/memory`
- `POST /api/amadeus-memory/admin/memory/update`
- `POST /api/amadeus-memory/admin/memory/archive`
- `POST /api/amadeus-memory/admin/memory/delete`（`confirm: "DELETE"`）
- `POST /api/amadeus-memory/admin/backup`
- `GET /api/amadeus-memory/admin/backups`
- `POST /api/amadeus-memory/admin/restore/check`
- `POST /api/amadeus-memory/admin/restore`（`confirm: "RESTORE"`，只暂存）

### 设置页细节

- 中英双语标签，中文优先；
- 每个 Config Form 数字字段显示默认值、范围、单位；
- 保存/取消/恢复默认/冲突反馈；
- 窄窗口 `@media (max-width:560px)` 自动换行/减小 padding，列表与按钮 `flex-wrap`，无固定超宽输入；
- `:focus-visible` 键盘焦点样式；
- 利用现有 light/dark theme variables；
- 加载、错误、禁用、空状态；
- 高风险删除、恢复均有显式确认；
- API Key 仍只显示掩码，不返回明文；GUI 不绕过 DSH owner 权限。

## 2. 数据兼容与边界

- 保持 `@modusensus/dsh-mneme`、插件/Bundle ID `dsh-mneme`、版本 `0.9.5-amadeus.1`；
- 沿用原 SQLite schema/`memoryDir`，新增表为 additive；备份/恢复不建立第二套数据库；
- 不修改上游 Mneme 既有记忆语义；没有运行生产数据库迁移；
- 所有自动化测试使用显式 `.test-tmp`/`memoryDir` 隔离路径，并断言不包含 `/.dsh/`；
- 未删除、回滚或修改任何现有 DB/Profile/session。

## 3. 真实测试

### Targeted（最终代码）

- `client.test.js` 82/82
- `qa-guard.test.js` 4/4
- `memory-productization.test.js` 5/5
- `memory-admin-api.test.js` 5/5
- `memory-management-api.test.js` 3/3
- `backup.test.js` 2/2
- `lifecycle-productization.test.js` 1/1
- `webServer-optional.test.js` 4/4
- `standalone-api.test.js` 30/30
- `failure-retention.test.js` 5/5
- `config.test.js` 4/4
- `security-doc.test.js` 6/6
- `release-docs.test.js` 9/9
- `readme-claims.test.js` 3/3
- `test-count-sync.test.js` 4/4
- `tools.test.js` 30/30

Default documented command is now **`npm test`**, which delegates to the green
product gate `npm run quality:amadeus` (clean test temp, sync, check-sync, privacy,
**490/490** selected runtime/enhancer/GUI/config/migration/package/fork-release
tests). Upstream-only and capability tests are separate, explicitly non-green:

```powershell
npm test                      # green product gate: 490/490
npm run test:all              # full suite; current Windows result is not green
npm run test:upstream-release # upstream release-only tests, expected non-green
npm run test:compat-windows   # symlink/spawn capability probe, non-green if unavailable
```

门禁：`npm run sync`（83 files）、`check-sync`、`node --check lib/client.js`、`git diff --check` 通过（仅 LF→CRLF 警告）。

### 完整 standard sweep（不是默认门禁）

`npm run test:all` / inventory sweep（latest source）：

- **190 files；2392 tests；2359 pass；32 fail；1 skip；1 timeout**

After that sweep, the admin archived-status HTTP regression, the concurrent
fresh-DB regression and the release-package workflow regression added three
passing tests; the current source total is 2395 tests and the product gate is
490/490. The full sweep was not rerun for those targeted additions; the 32
failures below are unchanged.

失败清单的逐测试明细在 [QA_FAILURE_INVENTORY.md](QA_FAILURE_INVENTORY.md)。`lib-smoke` 的缺失 `lib/qa-guard.js` 是真实同步回归，已用 `npm run sync` 修复并 6/6 通过；当前 32 fail 不含它。

### Admin archived-status regression

The native settings page created/edited/archived a synthetic memory in a fresh
isolated Desktop. The overview counted `archived: 1`, but the archived list
returned `archived: false`: `service.toApiList()` intentionally omits
archived/forgotten from the shared DTO, and the admin projection used
`Boolean(undefined)`.

The fix keeps the model-tool DTO unchanged and overlays status from the
authoritative store row in both `memorySummary()` and `memoryFull()` (including
create/update/archive responses). The HTTP regression creates, archives, lists
archived, reads detail, unarchives, lists active, and also checks a
quality-filter auto-archived short row. The GUI create feedback now explicitly
says the quality filter archived the new memory and points to “Show archived”,
so it no longer appears to vanish silently. The quality policy is unchanged.

### Concurrent fresh-DB initialization

A repeated default-gate failure exposed a real Windows race: two fresh workers
could both open the same new SQLite path; one `PRAGMA journal_mode = WAL`
returned `SQLITE_BUSY` despite `busy_timeout`. `createStore()` now retries the
WAL transition, schema initialization, identity seed and migration/index steps
with bounded exponential backoff (only for BUSY/LOCKED), so concurrent first
boot converges. The intake test harness also marks both `ready` and `result`
promise branches as observed, so a recoverable startup rejection cannot become
an unhandledRejection before retry; the true two-worker idempotency assertion
and bounded retries remain.

`test/store-concurrent-init.test.js` starts 8 workers on a fresh path for 4
rounds; run repeatedly (5/5) alongside 10/10 quality-extra runs. The production
DTO/tool shape and quality policy are unchanged.

### Release package workflow

`npm run package:amadeus` previously ran the full privacy check before packing;
that compared the existing tarball against stale `PACKAGE_INFO.json` and failed
after any legitimate README/source change. The workflow is now phased:

1. `quality:amadeus` runs **source-only** privacy (no dist comparison).
2. deterministic `npm pack`.
3. `scripts/package-hash.mjs` writes final `PACKAGE_INFO.json` and
   `BUILD_INFO.json` with archive SHA-256/bytes/file count, current Git HEAD and
   worktree dirty state.
4. postpack `scripts/privacy-check.mjs` scans source + packed tarball and
   verifies metadata; both phases still run.

`test/release-package-workflow.test.js` simulates stale metadata + changed
README: source privacy passes, rebuild/metadata match the new archive, and a
packed credential/private path still fails. The real workflow was exercised after
a README badge change with stale prior metadata and succeeded.



### 失败分类（不是产品测试失败）

**21 项：上游 release-only 夹具/workflow 缺失，不应复制到私有 fork**

- `pipeline.test.js` 13（缺项目 `.mneme/pipelines/dsh-mneme-release.json`）
- `workflow-guards.test.js` 7（缺 `.github/workflows/*`）
- `pipeline-runner.test.js` 1（内容锁/测试硬编码 `D:/mem-test`，与上游项目夹具绑定）

这些是上游公开 npm/GitHub 自动发布流程的内容锁；本仓库是私有产品化 fork，不应复制或发明自动发布 workflow。建议将这些 release-only 测试 scoped 到上游仓库，或在 fork 的测试矩阵中明确 skip（保留原因），同时保留本地产品测试/包/安全门禁。本轮没有删除断言、没有伪造 PASS、没有新增 workflow。

**11 项：当前 Windows 文件/进程 sandbox 环境**

- symlink 创建失败：`capabilities` 1、`session-usage` 1
- 子进程 spawn/pipe EPERM：`maintenance` 2、`peer-blockers` 1、`publish-gate` 1、`release-notes` 3、`serve-bin` 2
- `mcp-stdio` 1 timeout（sandbox 禁止 piped child stdio）

这些未标 PASS；在能创建 symlink/spawn 子进程的上游/Linux CI 中应重新执行。

## 4. 性能与 token 成本（实测）

`dsh-mneme/scripts/measure-productization.mjs`，500 条合成记忆，显式隔离目录，无远端请求：

| Metric | Result |
|---|---|
| list limit 20 | 0.288 ms/op |
| keyword search limit 20 | 0.161 ms/op |
| backup (`VACUUM INTO`) | 11.403 ms |
| backup size | 884,736 bytes |
| preflight (`quick_check` + SHA) | 2.154 ms |
| injection render | 4.308 ms/turn |
| injected block | 1,170 chars |
| approximate tokens (chars/4) | 293 tokens/turn |

Token estimate is conservative and not a host tokenizer measurement; actual tokens vary with language, host tokenizer, `maxInjectedItems`, `injectContentMaxChars`, and pinned entries. Remote Embedding latency/model consolidation cost is not measured.

## 5. 最终包

- 包：`@modusensus/dsh-mneme@0.9.5-amadeus.1`
- 路径：`dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz`
- **SHA-256：`e861c5cfab215968fd401abc8c4c358fbaf4a8517f9b0b4aaba25b53fa7ad4c1`**
- 大小：2,208,079 bytes
- 文件数：419
- 连续两次 `npm pack --ignore-scripts --cache .npm-cache` 哈希一致
- `dist/` 已忽略，包内不含 `node_modules`、SQLite、日志、`.test-tmp`、`.tmp-*`、`.productization-task` 或真实数据
- `dist/modusensus-dsh-mneme-0.9.4.tgz` 是**历史上游回滚资产**，不是当前产品；标签见 `dist/HISTORICAL_0.9.4.md`，未删除。

## 6. Codex 隔离 Desktop 验收步骤

1. 创建/确认一个显式隔离 `memoryDir`，检查它不是用户默认 Memory 目录，也不要指向任何生产 DB；记录解析后的绝对路径。
2. 用最终 tarball 安装到隔离 Profile，只启用一个 Memory。
3. 设置 → **Amadeus 记忆 / Amadeus Memory**：确认加载/错误/空状态、中文标签、英文标签、窄窗口、键盘焦点。
4. 新建一条合成记忆；搜索、编辑、归档/取消归档；删除时确认会出现二次确认；不要使用真实数据。
5. 双页面打开同一条并同时保存：第二个应显示冲突而不覆盖；单页面保存不得误报冲突。
6. 备份：创建、查看 SHA、校验；确认备份文件名/大小/时间；暂存恢复需要勾选确认。
7. 重启 DSH：确认恢复在启动前应用，`pre-restore-*` 现场存在；用损坏/checksum 不符备份确认失败时原库可打开。
8. 设置页保存/取消/恢复默认/冲突；确认“恢复默认”只改参数、不删除记忆。
9. 确认 Embedding key 只显示掩码；测试按钮只在点击时发请求。
10. 禁用/启用/重装：入口只出现一次、没有重复后台任务、记忆保留；打开原 Memory 面板搜索/图谱正常。
11. 记录最终 SHA、截图、日志和实际 `memoryDir`；不要在生产 Profile 或真实 DB 上执行。

## 7. 剩余未过门槛

- 真实 DSH GUI/Plugin Manager 安装、硬重启、浏览器截图仍由 Codex 执行；本轮没有安装。
- 21 项上游 release-only 测试未通过（见上），不属于本 fork 产品缺陷，也未复制 workflow。
- 11 项 sandbox 环境测试失败 + `mcp-stdio` timeout，见上；精确能力探测与说明见 [WINDOWS_COMPATIBILITY.md](WINDOWS_COMPATIBILITY.md)。
- 真实远端 Embedding 延迟/语义质量未测；性能数字仅本地合成数据。
- 没有提交 Git、没有公共发布、没有生产/真实平台/支付/凭据改动。
