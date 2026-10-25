# Amadeus Memory Enhancer

Amadeus Memory 是 DeepSeek Harness 的独立记忆插件：它保存获授权的长期信息，在对话时检索相关记忆，并提供可视化的记忆、标签权重、实体关系和备份管理。此版本继承 Mneme 的插件 ID 与数据格式，方便已有用户升级。

> 当前增强版 `0.9.5-amadeus.1` 在 [PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1) 审阅中，尚未公开发行或部署到生产 DSH。

## 日常使用

在 DSH 设置中打开 **Amadeus 记忆**，可以看到记忆库状态，创建、搜索、编辑、归档和删除记忆；调整自动记忆、注入和 Embedding 参数；设置标签及实体权重；创建、校验并确认恢复备份。复杂图谱与审计仍可从“打开完整记忆管理”进入原 Mneme 面板。若向量服务未配置，关键词检索继续可用；页面会明确显示降级状态。安装前请先阅读 [中文用户指南](dsh-mneme/docs/USER_GUIDE.zh.md) 和 [安装与升级说明](dsh-mneme/docs/INSTALL.md)。

[![tests](https://img.shields.io/badge/tests-505%20passed-success)](https://github.com/jeskoky-pixel/amadeus-memory/pull/1)

This branch packages a separately installable Mneme bundle in [`dsh-mneme/`](dsh-mneme/). It extends the existing SQLite memory store, retrieval, graph and Desktop panel with stable typed identities, reviewed aliases and canonical links, Tag/entity ranking preferences, and a controlled Life experience intake. The upstream import and license are recorded in [`UPSTREAM.md`](UPSTREAM.md).

The enhancement is developed on `codex/memory-enhancer` and reviewed in [Memory PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1). It is not installed in the production DSH Profile by this branch.

## Package and installation

- Source package: `dsh-mneme/`, package name `@modusensus/dsh-mneme`, enhanced version `0.9.5-amadeus.1` (same plugin ID/data path as upstream 0.9.4).
- Reviewed installation archive: `dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz`. The archive is a local review artifact while controlled distribution is prepared; its SHA-256 is recorded in `docs/CREATOR_FINAL_PRODUCTIZATION.md`.
- Native DSH Settings entry: **Amadeus 记忆 / Amadeus Memory** (overview, automatic memory, Embedding, Tag/entity preferences, link to the full Memory panel).
- In an isolated DSH Desktop Profile, choose and verify a dedicated `memoryDir` **before enabling** the bundle, then use Plugin Manager **Install bundle** with this archive. Set `apiToken` only if the optional trusted intake API is needed. The source package can also be linked during development.
- Keep only one Memory bundle enabled; the same plugin ID must not run twice. Keep the old Mneme package and a SQLite consistent backup for rollback. Do not point a development Profile at a live memory database.

The archive is built from `dsh-mneme/` with `npm run sync` followed by `npm pack --ignore-scripts --cache .npm-cache --pack-destination ../dist`. `npm run sync`, `node scripts/check-sync.js` and the focused tests check generated `lib/` files and behavior before packing. Install/upgrade/rollback details are in [Memory INSTALL](dsh-mneme/docs/INSTALL.md).

## Development

```powershell
cd dsh-mneme
npm test        # 运行 505 个测试
npm run test:all              # full suite; 32 upstream/environment failures, not green
npm run test:upstream-release # 21 upstream release-only failures, expected non-green
npm run test:compat-windows   # Windows symlink/spawn capability probe
```

`npm test` is the green product gate (505 tests): runtime, enhancer, GUI/config, migration, package, QA guard, privacy and safe cleanup. The full suite (`npm run test:all`) is **not** green on this Windows sandbox because upstream release-only fixtures/workflows and some symlink/spawn capabilities are unavailable; use `npm run test:upstream-release` and `npm run test:compat-windows` for those separate, explicitly non-green checks.

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

## 路线图

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.7** | 记忆核心与面板 | ✅ 已发布 |
| **v0.8** | 实体与身份增强 | ✅ 已发布 |
| **v0.9** | Amadeus Memory 产品化（0.9.5-amadeus.1） | PR 审阅中，未公开发行 |

## Roadmap

| Version | Theme | Status |
|---------|-------|--------|
| **v0.7** | Memory core and panel | ✅ Released |
| **v0.8** | Entity and identity enhancement | ✅ Released |
| **v0.9** | Amadeus Memory productization (0.9.5-amadeus.1) | PR under review; not publicly released |

The Desktop acceptance exercises only synthetic memories. It does not validate production load or authorize production deployment. PR #1 remains open until a separate deployment decision.

## 隐私承诺

Memory 的巩固与摘要走**宿主模型**：默认开启的 `autoDream` / `autoSummarize` 会把待整理的记忆正文交给当前 DSH 宿主的模型服务；Embedding 默认配置也可能访问远端服务。只有显式把 Embedding 改为 `local` 并使用本地运行时，语义向量才在本地计算。这个插件不会把记忆正文发送到 Amadeus 自有服务器；远端模型的隐私边界由宿主模型提供方决定。安装前请阅读 [Memory INSTALL](dsh-mneme/docs/INSTALL.md) 与 [Enhancement design](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)。

## Privacy

Memory consolidation and summarization use the **host model**: the default-on `autoDream` / `autoSummarize` paths send memory text to the current DSH host's model service, and the default embedding configuration may call a remote provider. Semantic vectors stay local only when Embedding is explicitly set to `local` with a local runtime. This plugin does not send memory bodies to an Amadeus-owned server; the remote model provider's privacy boundary applies. Read [Memory INSTALL](dsh-mneme/docs/INSTALL.md) before installing.
