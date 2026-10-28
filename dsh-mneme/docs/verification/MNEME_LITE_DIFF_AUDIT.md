# Mneme-lite baseline audit

## Verified inputs

- Upstream `slow-stack/mneme` source commit: `146fa3657dbb73c0498aba969977e7c14e13684a` (`v0.9.4`). The checked upstream `main` points at this commit.
- Amadeus Memory development base: GitHub `main` at `879aa328` (PR #4 merged). This branch, `codex/memory-mneme-lite`, starts there. Package identity is still `@modusensus/dsh-mneme@1.0.0`; no second package identity should be introduced before install compatibility is proven.
- Comparison used the exact upstream source snapshot and current `dsh-mneme/src` and `lib/client.js` files. It did not touch an installed plugin, production profile, or production database.

## Source difference

The current fork changes 16 upstream `src` files and adds 11 `src` files. Most upstream source remains byte identical, including `hot-memory.js`, BM25, adaptive search, scope resolution, mirror, and document handling. The changed core is concentrated in `index.js`, `store.js`, `service.js`, `tools.js`, `inject.js`, `summarize.js`, Dream/Sleep, the entity extractor, and APIs. Those changes mix useful enhancements with the old Scene, trusted intake, and recent-context architecture; copying them wholesale would defeat the new lightweight direction.

The original GUI bundle is about 601 KB; the current extended bundle is about 780 KB. The extended GUI contains the original Mneme pages and Amadeus settings, preferences, identity and backup UI. Retain it as the UI base, then remove obsolete Scene/recent-context controls and add Workspace/recent-activity controls. Static source comparison cannot substitute for a real DSH Desktop UI check.

## Keep / retire decision

| Keep and adapt | Retire from the lite runtime |
| --- | --- |
| Original Mneme store, retrieval, embedding, Hot Memory, autoSummarize, autoDream, Sleep and GUI | Old Scene job scheduler and QQ-specific Scene policy |
| Bounded Tag/entity preferences and GUI | Life-specific trusted intake/provenance path |
| Stable identity, alias and reversible canonicalization on Mneme entities | Old in-process recent-context buffer |
| SQLite snapshot, staged restore and backup GUI | Any second memory or graph engine |
| Additive Workspace admission and isolated recent-activity tables | Platform-specific sharing switches |

## Critical integration constraints

1. The selected Workspace must be a stable Registry ID. Every model-side entry must check live Registry membership; name, Preset, `cwd`, and caller parameters are not authorization evidence. An unselected or unavailable Registry denies model access while leaving owner configuration UI available.
2. The existing v1 database can contain old QQ Scene rows. It must **not** automatically become the selected Workspace's database. The simplest safe storage direction is a separate Mneme database for each bound Workspace with an explicit, audited migration path. A live Workspace change requires runtime rebinding or a host-supported plugin reload; merely changing a setting while the old store remains open is unsafe. The installed DSH `cordis-plugin-loader` documents `loader.update(id, options)` as a restart path and its implementation forces an entry update. The integration still needs an isolated Desktop test: write the new binding, deny model access while the old store remains active, then remount the plugin and open the new Workspace database.
3. Keep original Mneme Scope behavior within the selected Workspace. A Workspace boundary alone does not grant cross-session access to private long-term memories. Recent activity requires its own server-side permission check.
4. Dream, Sleep and summarization must stop accepting work from the old Workspace at a switch. Pending jobs must be drained or generation-fenced before the new database is opened.
5. Backups must identify and restore the matching Workspace database; restore of a live open SQLite file remains staged until restart.

## Next gate

Implement and test the standalone Registry admission module first. Then wire every model-side entry and storage lifecycle, preserving the original core paths. GUI and actual DSH Desktop verification are mandatory before declaring this branch ready for review.
