# Amadeus Memory Enhancer

Amadeus Memory 是 DeepSeek Harness 的独立记忆插件：它保存获授权的长期信息，在对话时检索相关记忆，并提供可视化的记忆、标签权重、实体关系和备份管理。此版本继承 Mneme 的插件 ID 与数据格式，方便已有用户升级。

> 稳定版 `1.0.0` 已完成四插件联合验收；当前 PR #5 的候选包为 `@amadeus/memory@1.0.1`，仍在 v1.1 联合验收，尚未公开发行或部署到生产 DSH。历史验收见 [联合验收报告](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/verification/AMADEUS_V1_FOUR_PLUGIN_ACCEPTANCE.md)。

## 日常使用

在 DSH 设置中打开 **Amadeus 记忆**，按 **记忆 / 实体 / 状态 / 设置** 浏览。记忆页区分长期记忆和近期上下文；实体页提供按单一 Scene 选择的只读图谱；设置页再分基础、检索、场景和备份。记忆可创建、搜索、编辑、归档和删除，核心记忆可受保护。原 Mneme 面板在没有 Scene 数据且未启用严格模式时仍可用；严格模式下旧图谱与身份接口安全关闭。若向量服务未配置，关键词检索继续可用。安装前请阅读 [中文用户指南](dsh-mneme/docs/USER_GUIDE.zh.md) 和 [安装与升级说明](dsh-mneme/docs/INSTALL.md)。

[![tests](https://img.shields.io/badge/tests-695%20passed-success)](https://github.com/jeskoky-pixel/amadeus-memory/pull/3)

This repository packages a separately installable Mneme bundle in [`dsh-mneme/`](dsh-mneme/). It extends the existing SQLite memory store, retrieval, graph and Desktop panel with stable typed identities, reviewed aliases and canonical links, Tag/entity ranking preferences, controlled Life experience intake, Scene-aware isolation, Recent Context and Core Memories. The upstream import and license are recorded in [`UPSTREAM.md`](UPSTREAM.md).

The enhancement was merged into `main` through [Memory PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1) and [PR #2](https://github.com/jeskoky-pixel/amadeus-memory/pull/2). It has not been installed in the production DSH Profile.

## Package and installation

- Source package: `dsh-mneme/`. The current PR candidate is `@amadeus/memory@1.0.1`, retaining plugin ID `dsh-mneme` and the original data path. The merged stable release remains `@modusensus/dsh-mneme@1.0.0` until PR #5 passes acceptance.
- The verified `1.0.0` archive is `dist/modusensus-dsh-mneme-1.0.0.tgz`; its SHA-256 and four-plugin acceptance are recorded in the [compatibility matrix](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/FOUR_PLUGIN_COMPATIBILITY.md). The earlier RC archive and its acceptance boundaries remain in [`MEMORY_V1_BACKGROUND_AND_PERFORMANCE.md`](docs/verification/MEMORY_V1_BACKGROUND_AND_PERFORMANCE.md).
- Native DSH Settings entry: **Amadeus 记忆 / Amadeus Memory** (overview, automatic memory, Embedding, Tag/entity preferences, link to the full Memory panel).
- In an isolated DSH Desktop Profile, choose and verify a dedicated `memoryDir` **before enabling** the bundle, then use Plugin Manager **Install bundle** with this archive. Set `apiToken` only if the optional trusted intake API is needed. The source package can also be linked during development.
- Keep only one Memory bundle enabled; the same plugin ID must not run twice. Keep the old Mneme package and a SQLite consistent backup for rollback. Do not point a development Profile at a live memory database.

The archive is built from `dsh-mneme/` with `npm run sync` followed by `npm pack --ignore-scripts --cache .npm-cache --pack-destination ../dist`. `npm run sync`, `node scripts/check-sync.js` and the focused tests check generated `lib/` files and behavior before packing. Install/upgrade/rollback details are in [Memory INSTALL](dsh-mneme/docs/INSTALL.md).

## Development

```powershell
cd dsh-mneme
npm test        # 运行 695 个测试
npm run test:all              # 完整套件，含上游发行专用测试
npm run test:upstream-release # 单独运行上游发行专用测试
npm run test:compat-windows   # Windows symlink/spawn capability probe
```

`npm test` is the product gate (540 tests at `1.0.0`): runtime, enhancer, GUI/config, migration, package, QA guard, privacy and safe cleanup. The full suite (`npm run test:all`) includes separate upstream release workflows and Windows symlink/spawn capability checks; use `npm run test:upstream-release` and `npm run test:compat-windows` to report those separately.

## Documentation

- [Native-settings install and acceptance checklist](dsh-mneme/docs/INSTALL.md)
- [User guide (Chinese)](dsh-mneme/docs/USER_GUIDE.zh.md)
- [Backup, upgrade and rollback](dsh-mneme/docs/BACKUP_ROLLBACK.md)
- [Release notes and package identity](dsh-mneme/docs/RELEASE_NOTES.md)
- [Measured performance and token cost](dsh-mneme/docs/PERFORMANCE.md)
- [QA memoryDir guard](dsh-mneme/docs/QA_GUARD.md)
- [Windows capability report](docs/WINDOWS_COMPATIBILITY.md)
- [Enhancement design and migration details](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)
- [Initial and focused quality acceptance](docs/verification/MEMORY_ENHANCER_ACCEPTANCE.md)
- [Real isolated DSH Desktop acceptance](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md)
- [Scene / Recent / Core final acceptance](docs/verification/SCENE_RECENT_CORE_ACCEPTANCE.md)
- [QQ Scene graph and 1.0 readiness](docs/verification/MEMORY_QQ_SCENE_GRAPH_ACCEPTANCE.md)

## 路线图

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.7** | 记忆核心与面板 | ✅ 已发布 |
| **v0.8** | 实体与身份增强 | ✅ 已发布 |
| **v0.9** | Amadeus Memory 产品化（0.9.5-amadeus.2） | 已合并 `main`，未公开发行或生产部署 |
| **v1.0** | QQ Scene 安全运行、图谱与后台整理（1.0.0） | 已完成隔离联合验收；未公开发行或生产部署 |

## Roadmap

| Version | Theme | Status |
|---------|-------|--------|
| **v0.7** | Memory core and panel | ✅ Released |
| **v0.8** | Entity and identity enhancement | ✅ Released |
| **v0.9** | Amadeus Memory productization (0.9.5-amadeus.2) | Merged into `main`; not publicly released or deployed |
| **v1.0** | QQ Scene safety, graph and background maintenance (`1.0.0`) | Isolated joint acceptance complete; not publicly released or deployed |

The Scene graph has been exercised through a real isolated Desktop GUI with synthetic memories. The earlier QQ Host test also exercised real model requests through isolated QQ Sessions. The trusted `amadeus.memory` Scene ACL read contract, directional persisted `scene_read_grants`, and revoke behavior have [focused acceptance evidence](docs/verification/SCENE_READ_ACL.md); default cross-group access remains closed, and the fresh four-plugin Profile did not repeat the full granted model call. Production recall quality and latency remain unmeasured. Production deployment is a separate decision.

## 隐私承诺

Memory 的巩固与摘要走**宿主模型**：默认开启的 `autoDream` / `autoSummarize` 会把待整理的记忆正文交给当前 DSH 宿主的模型服务；Embedding 默认配置也可能访问远端服务。只有显式把 Embedding 改为 `local` 并使用本地运行时，语义向量才在本地计算。这个插件不会把记忆正文发送到 Amadeus 自有服务器；远端模型的隐私边界由宿主模型提供方决定。安装前请阅读 [Memory INSTALL](dsh-mneme/docs/INSTALL.md) 与 [Enhancement design](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)。

## Privacy

Memory consolidation and summarization use the **host model**: the default-on `autoDream` / `autoSummarize` paths send memory text to the current DSH host's model service, and the default embedding configuration may call a remote provider. Semantic vectors stay local only when Embedding is explicitly set to `local` with a local runtime. This plugin does not send memory bodies to an Amadeus-owned server; the remote model provider's privacy boundary applies. Read [Memory INSTALL](dsh-mneme/docs/INSTALL.md) before installing.
