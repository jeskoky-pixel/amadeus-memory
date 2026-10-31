# Amadeus Memory — 安装、升级与验收

> 历史安装文档：本页记录 v1.0.1 的旧包名与验收流程。v1.2.0 请使用 [当前安装与升级指南](INSTALL_V1_2.md)，发行包为 `@fg-lab/amadeus-memory`，仓库根目录直接安装。

本包是 **Amadeus Memory 增强发行版**，基于 Mneme 0.9.4，沿用上游 MIT 许可：

- npm 包名：`@amadeus/memory`
- 版本：`1.0.1`（近期活动跨 Session 授权修复；QQ Scene Host、场景图谱与后台整理沿用 1.0.0）
- 插件 ID / Bundle ID：`dsh-mneme`（保持不变）
- 上游：`@modusensus/dsh-mneme@0.9.4`（`UPSTREAM.md` 与 `LICENSE` 保留署名）
- 默认数据目录：`~/.dsh/memory`（保持不变）
- SQLite 格式、配置键、feature flags 与数据路径：与 1.0.0 / 上游兼容，不迁移到第二套数据库。

GitHub 源码仓库为 `https://github.com/jeskoky-pixel/amadeus-memory`。插件位于子目录 `dsh-mneme/`；支持 pnpm `#path:` 的 DSH Git 安装规格为 `git+https://github.com/jeskoky-pixel/amadeus-memory.git#path:/dsh-mneme`。仓库根目录的 `package.json` 是不可安装的私有壳，不能把根 Git URL 直接当插件安装。若安装器不支持 `#path:`，克隆仓库后进入 `dsh-mneme/` 构建 tarball，再用 Plugin Manager 安装。

> 兼容性要点：1.0.1 只改 npm 发行名，插件 ID 仍是 `dsh-mneme`。因此 Profile 里的 Memory 数据、`memoryDir`、`vector` 配置和 feature flags 都可继续使用；但 Plugin Manager 看到的是新包名，**不要同时启用旧 `@modusensus/dsh-mneme` 与新 `@amadeus/memory` 两个实例**，否则会重复 autoDream / 自动注入 / 写入。升级时先停用旧包，再安装新 tarball 并硬重启。

## 首次运行：QQ 记忆的两个开关

QQ 长期记忆不是单一开关，必须**同时**打开：

1. `sceneIsolationEnabled`（设置页「场景、近期与核心记忆」→「按 QQ 场景隔离记忆」）：记录并过滤可信 Host 的场景归属。
2. `sceneStrictQQ`（「严格 QQ 场景模式」）：跨场景普通记忆、图谱和普通 HTTP 内容接口拒绝；autoDream / Sleep 暂停，可信 QQ Session 的自动摘要仍可运行。

只开其中一个，QQ 模型访问都会 fail closed；两者都关时普通 DSH 会话保持原有行为。QQ Scene 是否可信只由进程内 QQ Host 对当前 Session ID 的绑定决定，标题、Preset 名称和请求参数都不是授权证据。

**旧库迁移（推荐隔离副本）**：不要在原 `memory.db` 上做实验，也不要让新旧实例同时指向同一个目录。

1. 停用旧 Memory 实例并停止 DSH 写入。
2. 把**整个旧 `memoryDir`**（含 `memory.db`、`-wal`、`-shm`、Markdown 镜像与 `backups/`）复制到一个新的隔离目录，例如 `~/.dsh/memory-amadeus-1.0.1/`。
3. 安装 `@amadeus/memory@1.0.1`，把新实例的 `memoryDir` 指向这份副本；确认记忆数、向量索引、Scene 归属与工具正常。
4. 观察一个完整会话后，再停用/卸载旧包。原目录保持不动，作为回滚现场。
5. 回滚时停用新实例，恢复旧 tarball 与旧 `memoryDir`；不要用运行中的 `-wal` / `-shm` 覆盖备份。

## 前置条件

- DeepSeek Harness Desktop，带 `slots`、`configForms`、Connection owner 鉴权与 Settings 客户端 UI 模块。
- Node.js 22.13+，支持 `node:sqlite`。
- 隔离 Profile 和合成记忆库；不要直接指向生产 `memoryDir`。
- 已安装的旧 Mneme/Amadeus Memory 只保留一个启用实例。相同插件 ID 不能同时启用两份 bundle。

## 构建与校验

在仓库根目录：

```powershell
cd dsh-mneme
npm run sync
node scripts/check-sync.js
node --check lib/client.js
node test/memory-productization.test.js
node test/memory-admin-api.test.js
node test/memory-management-api.test.js
node test/backup.test.js
node test/tools.test.js
npm pack --ignore-scripts --cache .npm-cache --pack-destination ../dist
```

产物：`dist/amadeus-memory-1.0.1.tgz`。SHA-256 记录在交付报告；打包后再改源码必须重新 `sync`、重新测试、重新打包。

## 通过 Plugin Manager 安装

1. 备份旧 Profile 的插件配置和 `memoryDir`（见 [备份与回滚](BACKUP_ROLLBACK.md)）。
2. 在隔离 DSH Desktop 打开 **设置 → 插件**，用本地 tarball 安装/替换。
3. 启用插件并让 Host 重载；确认只启用一个 Memory 插件实例。
4. 打开 **设置**，左侧应出现 **Amadeus 记忆 / Amadeus Memory**。
5. 页面首次加载会调用 owner 鉴权的 `/api/amadeus-memory/admin/overview`；它只返回运行状态、计数、公开模型信息和掩码后的凭据状态。
6. 在 **Amadeus 记忆** 中检查记忆 / 实体 / 状态 / 设置各页。原 **Memory** 侧边栏入口只在无 Scene 数据且严格模式关闭时用于旧图谱、别名和合并管理。

如果设置入口不出现：

- 检查 Plugin Manager 是否启用插件；
- 检查 Host 日志是否报告 `configForms` / `settings.section` 加载失败；
- 检查 `dsh.client.inject` 是否包含 `configForms` 与 Settings/Plugin Manager UI 模块；
- 不要通过修改 DSH 核心源码强行加入口。

## 配置权威（与 Plugin Manager 的关系）

- **运行开关**（自动记忆、autoDream、Sleep、偏好、受信 intake、实体抽取、rerank）：使用既有 feature flags 覆盖存储；独立页和原 Memory 面板写的是同一份存储，保存后会显示是否需要重载。
- **结构参数**（语言、整理阈值、注入/向量阈值等）：使用 DSH Config Forms；Plugin Manager 和独立页读写同一份 Config。对应字段已标记为 `volatile`，因此 DSH 0.2.1-rc.3 会实际投影出该 namespace；若未来 DSH 不再提供，页面会明确显示“Config Forms 不可用”，结构参数仍在 Plugin Manager 基础配置中修改，不会伪装成同源。
- **Embedding Provider / 本地或 Ollama 模型**：沿用既有 feature flags/Config，不建立第二套配置。
- **OpenAI 兼容 Embedding 的 Base URL / 模型 / 密钥**：沿用既有 `vector-config` 设置；页面只显示密钥是否已配置与掩码，空输入或掩码输入表示保留现有密钥。
- 页面的 **连通性测试** 只在用户点击时发起请求；远端 Provider 会产生一次真实 API 请求，页面有明确提示。
- 独立页的 **记忆管理** 卡通过 owner 鉴权接口完成搜索、新建、编辑、归档和带确认的删除；编辑使用 `updated_at` 乐观并发检查，冲突时不会覆盖他人修改。
- 独立页的 **备份与恢复** 卡生成一致性 SQLite 快照、校验 `quick_check`/表/checksum，并把恢复延后到下次启动；运行中的数据库不会被覆盖，恢复前自动保留 `pre-restore-*` 现场。
- 记忆正文只在已认证 owner 打开列表/编辑器时返回给当前设置页；不会写入日志、备份元数据或公开端点。Amadeus 实体页提供单 Scene 只读图谱。存在 Scene 数据或启用严格模式时，旧版面板的图谱/身份接口关闭；别名、合并和审计的在线管理仍需场景安全入口。

## 升级与回滚

升级（从 `@modusensus/dsh-mneme@1.0.0` 或更早版本）：

1. 记录旧包名/版本、tarball SHA-256、`memoryDir`、Embedding Provider/模型与 API Token 是否已配置（不要记录明文密钥）。
2. 停用旧插件或停止 DSH 写入，按上面的「旧库迁移」复制整个 `memoryDir` 到新的隔离目录，并创建 SQLite 一致性备份。
3. 在 Plugin Manager 卸载/停用旧包，安装 `dist/amadeus-memory-1.0.1.tgz`，把 `memoryDir` 指向副本；确认只启用一份。
4. 硬重启 DSH，打开 Amadeus 设置页，验证记忆数、单 Scene 图谱、向量索引、偏好权重、近期活动工具与 QQ Scene 开关。
5. 旧 `memoryDir`、`vector` 设置和 `feature_flags` 均保留；确认新实例稳定后再停用旧路径。

回滚：

1. 停用新版本，保留其数据库副本（不要删除现场）。
2. 重新安装旧 `@modusensus/dsh-mneme` tarball，把 `memoryDir` 指回未被新实例写过的旧目录或升级前备份。
3. 如已使用新副本，按需用升级前一致性备份替换副本；同时删除 `-wal` / `-shm` 再启动。
4. 硬重启并确认设置入口只出现一次、没有重复后台任务或重复写入。
5. 详细步骤见 [备份与回滚](BACKUP_ROLLBACK.md)。

## 验收清单（Codex 实机）

- [ ] Plugin Manager 显示 `@amadeus/memory@1.0.1`，插件 ID 仍为 `dsh-mneme`，启用成功。
- [ ] 系统设置左侧出现 **Amadeus 记忆**，页面加载状态、记忆数、数据库和向量索引。
- [ ] 记忆管理：搜索、新建、编辑、归档、取消归档、删除二次确认；并发编辑冲突会提示而不覆盖。
- [ ] 备份：创建后列表显示 SHA-256；校验通过；暂存恢复需要确认，重启后应用且保留 `pre-restore-*` 现场。
- [ ] 取消/恢复默认不会删除记忆；确认配置冲突、加载/错误/禁用状态和窄窗口布局。
- [ ] 修改一个 Tag 权重和实体权重，保存后刷新页面/重启仍保持；恢复默认只清权重，不删记忆。
- [ ] 修改一个 feature 开关，页面提示重载；重载后运行时生效。
- [ ] 修改一个 Config Forms 参数并保存，Plugin Manager 与独立页显示一致。
- [ ] Embedding 连通性测试只在点击后发起；不返回明文密钥。
- [ ] 在实体页选取两个不同 Scene，各只显示自己的节点和关系；旧图谱在严格模式下仍拒绝读取。既有 Qwen3-Embedding-8B 配置无需重填。
- [ ] 重启、禁用、启用、卸载后入口与后台任务正确撤销，数据保留。
- [ ] 没有两个 Memory 实例同时自动注入/autoDream/写入。
- [ ] 记录最终 tarball SHA-256 和实机截图/日志。

## 已知限制

- 本仓库的自动化测试不能代替 DSH Desktop 真实 GUI 验收；最终浏览器截图、Plugin Manager 安装与硬重启由 Codex 执行。
- Config Forms 参数保存后通常需要 Host 重载；页面会明确提示，不宣称即时生效。
- 真实远端 Embedding 的延迟长尾与语义召回质量仍是部署前评估项；本版本不更换用户已配置的模型或阈值。
- 跨 Session 近期活动授权要求 Host 提供 `ctx.sessions.get(id)` 的可信 Session Store。Host 不提供该服务，或 Session 已不是进程内 live Session 时，按 ID 重建的跨 Session 授权会 fail closed（不降级为相信调用方 ID/header）；普通单 Session 记录/读取不受影响。
- 1.0.1 修复的是近期活动的身份解析，不是 QQ Scene 数据面隔离模型；严格 QQ 模式仍按原有策略拒绝跨场景内容。
