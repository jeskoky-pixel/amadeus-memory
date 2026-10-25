# Memory Enhancer: isolated DSH Desktop acceptance

Date: 2026-10-25. Target: `codex/memory-enhancer`, PR #1. This report covers the installable `dsh-mneme` bundle in a separate official DSH Desktop home and a separate SQLite memory directory. The production Mneme database, DSH Profile, QQ Bridge, Life data, and outgoing platform configuration were not changed.

## Host and credentials

- Host: official DSH Desktop `0.2.1-rc.3` on Windows. The plugin was loaded through the Desktop Plugin Manager in the isolated profile; its live HTTP health and memory routes responded after a hard process restart.
- Model: official `deepseek-official/deepseek-flash`, shown in the Desktop GUI as **DeepSeek-V4.1-Flash 1017**. Existing account credentials were copied privately into the isolated DSH home for this test and are not in the repository.
- Embedding: reused the existing Mneme `user_settings.vector` endpoint, model `Qwen/Qwen3-Embedding-8B`, and credential in the isolated SQLite database only. The production setting was disabled; the isolated copy was enabled. No endpoint URL, credential or real memory text is included here.

## Observed checks

| Check | Evidence | Result |
| --- | --- | --- |
| Real embedding write | Four synthetic memories had stored 4096-dimensional vectors from `Qwen/Qwen3-Embedding-8B`; semantic status reported 4/4 embedded and retrievable, 0 dimension mismatches. | Pass |
| Real vector retrieval | The Desktop route `/api/dsh-mneme/search?mode=vector` returned `mode=vector` and the target synthetic memory on a content query, before and after process restart. | Pass |
| Model tools | One isolated official model turn invoked `memory_save` then `memory_search`; both tool results reported `isError=false`. After the tool completion, a second turn invoked `memory_preference_get` and `memory_identity_lookup` on a confirmed synthetic alias; both results reported `isError=false`, resolved the expected entity and left preferences unchanged. Both turns completed. The saved SQLite row has `source=tool`, the requested tag, and a real vector. | Pass |
| GUI interaction | In the running DSH GUI, opened Memory, searched a synthetic term and saw the result count change from 4 to 1. The Entity panel showed the confirmed alias, typed QQ identity and saved 1.4 weight. Changed that synthetic weight to 1.3 with GUI controls, confirmed it through the live API, then restored 1.4 in the GUI and confirmed again. | Pass |
| Package installation | The final tarball was installed and enabled with the official Desktop Plugin Manager in the isolated Profile. An earlier in-place install over a source link failed at application despite package-manager success; after removing that link, the tarball installation reported `application=applied`, the profile dependency became a local archive reference, and the installed `lib/tools.js` contained both new tools. | Pass after replacing old link |
| Restart persistence | After hard restarting the Desktop process with the tarball installed, the plugin health route, vector configuration (masked key), four memories, 4/4 vector coverage, model-created memory, alias, entity weight, and GUI panel remained available. A new post-restart search returned `mode=vector` and the stored target memory. The original model session then called both new read-only tools again; both results succeeded and the turn completed. | Pass |

The earlier acceptance report documents isolated API checks for plugin enable/disable, preferences, aliases, graph management, trusted intake, idempotent replay, merge/undo, and persistence. Those are separate from the GUI and model-tool observations above.

## Performance and limits

For one synthetic content query and five returned candidates, 12 requests per mode on this isolated Desktop gave keyword p50/p95 **15.8/46.3 ms** and remote-vector p50/p95 **174.2/10,919.4 ms**. All 12 measured vector requests reported `mode=vector`; the high p95 reflects a remote-provider long tail. The first content query immediately after the final hard restart fell back to keyword, while the next returned `mode=vector`; provider availability therefore also affects mode. The small sample and synthetic query do not establish production latency. A looser paraphrase fell back to keyword under current threshold, so semantic recall quality on real conversation queries remains unverified. No real QQ/Life/production traffic was sent.

The installable tarball is [`dist/modusensus-dsh-mneme-0.9.4.tgz`](../../dist/modusensus-dsh-mneme-0.9.4.tgz), SHA-256 `3806139B5F976B157031A149D9996FACD3CD341FEC980B22BAEBC5FA4D918E8A`. The archive contains the generated main entry, client and runtime manifest; a 389-path inspection found no credentials, `.env`, SQLite database or `node_modules`. `src/` and `lib/` match. Deployment should back up the then-current production SQLite, install the reviewed tarball in an isolated profile first, enable feature switches deliberately, and retain the previous plugin package and database backup for rollback. PR #1 is not merged or deployed by this acceptance.
