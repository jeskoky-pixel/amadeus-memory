# Amadeus Memory handoff

## Latest state (2026-10-26)

The original persistent DSH Creator session implemented the productization fixes; Codex reviewed and committed the main implementation on `codex/memory-enhancer` as `fa87de7`. A follow-up release workflow fix allows repacking after README changes despite stale previous metadata. The default Amadeus product gate is `npm test`: Codex independently observed **490/490 pass** after this fix, plus 3/3 focused runs of the concurrent initialization regression. The full inherited upstream sweep is separately non-green because this fork lacks upstream release workflows and this Windows host lacks some symlink/process capabilities; see `docs/QA_FAILURE_INVENTORY.md` and `docs/WINDOWS_COMPATIBILITY.md`. Do not describe the full sweep as passing.

README 更新及发行流程修复后重建的 archive `dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz` SHA-256 为 `e861c5cfab215968fd401abc8c4c358fbaf4a8517f9b0b4aaba25b53fa7ad4c1`；`dist/PACKAGE_INFO.json` 是本地元数据。两个全新隔离官方 DSH Desktop 在启用前均验证独立 `memoryDir`。Codex 实测 GUI 创建/编辑/归档/取消归档、Tag 权重添加/恢复默认、配置保存/刷新/重启、备份/校验/确认恢复、停启/卸载重装及数据保留。最终文档和发行脚本变更未改变 Memory 运行时代码，最终 tarball 本身未重做 Desktop 安装。归档状态 DTO 和并发 SQLite 首次打开缺陷已修复。生产 Memory 未修改；历史 QA 目录事件记录在主项目本机私有审计。

User direction on 2026-10-26: stop combined three-plugin runtime testing for now. The brief joint startup probe is not a final integration acceptance. Keep PR #1 OPEN, avoid production deployment and public release, and update README/HANDOFF for outside readers. Older hashes and test counts below are historical checkpoints; use this section and the current commit for recovery.

2026-10-25. The implementation is on `codex/memory-enhancer` in this repository and under review in [PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1). The older `main` checkout at `plugins/amadeus-memory/` still contains the initial placeholder documents; use the PR branch for code review and development.

## Delivered

- `dsh-mneme/` is a separately installable DSH bundle extending Mneme's existing SQLite store, search, graph and panel. It provides stable typed identities, aliases, reversible canonical links, Tag/entity ranking weights and controlled, idempotent Life experience intake.
- Model tools include the existing Mneme memory operations plus two bounded read-only enhancer tools, `memory_preference_get` and `memory_identity_lookup`. They are hidden under `strictScope` because entity aliases and global preferences have no per-session scope labels.
- The productized enhanced edition is `@modusensus/dsh-mneme@0.9.5-amadeus.1` (same package/plugin ID as upstream 0.9.4, so its data/config/Embedding settings are inherited). It adds the native DSH settings page **Amadeus 记忆 / Amadeus Memory**, an owner-authenticated settings API and install/upgrade/rollback/user docs.
- `dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz` is the current install archive (SHA-256 `cf584d7c410047e656a0f3385b3e9f3c9a4068be52102e1d4d19ab0fc3e0e0fc`); metadata is in `dist/PACKAGE_INFO.json`. The earlier `0.9.4` archive and isolated Desktop acceptance remain historical evidence for the upstream core, not for the new settings page.
- REWORK_2 fixed a false conflict after a normal single-page Config Forms save, added a state-transition regression, and filled the applicable Security/README/release-docs gaps. The final package is built from the current tree; see `.productization-task/REWORK_2_REPORT.md` for exact tests and remaining environment/upstream-release gates.

## Current validation and remaining boundary

- Automated targeted validation covers the client registration, local-save conflict transition, owner API, feature/preference/vector behavior, package identity/docs, tools and core service/security tests. The full local sweep is 2378 tests / 2345 pass / 32 fail / 1 skip / 1 timeout; remaining failures are sandbox child-process/symlink limits and upstream release pipeline/workflow guards that this private fork intentionally does not copy. Exact evidence is in `.productization-task/REWORK_2_REPORT.md`; those items are not claimed as PASS.
- The earlier official Plugin Manager install/hard-restart/real Qwen vector run was on `0.9.4` and is recorded in [the latest acceptance report](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md). The new native settings page still requires Codex's isolated Desktop GUI/Plugin Manager/hard-restart acceptance.
- Production traffic, realistic semantic recall quality and production latency are still unverified. One loose paraphrase fell back to keyword, and remote Embedding latency had a long tail in a small synthetic run.

Do not change the live Mneme database, DSH Profile, QQ Bridge or Life data as part of this PR. Before deployment, back up the live SQLite consistently, rehearse on an isolated copy, review feature switches and keep the previous package and database backup for rollback. Do not merge or deploy PR #1 automatically.
