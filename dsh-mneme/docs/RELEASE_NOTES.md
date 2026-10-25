# Amadeus Memory 0.9.5-amadeus.1 — 发行说明

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
