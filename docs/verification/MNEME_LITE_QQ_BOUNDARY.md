# Mneme-lite QQ Long-Term Memory Boundary Verification

Task: `d809a7ad-f04a-4a7f-b065-2170e1a53fdc`
Branch: `codex/memory-mneme-lite`

Changed paths:

- `dsh-mneme/src/qq-model-boundary.js` (new central boundary)
- `dsh-mneme/src/index.js` (wraps the existing Workspace guard)
- `dsh-mneme/lib/qq-model-boundary.js`, `dsh-mneme/lib/index.js` (sync output)
- `dsh-mneme/test/qq-model-boundary.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_QQ_BOUNDARY.md`

No retrieval algorithm, store schema, Hot Memory core, config flag, GUI, package
metadata, production database or installed profile was changed.

## Safety downgrade

Workspace membership is no longer sufficient model authorization when the Session
may be a QQ group/private Session. `index.js` now builds the single
`authorizeModelWork` closure from `createQQModelAccessGate(...)`, which first asks
the in-process QQ Host about the trusted Session ID and then delegates to the
existing `createWorkspaceAccessGuard` closure. The same closure already gates the
injector, all model tools, `autoSummarize`, recent activity, continuity rescue,
action nudges and the M/O event recorder.

At every execution:

1. A verified Host QQ Scene (`platform: "qq"`, `verified: true`, valid kind/id)
   requires `sceneIsolationEnabled === true && sceneStrictQQ === true`. In
   default or partially enabled Scene modes it is denied, even with a valid
   Workspace membership. A positive Host binding is authoritative over a
   `standard` preset.
2. Known `amadeus-qq*` presets without a valid Host binding are always denied,
   regardless of Scene settings.
3. If a QQ Host is installed but the Host throws or resolves no QQ Scene, an
   unknown/custom preset is denied. The five known ordinary DSH presets
   (`standard`, `minimal`, `creator`, `creative`, `default`) keep their normal
   Workspace-gated path.
4. Unknown provenance is also denied in strict Scene mode even before a Host is
   installed.
5. Only the trusted `session.id` and frozen `session.header.agentPreset` are
   read. Tool arguments, titles, request fields and caller JSON are never used.

## Deliberate custom-preset limitation

An unknown/custom preset with **no QQ Host installed and Scene isolation off** keeps
the original legacy path so custom non-QQ DSH Sessions are not broken. Once a QQ
Host is installed but cannot bind that Session, the same custom preset fails
closed; this is the cost of covering renamed QQ Presets without trusting titles or
caller-supplied metadata. Operators using a custom non-QQ preset alongside a QQ
Host must add it to the known ordinary preset list in a reviewed change.

## Tests

Focused commands from `dsh-mneme/`:

```text
node test/qq-model-boundary.test.js          # 10 pass
node test/workspace-runtime.test.js          # 13 pass
node test/workspace-hooks.test.js            # 17 pass
node test/recent-runtime.test.js             # 11 pass
node test/qq-host-inject.test.js             # 4 pass
node test/summarize-scene-contract.test.js   # 10 pass
node test/summarize-scene-gate.test.js       # 1 pass
node test/scene-acl-tools.test.js            # 16 pass
node test/tools.test.js                      # 32 pass
node test/inject.test.js                     # 30 pass
node test/lite-runtime-convergence.test.js   # 5 pass
node scripts/check-sync.js                   # src/lib identical, 91 files
```

`test/qq-model-boundary.test.js` proves: known QQ preset without a Host denied in
default mode; Host-verified QQ denied in default and both partially enabled Scene
modes; allowed only in strict Scene mode with valid Workspace membership; positive
Host binding overrides a `standard` preset; custom preset with a failing Host
denied; ordinary DSH presets allowed with a QQ Host installed; wrong/moved
Workspace denied; title/caller JSON ignored; and an integration assertion that the
injector, model tools and `autoSummarize` all receive the same denial.

## Contract check

- [x] QQ model access fails closed unless strict Scene mode and a trusted Host
      binding are both present
- [x] Known `amadeus-qq*` presets without a Host fail closed in every mode
- [x] Ordinary standard DSH Sessions retain Workspace-gated Mneme access
- [x] Central gate wraps the existing Workspace guard for injector, tools,
      autoSummarize and event-derived writers
- [x] Focused regression tests pass and `src/`/`lib/` are synchronized
- [x] No web search, external agents, child agents, commits or scope expansion
