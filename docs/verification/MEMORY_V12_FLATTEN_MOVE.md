# Amadeus Memory v1.2 root migration and package audit

## Scope and provenance

The v1.2 development branch moved 493 tracked paths from `dsh-mneme/` to the repository root using Git renames. Two colliding READMEs were retained as `docs/legacy/AMADEUS_ROOT_README_PRE_V12.md` and `docs/legacy/MNEME_UPSTREAM_README.md`; their replacement root README is the current product guide. Nested ignore rules were merged into the root `.gitignore`. No tracked file remains under `dsh-mneme/`. A byte SHA-256 comparison confirmed 183 `src/` and `lib/` files unchanged immediately after relocation, before the narrow package identity edits.

The original Mneme MIT license remains in root `LICENSE`, including `Copyright (c) 2026 Modusensus`. Root `UPSTREAM.md` retains the source repository and upstream commit `146fa3657dbb73c0498aba969977e7c14e13684a`. Both files are present in the 281-file npm pack manifest.

Only public distribution identity changed: npm package `@fg-lab/amadeus-memory@1.2.0`, Bundle package reference, client package labels, version check Registry URL, package audit, and root-relative build paths. The runtime Plugin ID `dsh-mneme`, `~/.dsh/memory`, database schema, API routes, tools, configuration keys, and memory behavior were not renamed.

## Automated verification

| Check | Result |
| --- | --- |
| `npm.cmd test` product gate | 717/717 passed |
| `npm.cmd run verify:release` | Passed; 281 packaged files; no audit warnings |
| `npm.cmd run package:amadeus` | Passed; produced `dist/fg-lab-amadeus-memory-1.2.0.tgz` and privacy audit |
| `npm.cmd publish --dry-run --access public --ignore-scripts --json` | Passed; public Registry target, no actual publish |
| `git diff --check` and staged diff check | Passed with CRLF attribute for the inherited `lib/client.js` |
| `npm.cmd run test:all` | 2618 passed, 35 failed, 1 skipped, of 2654; includes upstream-only tests excluded from the product gate |

The `test:all` failures cover stale upstream-only release workflow assertions (for example `security.yml` and `release-prep.yml` paths absent from this fork), a missing sample `pipelines/` project, and older feature assumptions (for example the peak-hours and retention wiring assertions). The two release-notes fixture failures caused by the new root path were repaired. A controlled pre-move run from the original `d1cebdb` tree, with its existing dependency directory linked read-only, had the same 2,654 tests with 2,617 passed, 36 failed and 1 skipped. All 35 remaining failure names also occurred before the move; the one additional pre-move failure was a stale old-package `versionUrl` expectation fixed by this release. Thus the root relocation added no remaining `test:all` failure, but the upstream-only suite is not green and must not be reported as such.

| Pre-existing failure group | Count | Concrete cause observed |
| --- | ---: | --- |
| `api-routes-gaps`, peak-hours, embedding receipt/schedule, failure retention, capability guide, distill retention, MCP parity, organize scope | 14 | Upstream tests assert wiring or default tool visibility that differs from the current Amadeus release code. The `failure-retention` README key drift introduced by the new README was repaired; its separate runtime wiring assertion already failed before the move. |
| `pipeline.test.js` and related pipeline projection cases | 13 | Fixture expects a sample `pipelines/` project that is absent in both trees; follow-on cases have no pipeline to inspect. |
| `release-workflow.test.js` | 1 | Attempts to read the removed upstream `.github/workflows/release.yml` from the old two-level repository layout. |
| `workflow-guards.test.js` | 7 | Asserts upstream `security.yml` and `release-prep.yml` workflows and old release jobs that this fork did not carry; all failed before relocation. |

### Synthetic retrieval benchmark

Same Windows host, Node v22.23.2, deterministic 10,000-memory / 5-Scene synthetic dataset, 1,000 precomputed 4096-dimension vectors; no remote Embedding request. P95 values in milliseconds:

| Path | Before move | After move | Difference |
| --- | ---: | ---: | ---: |
| Keyword service | 53.951 | 52.146 | -1.805 |
| Vector service | 89.075 | 84.673 | -4.402 |
| Keyword SQL | 11.180 | 11.045 | -0.135 |
| Local vector | 23.818 | 24.022 | +0.204 |

These single-run changes are within ordinary host noise and do not prove a performance improvement. The directory move did not change retrieval algorithms. Real remote Embedding latency and production recall quality remain unmeasured.

## Upgrade boundary

The package name change can make DSH Plugin Manager treat v1.2 as a different installed package even though both packages declare `dsh-mneme`. Safe upgrade: disable the old Memory, export the Profile and create a SQLite-consistent backup of the complete `memoryDir`, remove the old Bundle configuration, install the new package, carry forward the same Workspace and settings, then hard restart and verify memory content, graph links, vectors and Scene authorization. Never run old and new packages against the same database simultaneously. Rollback requires the prior package and a database backup compatible with that version.

The automated tests use synthetic data and do not modify the production DSH Profile or real Memory database. A real Desktop GUI install, upgrade/rollback, hard-restart persistence, and remote Embedding verification are separate gates and must not be inferred from this report.
