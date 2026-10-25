# Amadeus Memory — 安装、升级与验收

本包是 **Amadeus Memory 增强发行版**，基于 Mneme 0.9.4，沿用上游 MIT 许可。发行身份是安全增强版而不是新包：

- 包名：`@modusensus/dsh-mneme`
- 版本：`0.9.5-amadeus.1`
- 插件 ID / Bundle ID：`dsh-mneme`（保持不变）
- 上游：`@modusensus/dsh-mneme@0.9.4`
- 数据目录 / 配置键 / SQLite 格式：与上游兼容，升级不迁移到第二套数据库。

不在本版本改用 `@amadeus/memory`：那会改变 Plugin Manager 身份、插件 ID 与配置命名空间，需要额外的旧实例禁用、双实例互斥和数据继承证明；本包优先选择可证明安全的同 ID 升级。

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
node test/tools.test.js
npm pack --ignore-scripts --pack-destination ../dist
```

产物：`dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz`。SHA-256 记录在 `docs/RELEASE_NOTES.md` 与交付报告；打包后再改源码必须重新 `sync`、重新测试、重新打包。

## 通过 Plugin Manager 安装

1. 备份旧 Profile 的插件配置和 `memoryDir`（见 [备份与回滚](BACKUP_ROLLBACK.md)）。
2. 在隔离 DSH Desktop 打开 **设置 → 插件**，用本地 tarball 安装/替换。
3. 启用插件并让 Host 重载；确认只启用一个 Memory 插件实例。
4. 打开 **设置**，左侧应出现 **Amadeus 记忆 / Amadeus Memory**。
5. 页面首次加载会调用 owner 鉴权的 `/api/amadeus-memory/admin/overview`；它只返回运行状态、计数、公开模型信息和掩码后的凭据状态。
6. 打开原 **Memory** 侧边栏入口，确认既有记忆、图谱与 Embedding 配置仍在。

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
- 页面不读取或显示记忆正文；完整图谱、别名、合并、审计仍由原 Memory 面板承担。

## 升级与回滚

升级：

1. 记录当前 `@modusensus/dsh-mneme` 版本、tarball SHA-256、`memoryDir`、Embedding Provider/模型与 API Token 是否已配置（不要记录明文密钥）。
2. 停用旧插件或停止 DSH 写入，创建 SQLite 一致性备份。
3. 在 Plugin Manager 用新 tarball 替换旧版本；确认只启用一份。
4. 硬重启 DSH，打开设置页与原 Memory 面板，验证记忆数、向量索引、偏好权重与工具。
5. 旧 `memoryDir`、`vector` 设置和 `feature_flags` 均保留。

回滚：

1. 停用新版本，保留其数据库副本。
2. 安装旧 tarball/旧版本，恢复升级前的 SQLite 备份（如有必要）。
3. 硬重启并确认设置入口只出现一次、没有重复后台任务或重复写入。
4. 详细步骤见 [备份与回滚](BACKUP_ROLLBACK.md)。

## 验收清单（Codex 实机）

- [ ] Plugin Manager 显示 `@modusensus/dsh-mneme@0.9.5-amadeus.1`，启用成功。
- [ ] 系统设置左侧出现 **Amadeus 记忆**，页面加载状态、记忆数、数据库和向量索引。
- [ ] 修改一个 Tag 权重和实体权重，保存后刷新页面/重启仍保持；恢复默认只清权重，不删记忆。
- [ ] 修改一个 feature 开关，页面提示重载；重载后运行时生效。
- [ ] 修改一个 Config Forms 参数并保存，Plugin Manager 与独立页显示一致。
- [ ] Embedding 连通性测试只在点击后发起；不返回明文密钥。
- [ ] 打开原 Memory 面板，搜索/图谱正常；既有 Qwen3-Embedding-8B 配置无需重填。
- [ ] 重启、禁用、启用、卸载后入口与后台任务正确撤销，数据保留。
- [ ] 没有两个 Memory 实例同时自动注入/autoDream/写入。
- [ ] 记录最终 tarball SHA-256 和实机截图/日志。

## 已知限制

- 本仓库的自动化测试不能代替 DSH Desktop 真实 GUI 验收；最终浏览器截图、Plugin Manager 安装与硬重启由 Codex 执行。
- Config Forms 参数保存后通常需要 Host 重载；页面会明确提示，不宣称即时生效。
- 真实远端 Embedding 的延迟长尾与语义召回质量仍是部署前评估项；本版本不更换用户已配置的模型或阈值。
