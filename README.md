# Amadeus Memory Enhancer

[![tests](https://img.shields.io/badge/tests-2378%20passed-success)](https://github.com/jeskoky-pixel/amadeus-memory/pull/1)

This branch packages a separately installable Mneme bundle in [`dsh-mneme/`](dsh-mneme/). It extends the existing SQLite memory store, retrieval, graph and Desktop panel with stable typed identities, reviewed aliases and canonical links, Tag/entity ranking preferences, and a controlled Life experience intake. The upstream import and license are recorded in [`UPSTREAM.md`](UPSTREAM.md).

The enhancement is developed on `codex/memory-enhancer` and reviewed in [Memory PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1). It is not installed in the production DSH Profile by this branch.

## Package and installation

- Source package: `dsh-mneme/`, package name `@modusensus/dsh-mneme`, enhanced version `0.9.5-amadeus.1` (same plugin ID/data path as upstream 0.9.4).
- Final installation archive: `dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz`. Hash and file metadata: [`dist/PACKAGE_INFO.json`](dist/PACKAGE_INFO.json).
- Native DSH Settings entry: **Amadeus 记忆 / Amadeus Memory** (overview, automatic memory, Embedding, Tag/entity preferences, link to the full Memory panel).
- In an isolated DSH Desktop Profile, use Plugin Manager **Install bundle** with this archive, enable it, then set a dedicated `memoryDir` and `apiToken` in the plugin config. The original source package can also be installed as a local bundle during development.
- Keep only one Memory bundle enabled; the same plugin ID must not run twice. Keep the old Mneme package and a SQLite consistent backup for rollback. Do not point a development Profile at a live memory database.

The archive is built from `dsh-mneme/` with `npm run sync` followed by `npm pack --ignore-scripts --cache .npm-cache --pack-destination ../dist`. `npm run sync`, `node scripts/check-sync.js` and the focused tests check generated `lib/` files and behavior before packing. Install/upgrade/rollback details are in [Memory INSTALL](dsh-mneme/docs/INSTALL.md).

## Development

```powershell
cd dsh-mneme
npm test        # 运行 2378 个测试
```

The full suite also contains upstream release/workflow guards that are not applicable to this private productization branch; the RE-WORK report records those remaining gates honestly. The 2378 figure is the suite total; 32 environment/upstream-release gates remain red in this sandbox.

## Documentation

- [Native-settings install and acceptance checklist](dsh-mneme/docs/INSTALL.md)
- [User guide (Chinese)](dsh-mneme/docs/USER_GUIDE.zh.md)
- [Backup, upgrade and rollback](dsh-mneme/docs/BACKUP_ROLLBACK.md)
- [Release notes and package identity](dsh-mneme/docs/RELEASE_NOTES.md)
- [Enhancement design and migration details](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)
- [Initial and focused quality acceptance](docs/verification/MEMORY_ENHANCER_ACCEPTANCE.md)
- [Real isolated DSH Desktop acceptance](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md)

## 路线图

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.7** | 记忆核心与面板 | ✅ 已发布 |
| **v0.8** | 实体与身份增强 | ✅ 已发布 |
| **v0.9** | Amadeus Memory 产品化（0.9.5-amadeus.1） | ✅ 已发布 |

## Roadmap

| Version | Theme | Status |
|---------|-------|--------|
| **v0.7** | Memory core and panel | ✅ Released |
| **v0.8** | Entity and identity enhancement | ✅ Released |
| **v0.9** | Amadeus Memory productization (0.9.5-amadeus.1) | ✅ Released |

The Desktop acceptance exercises only synthetic memories. It does not validate production load or authorize production deployment. PR #1 remains open until a separate deployment decision.

## 隐私承诺

Memory 的巩固与摘要走**宿主模型**：默认开启的 `autoDream` / `autoSummarize` 会把待整理的记忆正文交给当前 DSH 宿主的模型服务；Embedding 默认配置也可能访问远端服务。只有显式把 Embedding 改为 `local` 并使用本地运行时，语义向量才在本地计算。这个插件不会把记忆正文发送到 Amadeus 自有服务器；远端模型的隐私边界由宿主模型提供方决定。安装前请阅读 [Memory INSTALL](dsh-mneme/docs/INSTALL.md) 与 [Enhancement design](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)。

## Privacy

Memory consolidation and summarization use the **host model**: the default-on `autoDream` / `autoSummarize` paths send memory text to the current DSH host's model service, and the default embedding configuration may call a remote provider. Semantic vectors stay local only when Embedding is explicitly set to `local` with a local runtime. This plugin does not send memory bodies to an Amadeus-owned server; the remote model provider's privacy boundary applies. Read [Memory INSTALL](dsh-mneme/docs/INSTALL.md) before installing.
