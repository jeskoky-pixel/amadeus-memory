# Amadeus Memory v1.0 candidate: Scene background jobs and retrieval baseline

This report covers the bounded v1.0 work: autoDream, autoSummarize and Sleep
under trusted QQ Scene isolation, plus a reproducible synthetic retrieval
benchmark. It does not use production memory rows or production DSH settings.

## Benchmark method

Run `node scripts/benchmark-scene-v1.mjs` from `dsh-mneme/`. The script creates
10,000 synthetic memories in the OS temporary directory with fixed seed
`0x51c0ffee`, five group Scenes and 1,000 stored 4096-dimensional vectors.
It issues 120 keyword and 100 vector queries after ten warmup queries per path,
plus one burst of ten Promise-based requests. Top K is ten. Scene filtering is
enabled. Vector query generation is local and precomputed; no remote Embedding
latency is included. The benchmark writes `result.json` beside its synthetic
SQLite database.

The pre-fix baseline was measured on Windows, Node 22.23.2, AMD Ryzen 9
9955HX3D (32 logical cores), 31.2 GiB RAM. Nearest-rank percentiles in
milliseconds:

| Path | Queries | P50 | P95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| SQLite keyword, one Scene | 120 | 4.837 | 11.046 | 12.813 |
| Service keyword, one Scene | 120 | 36.285 | 53.356 | 61.247 |
| SQLite vector, one Scene | 100 | 18.569 | 21.153 | 26.582 |
| Service vector, one Scene | 100 | 65.553 | 84.987 | 97.275 |

All queries returned at least one row. The ten-request keyword burst completed
in 402.54 ms on one process and SQLite connection; it is a simple overlapping
request check, not a multi-process load test. The dataset has 10,000 memories
but only 1,000 stored vectors, so vector percentiles apply to that coverage.
The separate remote Embedding probe in the Scene ACL acceptance report verifies
the configured provider, but its one-off latency is not a retrieval P95.

## Candidate results

The reviewed `1.0.0-rc.1` source was measured with the same fixed synthetic
database, queries and machine. The two service paths remain scoped to one
trusted group Scene. Nearest-rank percentiles in milliseconds:

| Path | Queries | P50 | P95 | Maximum | P95 change from pre-fix |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQLite keyword, one Scene | 120 | 4.787 | 11.207 | 13.272 | +0.161 ms |
| Service keyword, one Scene | 120 | 32.868 | 48.169 | 54.381 | -5.187 ms |
| SQLite vector, one Scene | 100 | 18.502 | 19.313 | 20.487 | -1.840 ms |
| Service vector, one Scene | 100 | 61.959 | 77.308 | 85.467 | -7.679 ms |

All measured queries returned rows. The ten-request keyword burst completed
in 340.687 ms. These differences are observations from one local run per
version, not a claim of stable production improvement. Remote Embedding and
real conversation query quality remain outside this synthetic P95.

## Scene job acceptance

Source and synchronized `lib/` pass the 540-test Amadeus quality gate.
Focused Scene background regression tests pass 14/14 and cover multi-Scene
Dream/Sleep prompts, exact Scene writes, legacy NULL isolation, relation
evidence filtering before canonical aggregation, entity pagination and merged
members, cancellation result, aggregate Dream baseline persistence across
restart, and a trusted Host binding on a custom QQ preset.

## Isolated DSH Desktop acceptance (2026-10-27)

The pre-boundary-fix `1.0.0-rc.1` archive (SHA-256
`B8EEEC6FFDD8FA5A66315036F58A21F193613FEC921A564BCB9224B9AD16EAB3`)
was installed with the official Plugin Manager into the isolated Desktop
Profile and hard-restarted. This Profile uses
synthetic memories and a separate SQLite directory; the production Mneme
database, DSH Profile, QQ Bridge and Life data were not changed.

| Check | Observed result |
| --- | --- |
| Install and restart | The active plugin and native **Amadeus 记忆** panel reported `1.0.0-rc.1` after hard restart. SQLite `quick_check` returned `ok`; 35 synthetic memories and settings persisted. |
| Background jobs | In strict QQ Scene mode, Dream wrote separate Scene audits and summaries. Sleep wrote four-stage audits for seven Scene buckets. Non-QQ autoSummarize wrote two synthetic memories and an audit. A group A Dream input and memory query did not contain the group B synthetic private marker. |
| Status UI | The native panel showed both the latest auto-consolidation and latest Sleep timestamps, even after newer Dream rows filled the recent-run list. It stated that enabled Dream/Sleep run per persisted Scene. |
| Embedding and model tools | The isolated Profile retained its existing `Qwen/Qwen3-Embedding-8B` configuration. The remote provider returned a 4096-dimensional embedding. A real model invocation successfully called `memory_save` and `memory_search(mode=vector)`; vector search returned the synthetic target. |
| GUI and persistence | The native memory list found synthetic records. After hard restart, the panel, audited jobs, memories and Scene settings remained available. |

The status page still showed `invalid decisions: 1 errors` from a model Dream
attempt. That is a recorded model-decision error, not an SQLite error; the
per-Scene audit and Sleep timestamps were present. This acceptance does not
establish that every future model decision is valid.

## Package, limits and rollback

`npm run package:amadeus` passed **540/540** tests, synchronized `src/` with
`lib/`, and passed source and archive privacy checks. The installable archive is
`dist/modusensus-dsh-mneme-1.0.0-rc.1.tgz`, SHA-256
`AC4EC4AA407D3A5F01CF878D607CD93C7F92283CF58A59866CAE985A286AA666`.
The privacy check found no credentials, databases, logs, symlinks or temporary
artifacts in the archive. No local authentication URL or token is included in
this report.

The P95 figures above exclude remote Embedding and model generation. Real QQ
traffic, production-size multi-Scene load, long-term semantic quality and
production migration remain unverified. The Desktop checks use synthetic data;
they do not substitute for a monitored production rollout.

The final boundary fix makes strict-mode autoSummarize reject an unbound
Session with a custom/unknown Preset instead of writing it as legacy. A failing
regression reproduced the prior model call; after the fix, both that case and
the known ordinary DSH Preset compatibility test pass. The complete 540-test
gate and archive privacy scan were rerun. This change does not alter the
retrieval path or the P95 measurements above. The final archive was not
reinstalled into Desktop; the Desktop observations in this report apply to the
pre-fix archive identified above, while the changed boundary was verified by
the focused and full automated suites.

Before deployment, back up the current SQLite database and retain the previous
plugin archive. Rehearse installation and migration on an isolated copy, then
enable the reviewed archive during a maintenance window and watch Scene audits,
retrieval and resource use. To roll back, stop the new plugin, restore the old
archive and, if new-version data were written, restore the matching pre-upgrade
SQLite backup. This PR does not deploy or merge the candidate.
