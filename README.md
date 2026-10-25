# Amadeus Memory Enhancer

This branch packages a separately installable Mneme bundle in [`dsh-mneme/`](dsh-mneme/). It extends the existing SQLite memory store, retrieval, graph and Desktop panel with stable typed identities, reviewed aliases and canonical links, Tag/entity ranking preferences, and a controlled Life experience intake. The upstream import and license are recorded in [`UPSTREAM.md`](UPSTREAM.md).

The enhancement is developed on `codex/memory-enhancer` and reviewed in [Memory PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1). It is not installed in the production DSH Profile by this branch.

## Package and installation

- Source package: `dsh-mneme/`, package name `@modusensus/dsh-mneme`.
- Reviewed installation archive: `dist/modusensus-dsh-mneme-0.9.4.tgz`. Check its SHA-256 in the [real DSH acceptance report](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md) before use.
- In an isolated DSH Desktop Profile, use Plugin Manager **Install bundle** with this archive, enable it, then set a dedicated `memoryDir` and `apiToken` in the plugin config. The original source package can also be installed as a local bundle during development.
- Keep the old Mneme package and a SQLite consistent backup for rollback. Do not point a development Profile at a live memory database.

The archive is built from `dsh-mneme/` with `npm run sync` followed by `npm pack --ignore-scripts --pack-destination ../dist`. `npm run sync`, `node scripts/check-sync.js` and the focused tests check generated `lib/` files and behavior before packing.

## Documentation

- [Enhancement design and migration details](dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md)
- [Initial and focused quality acceptance](docs/verification/MEMORY_ENHANCER_ACCEPTANCE.md)
- [Real isolated DSH Desktop acceptance](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md)

The Desktop acceptance exercises only synthetic memories. It does not validate production load or authorize production deployment. PR #1 remains open until a separate deployment decision.
