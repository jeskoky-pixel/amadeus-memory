# 备份、升级与回滚

## 数据位置

Amadeus Memory 沿用 Mneme 的单一存储：

```text
<memoryDir>/memory.db
<memoryDir>/*.md              # Markdown 镜像
<memoryDir>/documents/        # 可选的文档指针目录
```

默认 `memoryDir` 是 `~/.dsh/memory`（可在 Plugin Manager 的 Config 中修改）。向量索引、权重、身份/别名/合并、受信 provenance 都在同一个 `memory.db` 中，不另建第二套偏好数据库。

> 产品化/QA 环境必须使用显式、隔离的 `memoryDir`。不要把测试或预览指向用户真实的 `~/.dsh/memory`，也不要用默认值跑 smoke。

## 设置页内的安全备份与恢复

原生 **Amadeus 记忆** 页提供“备份与恢复”卡：

1. **创建备份**：对当前打开的 SQLite 使用 `VACUUM INTO` 生成一致性快照，写入 `<memoryDir>/backups/amadeus-memory-<UTC>.db`。备份不会复制 `-wal/-shm`，也不会停止服务。
2. **校验**：只读打开备份，执行 SQLite `PRAGMA quick_check`，检查 `memories` 表并计算 SHA-256；失败会明确报错，不触碰当前数据库。
3. **暂存恢复**：必须勾选重启确认，并输入/确认目标备份。请求只写一个恢复标记，**运行中的数据库不会被覆盖**。
4. **重启应用**：DSH 下次启动时，在 `createStore()` 打开数据库之前：
   - 重新校验备份存在、SQLite 头部、`quick_check`、`memories` 表和 SHA-256；
   - 先把当前 `memory.db`、`-wal`、`-shm` 复制到 `<memoryDir>/backups/pre-restore-<UTC>/`；
   - 再替换 `memory.db`，成功后删除恢复标记；
   - 任一步失败则恢复原文件集，保留现场并把 marker 改名为 `.failed-*`，不静默启动空库。
5. **回滚恢复**：到 `backups/pre-restore-*` 取现场；不要删除它。再次恢复仍走同样的“先备份、再替换”路径。

DELETE 等高风险动作在 UI 需要二次确认；恢复需要“我了解需要重启并确认恢复”。**恢复默认参数只 unset 配置字段，不删除记忆；重置偏好只清空权重表，不删除记忆。**

备份 API 仅通过 DSH owner 同源设置代理暴露；不开放任意文件路径、不返回密钥或记忆正文，不允许把 `backups/` 之外的路径作为恢复源。备份文件包含 Memory SQLite 数据（以及 Settings 中的向量配置/密钥），应视同敏感数据保存，不要提交到 Git 或公开目录。


另有浏览器 localStorage 的 `dsh-mneme-api-token`（若你使用原面板的 token 模式），它不是数据备份；升级不需要重填已经有效的 Embedding 密钥。

## 升级前备份

1. 记录当前插件版本、tarball SHA-256、`memoryDir`、Embedding Provider/模型、是否配置 API Token（不要记录明文）。
2. 停用 Memory 插件，或至少停止 DSH 的写入。
3. 用 SQLite 一致性方式备份，不要只复制一个正在写入的 `memory.db`：
   - 在隔离环境可用 `sqlite3 memory.db ".backup 'memory-backup.db'"`；
   - 或先停用插件/关闭 DSH，再复制 `memory.db`、`memory.db-wal`、`memory.db-shm`。
4. 保留旧插件 tarball 和旧 Profile 的配置副本。
5. 如使用 Markdown 镜像，备份整个 `memoryDir`；镜像不是权威数据，但便于人工核对。

## 升级（1.0.1 发行身份迁移）

1.0.1 起 npm 包名是 `@amadeus/memory`，但**插件 ID 仍是 `dsh-mneme`，默认数据路径仍是 `~/.dsh/memory`**。因此数据格式不需要转换；真正要防的是新旧两个 npm 身份同时运行，或两个实例同时写同一份 `memory.db`。

推荐使用隔离副本升级（生产数据也适用）：

1. 停用旧版本（`@modusensus/dsh-mneme@1.0.0` 或更早），停止 DSH 写入。
2. 创建一致性 SQLite 备份；再把**整个旧 `memoryDir`**（含 `memory.db`、`-wal`、`-shm`、Markdown 镜像和 `backups/`）复制到新目录，例如 `~/.dsh/memory-amadeus-1.0.1/`。原目录保持不动。
3. 在 Plugin Manager 停用/卸载旧包，安装 `@amadeus/memory@1.0.1`，将新实例的 `memoryDir` 指向副本。
4. 确认只有一个 Memory 插件启用；硬重启 DSH。
5. 打开设置页和原 Memory 面板，检查数据库健康、记忆数、向量覆盖、权重、近期活动工具与 QQ Scene 两个开关。
6. 观察一个完整会话后再停用旧包；记录新版本和 tarball SHA-256。

例外：如果你明确接受就地升级，`memoryDir` 可以继续指向原目录；仍必须先停旧实例并做一致性备份，再安装新包。绝不能让旧 `@modusensus/dsh-mneme` 与新 `@amadeus/memory` 同时启用。

兼容性说明：

- 插件 ID `dsh-mneme`、配置命名空间、feature flags、`vector` 设置和 SQLite schema 均沿用；升级不需要重填 Embedding 密钥。
- Plugin Manager 显示的新包名与旧包名不同，这是发行身份变化，不是第二套数据格式。
- 近期活动跨 Session 授权依赖 Host 的 live Session Store；历史/非 live Session 的授权会 fail closed，见 [INSTALL](INSTALL.md#已知限制)。

从更早的 `0.9.4` / `0.9.5-amadeus.*` 升级时，同样先停旧实例、备份并复制 `memoryDir`，再安装新包。

## 回滚

1. 停用 `@amadeus/memory`，保留其数据库副本（不要删除现场）。
2. 重新安装旧 `@modusensus/dsh-mneme` tarball，将其 `memoryDir` 指回未被新实例写过的旧目录或升级前备份。
3. 如果已在新副本中写入，需要回到升级前状态时，停止写入后用一致性备份替换 `memory.db`；同时删除旧的 `memory.db-wal` / `memory.db-shm`，再启动。
4. 硬重启 DSH，确认只有一个设置入口、一个 Memory 实例，没有重复后台任务。
5. 验证记忆数、图谱、向量索引、权重和 Embedding 配置。

当前版本没有破坏性 schema 变更；身份、偏好、intake、pending 与近期活动表都是 additive。即使不回滚数据库，旧版本也应能忽略新增表。但旧版本可能不认识新增偏好/身份功能，UI 会隐藏相应入口；近期活动的跨 Session 授权修复只在 1.0.1 运行。

## 常见恢复场景

### 数据库损坏或打不开

保留原文件，不要删除后让插件静默创建空库。先复制现场，检查 SQLite 完整性，再尝试从最近备份恢复。

### Embedding 配置丢失

先确认是不是切到了另一个 Profile 或另一个 `memoryDir`；同 Profile 内升级不会清空 `vector` 配置。不要为了“修好”而反复更换模型，先恢复配置或备份。

### 两个实例重复写入

立即停用其中一个；确认 Plugin Manager 中只有一份 Memory bundle 启用。不要把旧包和新包同时放在同一个 Profile 中运行。

### 卸载

卸载插件不会自动删除 `memoryDir`。如需彻底清理，先备份再手动删除数据目录；这属于不可逆操作，必须由用户明确确认。
