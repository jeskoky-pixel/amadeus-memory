# Amadeus Memory 发行说明

## 1.2.0 发行候选

- 发行包改为 `@fg-lab/amadeus-memory@1.2.0`，仓库根目录直接安装；内部插件 ID 仍为 `dsh-mneme`，保留 Mneme 数据、索引配置和 Scene 授权。
- 对未标记的既有 SQLite 库增加 schema 0 → 1 的迁移前一致性备份与版本检查。隔离 DSH Desktop `0.2.1-rc.3` 所附 CLI 完成 1.0.1 → 1.2.0 的合成数据升级、重启和恢复演练。
- 包含预构建 Client、Manifest、资源和上游许可证与来源说明。无需 GitHub `#path:/dsh-mneme`；Desktop 图形安装、真实向量检索及公开市场更新以最终发行报告为准。

## 1.0.1 发行身份与近期活动授权修复

- npm 包名改为 `@amadeus/memory`，版本 `1.0.1`；插件 ID 仍为 `dsh-mneme`，默认数据路径仍为 `~/.dsh/memory`，SQLite schema、配置键与 feature flags 不迁移。上游署名、`LICENSE` 与 `UPSTREAM.md` 保持不变。
- 修复 QQ Host 存在时近期活动的跨 Session 授权：受信源 Session 与共享目标不再以 `{ id }` 占位符送入 QQ 模型边界，而是先经进程内 `ctx.sessions` 的 live Session Store 解析出完整 Host 身份（含冻结的 `header.agentPreset`），再执行 Workspace 与 QQ 双重授权。解析缺失、ID 不匹配、抛错或动态撤销一律 fail closed，不回退到调用方提供的 ID 或 header。
- 新增回归覆盖：普通 DSH Session 在 QQ Host 存在时仍可显式共享；QQ 源/目标在默认模式下不可见；缺失/不可信 header、错配身份、抛错与动态撤销均拒绝；运行时从 `ctx.sessions` 派生解析器。
- 最终隔离验收还修复了原始近期摘要的跨 Scene 配对授权：策略写入和旧策略读取均实时核对可信 QQ Host 的源/目标 Scene；QQ Host 对普通 DSH Session 抛出未绑定异常时，仅由完整 Host Session Header 的已知普通 Preset 允许普通分享。两个普通 Session 在官方 Workspace 完成真实模型回合、分享和即时撤销；真实 NapCat 外发仍待个人电脑验收。见 [联合报告](https://github.com/jeskoky-pixel/amadeus-qq/blob/main/docs/verification/FOUR_PLUGIN_V11_JOINT_2026-10-28.md)。
- 升级/回滚：先停旧实例，将整个旧 `memoryDir` 复制到隔离目录，再安装 `@amadeus/memory@1.0.1` 并指向副本；不要同时运行旧 `@modusensus/dsh-mneme` 与新包。详细步骤见 [INSTALL](INSTALL.md) 与 [备份与回滚](BACKUP_ROLLBACK.md)。
- 已知限制：跨 Session 授权需要 Host 提供 live `ctx.sessions.get(id)`；历史/非 live Session 或旧 Host 无此服务时，按 ID 重建的授权 fail closed（普通单 Session 读写不受影响）。自动化测试不替代真实 Desktop/QQ Profile 验收。

## 1.0.0 版本收口

- 沿用 `@modusensus/dsh-mneme` 包名、`dsh-mneme` 插件 ID 与现有数据库升级路径；本次只将通过验收的 RC 收口为正式版本号，不新增记忆能力。
- QQ Scene 后台整理、可信自动摘要及未知 Preset 安全拒绝沿用下述 RC 实现。正式包仍需在四插件隔离环境中联合验收；未公开发布或部署生产环境。

## 1.0.0-rc.1 候选

- 在可信 QQ Scene 下恢复原有 autoDream、autoSummarize 与按需启用的 Sleep。Dream 和 Sleep 按持久化来源分批执行，legacy 未标注记忆独立处理；生成结果和审计保留 Scene 来源。
- Dream 与 Sleep 共用串行队列；Sleep 取消不报告整轮成功。规范实体的成员证据先按 Scene 过滤再汇总，关系补全不会引用其他 Scene 的证据。
- 新增隔离合成库的 1 万条记忆检索 P95 基准。实机安装、重启与剩余验收范围见仓库交付报告；未部署生产环境。
- 严格 QQ 模式下，Host 绑定缺失且 Preset 来源不明确的会话不再回退到 legacy 自动摘要；已知普通 DSH Preset 仍保持原有摘要行为。

## 0.9.5-amadeus.3 历史候选

- QQ 的五种 Session 预设仅在严格 Scene 模式且同进程 QQ Host 能验证当前 Session 绑定时注入本场景记忆；不满足条件时保持空注入。跨场景授权仍关闭。
- 原生 **Amadeus 记忆** 管理页新增按单一 Scene 选择的只读实体关系图；数据由 owner 鉴权、同源的管理 API 提供，关系和节点必须有该 Scene 的有效记忆证据。原 Mneme 普通图谱接口在严格模式下继续拒绝读取。
- 记忆管理卡片显示 Scene 来源。图谱对节点和关系数量设上限并明确标记截断；未标注的 legacy 记忆单列，不与 QQ 场景混合。
- 原生管理页按 **记忆 / 实体 / 状态 / 设置** 分栏，记忆页再区分长期记忆与近期上下文，设置页按基础、检索、场景、备份分组。会话热记忆与可信 Scene 近期缓冲分别显示状态；短期原文不通过 owner API 暴露。
- 严格 QQ Scene 模式的自动摘要现在只对 QQ Host 可核实且绑定稳定的 Session 运行，输出继承该 Scene；解绑、换场景和延迟任务复核失败时拒绝派生。autoDream 与 Sleep 在有 Scene 数据时继续安全暂停。
- 本节描述开发候选。隔离 Desktop 和真实 QQ 的具体覆盖范围以本分支验收报告为准；未自动部署生产环境。

## 0.9.5-amadeus.1 历史记录

## 身份与兼容性

- 包名：`@modusensus/dsh-mneme`
- 版本：`0.9.5-amadeus.1`
- 插件/Bundle ID：`dsh-mneme`（沿用上游）
- 上游基线：`@modusensus/dsh-mneme@0.9.4`
- 许可：MIT（保留上游 `LICENSE`、`UPSTREAM.md` 与署名）
- 数据：沿用原 `memoryDir/memory.db`，不建第二套记忆/偏好数据库
- 配置：沿用同包配置键；新增设置页对既有 feature flags、Config Forms 和 vector 配置做统一呈现

这是**同包名的增强版本升级**，不是 `@amadeus/memory` 新包。采用新包名会改变 Plugin Manager 身份、插件 ID、配置命名空间和潜在双实例写入面；本版本选择可证明安全的同 ID 升级，并明确用版本号区分上游。

## 本版本新增

- DSH 系统设置独立入口 **Amadeus 记忆 / Amadeus Memory**。
- 运行概览：记忆数、SQLite、自动巩固、Sleep、向量 Provider/模型/维度/索引覆盖。
- 日常开关：自动记忆、autoDream、Sleep、偏好、受信 intake、实体抽取、rerank。
- Config Forms 基础参数：注入条数/重要性、截断、整理阈值、Sleep 空闲、向量候选/阈值等。
- 开放 Embedding 配置与用户主动触发的连通性测试；密钥只显示配置状态/掩码，不返回明文。
- Tag/实体偏好查询与编辑，复用既有权重存储；恢复默认只清权重。
- 打开原有完整 Memory 面板，保留图谱、别名/合并、审计和维护。
- owner 鉴权、same-origin、CSRF marker 的最小动态 Host API；不暴露记忆正文或原始 SQLite 行。
- 两个只读模型工具（来自上一轮）：`memory_preference_get`、`memory_identity_lookup`。

## 安全与行为边界

- 设置页不是“本机端口即管理员”；需要 DSH Connection owner 和 same-origin。
- 远端 Embedding 测试只在用户点击按钮时发生一次。
- 普通聊天/模型不能伪造 trusted event；`source=trusted_intake` 不是权限。
- 同名实体不自动合并；偏好恢复默认不删除记忆。
- 没有在本次自动安装或修改生产 Profile；真实 Desktop GUI 验收由 Codex 执行。

## 构建与校验

```powershell
cd dsh-mneme
npm run sync
node scripts/check-sync.js
node --check lib/client.js
node test/memory-admin-api.test.js
node test/memory-productization.test.js
node test/memory-enhancer-tools.test.js
node test/tools.test.js
npm pack --ignore-scripts --pack-destination ../dist
```

包路径与 SHA-256：

- `dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz`
- 最终 SHA-256、字节数与文件数由同目录外部的 `dist/PACKAGE_INFO.json` 和 `CREATOR_REPORT.md` 记录；安装包内文档不能自包含自身哈希。
- 连续两次 `npm pack` 产生相同 SHA-256；若打包后源码、客户端或文档又有改动，必须重新 sync、测试和打包，旧 SHA 作废。

## 已知限制

- 自动化测试覆盖 API/工具/静态客户端接线，不能替代真实浏览器 GUI、Plugin Manager 安装、硬重启和卸载验收。
- Config Forms 保存通常需要 Host 重载；页面明确提示，不宣称即时生效。
- 真实向量长尾、远端 Embedding 延迟与语义召回质量仍需在隔离环境评估；没有随意更换用户模型或阈值。
- 同包名升级要求只启用一份 Memory 实例；同时启用两份仍可能导致重复注入/写入。
