# Amadeus Memory

<img src="assets/market-icon.png" width="80" alt="Amadeus memory logo">

[简体中文](README.zh-CN.md) · [Detailed configuration](REFERENCE.md) · [Issues](https://github.com/jeskoky-pixel/amadeus-memory/issues)

Persistent memory and a knowledge graph with directional Session sharing.

Target package: **`@fg-lab/amadeus-memory@1.3.0`**. Tested runtime baseline: official DSH Desktop **0.2.1-rc.3**. MIT licensed.

## Release status

**1.3.0 is published:** [GitHub Release](https://github.com/jeskoky-pixel/amadeus-memory/releases/tag/v1.3.0) · [npm](https://www.npmjs.com/package/@fg-lab/amadeus-memory). Install the pinned version and verify the release checksum. Later main changes do not change this immutable archive. See [publishing policy](docs/PUBLISHING.md).

## What you can do

- Keep recent conversation context with Hot Memory; optionally enable Recent Activity and Core Memory for cross-session activity and deliberately curated facts.
- Save long-term facts and experiences; retrieve them with BM25, vector or hybrid search. Vector search needs a configured embedding provider.
- Browse a shared knowledge graph, entities and aliases, and tune Tag/Entity importance. Session authorization still controls which source material may be read.
- Use Mneme automatic summaries and Dream consolidation, with optional Sleep processing. These use configured model services and are not a promise of offline processing.
- Bind one Workspace. Sessions are private by default in unified ACL mode; grant directional Learn or Borrow access from the fifth Amadeus page. Inspect derived-knowledge provenance and preview a Session's graph.
- Learn permits authorized derived knowledge to remain after source access is revoked; Borrow remains dependent on source access. Learning does not grant unrestricted onward sharing.

Example: let a planning Session learn selected project context from a research Session, then revoke source access. Authorized learned facts can remain; unlearned source content becomes inaccessible. Choose Borrow when continued access must depend on the original grant.

Hot Memory is enabled by default. Recent Activity, Core Memory and Memory's optional persona card are disabled by default; Sleep is optional. Confirm the unified ACL Workspace and grants before QQ use. Memory can run without QQ for ordinary DSH Sessions. QQ identity is accepted only through its trusted Host contract.

Amadeus Memory is based on Mneme. See [upstream source and attribution](UPSTREAM.md); original memory, consolidation and retrieval capabilities are not presented as new Amadeus inventions.

## Install and configure

Install the prebuilt `.tgz` with the official DSH plugin manager into your selected Profile. No local source build is required. Follow [installation instructions](docs/INSTALL_V1_2.md); do not copy configuration into a running Profile by hand.

Select a Workspace and configure Session ACL sharing. Learn retains authorized derived knowledge; Borrow is revoked with its source access.

Memory is now a root-level package; no GitHub subdirectory suffix is needed. Its internal ID remains `dsh-mneme`: do not load original Mneme alongside it.

## Interface

![Amadeus Memory interface](docs/verification/screenshots/recent-sharing-preview.png)

This is a recorded interface screenshot, not evidence that every real platform capability passed the current release gate. See the detailed reference and verification reports for limitations.

## Upgrade and recovery

Back up user data before upgrading. Code, persistent user data and recovery backups are separate. Disable stops functionality; uninstall is intended to retain external data. Restoring old code alone does not reverse a database migration.

- [Upgrade policy](docs/UPGRADE_POLICY.md)
- [Data migration and recovery](docs/DATA_MIGRATION.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Full configuration and limitations](REFERENCE.md)

## Ecosystem and license

[Amadeus project](https://github.com/jeskoky-pixel/Amadeus-dsh) · [MIT license](LICENSE)
Based on Mneme; see [upstream attribution](UPSTREAM.md). Existing attribution and licensing are preserved.

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
