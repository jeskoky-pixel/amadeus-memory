# Amadeus Memory

Amadeus Memory 是基于 [Mneme](https://github.com/slow-stack/mneme) 修改并独立维护的 DSH 记忆插件。仓库根目录就是插件包；内部 Plugin ID 继续为 `dsh-mneme`，默认数据目录继续为 `~/.dsh/memory`。原作者的 MIT 许可与来源见 [LICENSE](LICENSE) 和 [UPSTREAM.md](UPSTREAM.md)。

Memory 可独立安装。QQ 提供可信 Scene 身份时，它会按 Scene 隔离长期记忆和近期上下文；Life 可通过受控入口写入可信经历；Persona 与 State 均为可选插件。缺少这些插件时，普通 DSH 会话仍可使用 Memory。

## 当前状态

1.3.0 是主分支整合候选，本轮不发布 npm、Release 或 Market。以下版本安装命令仅在对应公开发行完成后适用；当前验收使用本地预构建包。

## 安装

目标版本：`@fg-lab/amadeus-memory@1.3.0`，兼容已验证的 DSH Desktop `0.2.1-rc.3`。在 DSH 插件管理器中安装 npm 包，或安装本仓库根目录／[GitHub Release](https://github.com/jeskoky-pixel/amadeus-memory/releases) 的预构建包。命令行等价形式：

```powershell
dsh plugin --profile <隔离或目标Profile> add @fg-lab/amadeus-memory@1.3.0
```

首次配置在 DSH 设置的 **Amadeus 记忆** 页面完成。先核对 Workspace、`memoryDir`、Embedding 与 Scene 安全开关，再启用写入。GUI 包含记忆卡片与时间线、实体关系图、运行状态，以及分组设置。向量服务未配置时仍可使用关键词检索；远端 Embedding 或宿主模型可能接收待处理的记忆内容。

从 `@amadeus/memory` 升级时，先停用旧 Memory，做 SQLite 一致性备份并导出 Profile，再移除旧包的 Bundle 配置，安装新包并恢复原 Workspace、`memoryDir` 和设置。**绝不能同时启用两个 `dsh-mneme` 实例**。根目录 GitHub 安装不再需要 `#path:/dsh-mneme`。详见 [安装与升级](docs/INSTALL_V1_3.md)、[升级政策](docs/UPGRADE_POLICY.md)、[数据迁移](docs/DATA_MIGRATION.md)。

## 功能与页面

- 长期记忆的写入、检索、编辑、归档、遗忘、自动摘要、autoDream 和 Sleep。
- 核心记忆、近期活动、Tag 与实体权重、稳定身份、别名和知识图谱。
- 单 Workspace 统一记忆、Session 隔离、全局知识图谱与方向性 Learn/Borrow 授权。新授权默认 Learn；已合法学得的派生知识保留来源约束，禁止未经授权转分享。
- autoSummarize、Dream/Sleep 按来源约束派生；QQ 可信身份契约可选，普通 DSH Session 可独立使用。
- 中英文 GUI：保留记忆、实体、状态和设置四页，增加第五页 Amadeus 授权管理与 Session 图谱预览。

高级维护键 `reflectionFailureRetentionDays` 控制失败反思记录的保留天数；默认 90 天，详见 [配置参考](docs/CONFIGURATION.md)。

### 模型工具（默认注册 13 个；全数 16 个）

| 工具 | 功能 |
| --- | --- |
| `memory_save` | 写入记忆 |
| `memory_search` | 检索记忆 |
| `memory_list` | 列出记忆 |
| `memory_get` | 读取记忆正文 |
| `memory_preference_get` | 查看偏好权重 |
| `memory_identity_lookup` | 查询身份与别名 |
| `memory_update` | 更新记忆 |
| `memory_delete` | 删除记忆 |
| `memory_forget` | 抑制记忆注入 |
| `memory_archive` | 归档与恢复 |
| `memory_core_save` | 核心记忆写入；需开启 `coreMemoryEnabled` |
| `set_scope_state` | 设置可逆作用域闸门 |
| `memory_register_document` | 登记文档指针 |
| `memory_organize` | 主动整理；需开启 `organizeEnabled` |
| `memory_runtime` | 查看本地运行时 |
| `memory_recent_activity` | 查询近期活动；需开启 `recentActivityEnabled` |

## 隐私承诺

`autoDream` 与 `autoSummarize` 的巩固和摘要走宿主模型；默认 Embedding 配置也可能访问远端服务。只有显式选择本地 Embedding 并安装本地运行时，语义向量才在本机计算。插件不向 Amadeus 自有服务器传送记忆正文。

## Privacy

`autoDream` and `autoSummarize` use the host model for consolidation and summaries. The configured embedding provider may be remote. Semantic vectors stay local only when local embedding is explicitly selected and its runtime is installed. The plugin does not send memory bodies to an Amadeus-owned server.

软件包不携带用户数据库、QQ Token 或模型密钥。用户数据位于插件安装目录之外；卸载代码不等于删除数据。旧版代码未必能读取已迁移的数据库，回滚时须配套恢复升级前备份。详情见 [中文指南](docs/USER_GUIDE.zh.md)、[备份与回滚](docs/BACKUP_ROLLBACK.md)。

## 开发与验证

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run sync
npm.cmd test
npm.cmd run verify:release
npm.cmd pack --dry-run --ignore-scripts
```

`src/` 是源码；`lib/` 是随包发布的同步产物，`lib/client.js` 为独立维护的前端文件。安装目标无需构建源码。最新发行验收见 [v1.2 迁移报告](docs/verification/MEMORY_V12_FLATTEN_MOVE.md)；历史验收记录保留在 [docs/verification](docs/verification)。生产数据、真实 QQ/NapCat 和未完成的实机性能项目不得由合成测试推定为通过。

问题反馈：[GitHub Issues](https://github.com/jeskoky-pixel/amadeus-memory/issues)。许可证：MIT；Mneme 原作者版权声明完整保留。
