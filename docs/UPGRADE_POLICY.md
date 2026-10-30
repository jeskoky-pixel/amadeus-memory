# Memory 升级与数据保留政策

适用包：`@fg-lab/amadeus-memory`；运行时插件 ID：`dsh-mneme`。v1.2.0 从 `@amadeus/memory@1.0.1` 升级。本政策从 v1.2.0 起用于后续 v1.2.1、v1.3.0 和主版本发布。包名切换必须先停用并移除旧 Bundle 配置，不允许双实例写入。

## 代码、配置与数据

安装包只放程序及资源，可在升级时替换。用户数据位于插件包之外：配置的 `memoryDir` 控制根及其 Workspace 隔离目录、SQLite/WAL/SHM、备份、向量与模型配置、Scene 授权、图谱和权重；DSH Profile 中的 bundle 配置。根目录旧 `memory.db` 不被自动收养。 不能把唯一副本放进 `node_modules`、插件包或可被 Market 清理的安装目录。升级时记录并沿用原 Profile、Bundle ID 和数据路径；若升级后看似空白，先核对路径和 Workspace，不能初始化覆盖。

## 四种操作

| 操作 | 约定 |
| --- | --- |
| 安装 | 创建缺失的结构；发现既有数据时先校验，绝不以空默认值覆盖。 |
| 升级 | 只替换代码；保留 Profile 配置和外部数据。支持的迁移先备份、校验、执行、复核，失败即停止启用。 |
| 禁用 | 停止监听、定时器和写入，数据仍留在原目录。 |
| 卸载 | 插件自身不删除用户数据；DSH Market/Plugin Manager 对 Profile 配置的实际保留行为须在目标 Desktop 版本实测，卸载前导出 Profile。彻底清除数据是独立人工操作。 |

## 固定升级步骤

1. 记录旧包版本/ SHA-256、DSH 版本、数据路径、Schema Version 与跨插件组合；保留旧 `.tgz`。
2. 停用唯一的 `dsh-mneme` 写入实例；对完整 `memoryDir` 和 DSH Profile 做一致性备份。首次打开未标记的已有数据库时，存储层在变更 schema 前另做 `backups/memory-before-schema-v1-*.db` 一致性快照。
3. 在隔离 Profile 用官方 Plugin Manager 或已验收的 Market 更新入口安装候选包，不执行用户侧构建脚本。
4. 重启并检查原有内容、关系、权限、Session/Workspace 绑定、配置及关键功能；重点：记忆正文、向量/Embedding 配置、知识图谱关系、权重、核心记忆、近期活动、Scene 隔离与授权、旧库版本 0 升级和失败恢复。
5. 通过后再在目标 Profile 分批升级。若失败，先禁用，保存故障现场，按 `DATA_MIGRATION.md` 恢复兼容数据库和旧包；不能假设旧代码一定能读已迁移的新数据。

每个新版本的 CI 必须从上一稳定版的合成真实格式数据升级到当前版，测试关键字段、关联、权限、重启和失败恢复。跨插件 Host 契约不兼容时应先适配或限制组合版本。小版本不得无说明删除既有能力；弃用需标记、替代方案和兼容周期。
