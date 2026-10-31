# Memory 数据迁移契约

## 当前格式（1.3.0）

- 发行包：`@fg-lab/amadeus-memory@1.3.0`，内部 ID 保持 `dsh-mneme`。
- 基础 Mneme 兼容数据库使用 schema 1；统一 Session ACL 数据库使用 schema 2。不能以包版本号推导或重置数据版本。
- schema 2 保存 Session 授权、Learn/Borrow、派生来源和依赖账本。现有 schema 2 数据必须继续读取，不能重新初始化。
- 从旧格式迁移须使用已有备份和迁移路径；回滚旧代码前应确认其支持当前格式，否则恢复匹配的旧备份。详见本文后面的统一 Session ACL 章节。

## v1.2.0 历史迁移基线

- 发行包：`@fg-lab/amadeus-memory@1.2.0`
- 持久 Schema Version：SQLite `PRAGMA user_version = 1`；此前 Mneme 兼容库为版本 0（未标记）
- 数据范围：配置的 `memoryDir` 控制根及其 Workspace 隔离目录、SQLite/WAL/SHM、备份、向量与模型配置、Scene 授权、图谱和权重；DSH Profile 中的 bundle 配置。根目录旧 `memory.db` 不被自动收养。
- 本轮迁移：1.0.1 → 1.2.0 保持原表和列；通过现有幂等增量迁移后写入版本 1。未来版本高于 1 时拒绝打开。备份失败时不执行后续迁移。

## 未来迁移流程

读取并验证当前版本、完整性和关键关联。未知或未来版本拒绝写入，并给出可读的迁移路径提示。现有数据先创建一致性备份；备份失败即停止。每一步迁移使用事务或原子文件替换，幂等且可重试；内容和引用复核通过后才标记新版本。不能通过删除数据库、清空配置或重新建立 Session 来“修复”错误。

备份必须位于独立用户数据目录，记录时间、原 Schema Version、目标版本和校验值，不能进入发行包或 Git。恢复时区分：只回滚代码、只恢复配置、完整恢复数据库和 Profile。任何不可逆转换都必须保留升级前快照；旧程序如不支持新格式，必须连同旧数据快照恢复。

## v1.2.0 验证清单

- 使用 `1.0.1` 的合成数据，核对升级前后字段内容、关联和权限，而不只比较条数。
- 停用/启用和硬重启后重新读取。
- 令备份或迁移失败，确认旧数据仍完整且错误可见。
- 使用与上一版本匹配的备份演练回滚；不把新版本数据库直接交给旧程序。
- 验证：记忆正文、向量/Embedding 配置、知识图谱关系、权重、核心记忆、近期活动、Scene 隔离与授权、旧库版本 0 升级和失败恢复。

未在真实 DSH Desktop/Market 运行的项目不得在发行报告里记作通过。


## Unified Session ACL schema 2 — Learn/Borrow (2026-10-31 candidate)

See [Session learning and rollback](SESSION_LEARNING.md). This additive migration creates a consistent pre-migration SQLite snapshot before changing the grant schema. Old grants remain legacy Borrow; historical shared-history records remain audited and quarantined. No automatic Learn upgrade or deletion is performed. Rollback requires the matching pre-v2 database/configuration and prior package, not a code-only downgrade. The candidate remains on Draft PR #7.
