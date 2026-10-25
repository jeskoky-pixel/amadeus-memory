# Memory QA failure inventory (latest local source)

Run scope: full standard suite, explicit isolated `.test-tmp` where tests create data; no production/default `~/.dsh/memory`.

Default `npm test` is the green 489/489 product gate and does **not** run this full inventory. Use `npm run test:all` for the full non-green suite. Capability details: [WINDOWS_COMPATIBILITY.md](WINDOWS_COMPATIBILITY.md).

Latest final full sweep: **190 files / 2392 tests / 2359 pass / 32 fail / 1 skip / 1 timeout**. After that sweep, one admin archived-status HTTP regression and one concurrent fresh-DB regression were added and passed; current source total is **2394 tests**, and the default product gate is **489/489 pass**. The 32 failures below are unchanged.

`lib-smoke` temporarily failed because `lib/qa-guard.js` was added after the prior sync; `npm run sync` fixed it and the final sweep includes it green. It is not one of the remaining 32.

## 21 upstream-only release fixture/workflow failures

These are not Amadeus product failures. The private fork intentionally does not include upstream npm/GitHub publishing workflows or the upstream project's `.mneme` release pipeline. Suggested scope: upstream repository only; if retained in this fork, skip with an explicit reason. Do not copy/invent a publishing pipeline to make them green.

| file | test | category |
|---|---|---|
| pipeline.test.js | 真实工作流读得出来：目录里那条发版工作流通过校验，且引用自洽 | upstream-only fixture |
| pipeline.test.js | 回归锁：图里每一步都带着反事实对照（没有对照的步骤不该进图） | upstream-only fixture |
| pipeline.test.js | 图里有闸门：至少一条 gate 与至少一个汇合点 | upstream-only fixture |
| pipeline.test.js | 没有运行记录时，每个节点都是 candidate | upstream-only fixture |
| pipeline.test.js | readPipelineDoc：认不出 id 时不编造，但要列出有什么 | upstream-only fixture |
| pipeline.test.js | 清单行自带规模与作用域，够第一屏用 | upstream-only fixture |
| pipeline.test.js | 工作流本体住项目里，不进 npm 包 | upstream-only fixture |
| pipeline.test.js | 同 id 两处都有：项目层赢，被遮蔽的那份要报出来 | upstream-only fixture |
| pipeline.test.js | 项目层有坏文件：不拖死全局层，但要报出来 | upstream-only fixture |
| pipeline.test.js | 不给项目根就只读全局层，如实标出来 | upstream-only fixture |
| pipeline.test.js | 路由 /api/dsh-mneme/pipeline：读得出、认不出 id 时不编造 | upstream-only fixture |
| pipeline.test.js | 字段白名单锁：节点投影 16 个键、首屏清单 15 个键 | upstream-only fixture |
| pipeline.test.js | 可断言节点：没写断言时投影是 null | upstream-only fixture |
| workflow-guards.test.js | security.yml 的 osv-scanner 保持 fail-on-vuln: true | upstream-only workflow |
| workflow-guards.test.js | release.yml 的 provenance 权限只发给 publish | upstream-only workflow |
| workflow-guards.test.js | release-prep.yml 的版本号走 env 注入 | upstream-only workflow |
| workflow-guards.test.js | release-prep.yml 与 badge:sync 用同一个记账口径 | upstream-only workflow |
| workflow-guards.test.js | 发版准备清单点出跨 minor 要挪 SECURITY 支持表 | upstream-only workflow |
| workflow-guards.test.js | release-prep.yml 重跑守卫 | upstream-only workflow |
| workflow-guards.test.js | release-prep.yml 开 PR 失败时的可行动报错 | upstream-only workflow |
| pipeline-runner.test.js | P3：给了 memoryDir 时，confirm 把观察旁挂 + 报出 tool 不符 | upstream-only fixture (hardcoded `D:/mem-test`; no writable fixture) |

## 11 sandbox/environment failures

| file | test | category |
|---|---|---|
| capabilities.test.js | 技能扫描：悬空符号链接要报出来 | Windows sandbox cannot create dangling symlink (`ENOENT`) |
| maintenance.test.js | CLI：reclaim 默认 dry-run 报数字，--apply --vacuum 才真收 | `spawn EPERM` |
| maintenance.test.js | CLI：--vacuum 单独用会被拒 | secondary assertion after spawn failure |
| peer-blockers.test.js | peer-C: 多进程并发原子递增 | `spawn EPERM` |
| publish-gate.test.js | 真进程端到端：不存在的版本 | `spawn EPERM` |
| release-notes.test.js | 入口：真进程跑一遍 | `spawn EPERM` |
| release-notes.test.js | 入口：版本不存在时非零退出 | `spawn EPERM` |
| release-notes.test.js | 入口：版本号格式不对时直接拒绝 | `spawn EPERM` |
| serve-bin.test.js | serve bin: 值旗标缺值 | `spawn EPERM` |
| serve-bin.test.js | serve bin: daemon/宿主进程同库 | `spawn EPERM` |
| session-usage.test.js | 目录不可读要与空目录可分辨 | sandbox symlink limitation (`ENOENT`) |

## Timeout / skip

- `mcp-stdio.test.js`: timeout, sandbox forbids piped child stdio.
- 1 test skipped: package/repo-context guard (not a failure).

## Product tests

The following are green and are the meaningful fork gates: `qa-guard`, `backup`, `memory-management-api`, `lifecycle-productization`, `client`, `memory-productization`, `memory-admin-api`, `security-doc`, `release-docs`, `readme-claims`, `test-count-sync`, `standalone-api`, `config`, `tools`, plus runtime/enhancer targeted suites listed in the final productization report.

No upstream workflow was copied. No product assertion was removed or blanket-skipped to claim green.
