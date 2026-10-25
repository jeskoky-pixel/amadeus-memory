# Amadeus Memory handoff

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
