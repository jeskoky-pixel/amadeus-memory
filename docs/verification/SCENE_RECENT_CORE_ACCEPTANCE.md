# Scene / Recent / Core acceptance — 2026-10-26

Branch `codex/scene-recent-core` starts at GitHub `main` merge commit `db2c234f`. Work and tests used isolated databases and the separate `private/memory-development/qa-desktop` DSH home. Production Mneme, QQ Bridge, Life, State, and DSH Profile were untouched.

## Result

| Area | Result | Boundary |
| --- | --- | --- |
| Scene-aware Memory | Trusted in-process scene capability, scene-stamped ordinary memories, read filtering, directional grants, scene-local attribute invalidation, and fail-closed legacy HTTP/standalone/MCP and graph surfaces. Turning switches off does not expose already tagged rows. | The installed QQ Bridge has no verified Host scene contract. Actual QQ scene acquisition and cross-scene sharing remain disabled. Synthetic Host-event tests establish the contract only. |
| Recent Context | Default-off in-memory buffer; 10-minute TTL, 20 events per scene, 500-token read budget, retained-event dedupe, bounded scene count, expiration cleanup, directional authorization, and owner-admin clear/status. | No real QQ events enter the buffer until a verified Host adapter exists. Restart intentionally clears it. |
| Core Memories | Durable `protected` state and optional first-person note on the existing memory row; owner-admin management and guarded model tool for an explicitly requested, Host-verified admin private conversation. Ordinary dedupe, update, archive, forget, and removal cannot silently destroy protection. | The private-conversation tool cannot become available in real QQ without the Host contract. Promoting an unscoped legacy row in the owner GUI does not make it private; the GUI warns about this. |

Strict Scene mode conservatively closes legacy content HTTP/MCP and unfilterable graph/identity reads. autoDream, Sleep, and summarization stop when Scene isolation is active or scoped rows exist because their current derivation does not propagate scene provenance. The existing same-session hot memory is retained only while the trusted scene remains unchanged; it is suppressed after a scene switch. These capabilities need provenance-aware implementations and a verified QQ Host adapter before strict QQ use.

## Verification

- Independent targeted tests: **466/466 passed** across Scene, Recent, Core, API, standalone API, model tools, GUI client, injection, summarization, dream, sleep, and configuration. Repository `npm test` quality gate: **505/505 passed**. `src`/`lib` sync check (86 files), JS syntax checks, and `git diff --check` passed.
- Synthetic group-B secret did not appear in group-A keyword/attribute/graph-candidate/injection paths; admin in group A did not inherit private grants. Admin private required a directional grant, and revocation took effect for the next read. Plain JSON scene/admin claims and ordinary protected/scene fields were rejected or ignored. Standalone HTTP and MCP data plane fail closed without trusted output-scene authority. Tests also cover private rows after switches turn off and after daemon startup with defaults.
- The final tarball was installed, enabled, and hard-restarted with the official DSH Desktop Plugin Manager in the isolated QA Profile. Live owner-admin Scene/Recent endpoints and Recent clear worked. A synthetic memory was promoted to Core with a first-person note; both persisted after hard restart. Ordinary memory write and trusted intake smoke checks passed.
- The isolated Desktop reused its existing `Qwen/Qwen3-Embedding-8B` configuration; the key was masked in responses and stayed outside this repository. Stored synthetic vectors were 4096-dimensional. After final-package restart, a real `mode=vector` request retrieved the expected synthetic memory. An official DeepSeek Flash QA turn invoked `memory_save` and `memory_search`; the save merged an existing synthetic record, while its later search did not rank that record into the returned set. This is a retrieval-quality limitation, not evidence of a Scene leak.
- The isolated Desktop host exposed HTTP and Plugin Manager but no targetable QA GUI window. Native panel code and owner API passed automated tests; **mouse-driven GUI operation and a real QQ model answer were not verified**. No production accuracy or P95 latency conclusion is drawn from this QA run.

## Package and deployment preparation

`dist/modusensus-dsh-mneme-0.9.5-amadeus.1.tgz` — SHA-256 `F16F0F4AA46D24A22C202C57034FEEB95527997EACA55264B4D20E70B1F31E31`. Archive inspection found no `.env`, SQLite database, `node_modules`, or credentials. Package identity and database directory stay unchanged.

Before production use, back up the current SQLite and retain the old package. Apply this additive migration first to an isolated copy; enable switches only after a trustworthy Host scene adapter has been implemented and tested against actual QQ audience identities. If rolling back, restore the database backup together with the previous package, because older code has no Scene authorization for rows created by this version. PR delivery does not install or enable the package in production.
