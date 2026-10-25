# Amadeus Memory handoff

2026-10-25. The implementation is on `codex/memory-enhancer` in this repository and under review in [PR #1](https://github.com/jeskoky-pixel/amadeus-memory/pull/1). The older `main` checkout at `plugins/amadeus-memory/` still contains the initial placeholder documents; use the PR branch for code review and development.

## Delivered

- `dsh-mneme/` is a separately installable DSH bundle extending Mneme's existing SQLite store, search, graph and panel. It provides stable typed identities, aliases, reversible canonical links, Tag/entity ranking weights and controlled, idempotent Life experience intake.
- Model tools include the existing Mneme memory operations plus two bounded read-only enhancer tools, `memory_preference_get` and `memory_identity_lookup`. They are hidden under `strictScope` because entity aliases and global preferences have no per-session scope labels.
- `dist/modusensus-dsh-mneme-0.9.4.tgz` is the reviewed install archive. Its checksum and real isolated Desktop validation are in [the latest acceptance report](docs/verification/REAL_DSH_ACCEPTANCE_2026-10-25.md).

## Current validation and remaining boundary

- The tarball installed through official DSH Desktop Plugin Manager into an isolated Profile, and remained loaded after a hard restart. The official DeepSeek-V4.1-Flash 1017 model successfully called four Memory tools. The isolated memory database reused the existing Qwen Embedding model configuration and yielded real stored vectors and `mode=vector` retrieval. GUI search and synthetic entity weight edit/restore were exercised after restart.
- Focused tool tests and `src`/`lib` sync passed. Earlier security, migration, preference and API results are in [the full acceptance report](docs/verification/MEMORY_ENHANCER_ACCEPTANCE.md).
- Production traffic, realistic semantic recall quality and production latency are still unverified. One loose paraphrase fell back to keyword, and remote Embedding latency had a long tail in a small synthetic run.

Do not change the live Mneme database, DSH Profile, QQ Bridge or Life data as part of this PR. Before deployment, back up the live SQLite consistently, rehearse on an isolated copy, review feature switches and keep the previous package and database backup for rollback. Do not merge or deploy PR #1 automatically.
