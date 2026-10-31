# Memory 1.3.0 主分支候选（2026-10-31）

包名 `@fg-lab/amadeus-memory`，内部插件 ID `dsh-mneme`。本轮未公开发行。

统一 Workspace 记忆与 Session ACL；方向性 Learn/Borrow、默认允许学习、合法学习成果长期保留、派生来源追踪与禁止未经授权转分享；自动摘要及 Dream/Sleep 来源约束；第五页授权管理与 Session 图谱预览。

本次版本元数据调整不修改数据结构。已有统一 ACL schema 2 原样保留，长期/核心记忆、图谱、授权、凭证、来源依赖、近期活动和 Dream/Sleep 历史均不重置。旧 schema 1 按现有迁移逻辑备份并升级，不能直接用旧程序打开新数据库。

兼容 QQ 1.2.0 的可信 Session provenance 契约（包含 PR #6）；QQ 为可选服务，未安装时普通可信 DSH Session 仍可工作。Life/State/Persona 1.2.0 为可选联动，系统人格 Section 与权限执行器不改变。当前宿主验证基线为 DSH Desktop 0.2.1-rc.3，其他版本不宣称通过。

升级前停止写入、导出 Profile 并制作一致性数据库备份。保留 Workspace 与 memoryDir，禁止重复启用 dsh-mneme。使用本地预构建 `fg-lab-amadeus-memory-1.3.0.tgz`；仓库根目录可安装，不再使用子目录路径。不会自动安装到日常 Profile。

回退须恢复兼容代码和对应数据快照；保留冻结分支 `backup/amadeus-memory-pre-unified-session-acl`。详见 [升级政策](UPGRADE_POLICY.md)、[迁移](DATA_MIGRATION.md)、[回滚](BACKUP_ROLLBACK.md)、[Learn/Borrow](SESSION_LEARNING.md)。1.2 的历史验收文档保留，不等同于本次所有实机行为重新验收。
