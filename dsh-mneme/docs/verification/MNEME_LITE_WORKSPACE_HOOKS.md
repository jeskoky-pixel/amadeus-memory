# Mneme-lite Workspace Hooks Verification

Task: `0267dcd3-e081-4fdd-8b2f-198a87109411`
Branch: `codex/memory-mneme-lite`

Scope was limited to the task's owned paths:

- `dsh-mneme/src/continuity.js`
- `dsh-mneme/src/pipeline-nudge-auto.js`
- `dsh-mneme/src/pipeline-command.js`
- `dsh-mneme/src/inject.js`
- `dsh-mneme/src/index.js`
- `dsh-mneme/test/workspace-hooks.test.js`
- `dsh-mneme/test/continuity.test.js` (updated the stale index wiring assertion)
- `dsh-mneme/docs/verification/MNEME_LITE_WORKSPACE_HOOKS.md`
- corresponding synced `dsh-mneme/lib/*` copies

No web search, child agents, commits, installed packages, live DSH profile, database
migration, or entity merge was used. Core Dream/Sleep/autoSummarize design was not
changed.

## Completion contract

All four remaining model/event paths now fail closed on the actual Host Session:

1. `createContinuityRescue(ctx, store, authorizeModelWork?)` checks the Session on
   the compaction event and again after `agent/pre-step`'s `await next()`, before
   `snapshotEvents` is read, a proposal is saved, or a notice is appended. A moved
   Session or binding change drops the queued edge instead of holding it.
2. `createNudgeAutoRun({ ..., authorizeModelWork? })` authorizes a `turn/end`
   before retaining a project root or scheduling work, and rechecks the actual
   Session inside the deferred job. Denial removes the pending job without calling
   `projectRootOf` or `runNudge`, so no other Workspace is scanned or proposed.
3. `/mo-run` rejects every non-help action before opening, stopping, confirming or
   reading recorder state. The subject is always the trusted
   `invocation.agent.session`, never the parsed command text. `index.js` supplies
   the runtime guard to the command registration.
4. The original `systemPrompt.section` guidance is now rendered through a section
   text provider gated by the same callback as the memory/user-settings contexts.
   The section is not emitted to an unauthorized or moved Session.

All callbacks remain optional. Direct module tests that omit them keep the legacy
behavior; the mounted runtime always supplies the guard.

## Host section text contract

Verified against the installed host packages before changing `inject.js`:

- `@deepseek-ai/dsh-system-prompt@0.2.0-rc.1` declares
  `PromptSection.text: string | ((context: AssembleContext) => string)` and
  `SystemPrompt.assemble()` evaluates a function provider for every assembly.
  The contract is not static-only.
- `@deepseek-ai/dsh-agent` builds the assembly context with
  `assembleContextFor(agent, signal)`, returning
  `{ agent, scope: agent, signal? }`. The actual Session is therefore available at
  `context.agent.session` when the section provider runs.

The guide provider is:

```js
text: (assembleCtx) => renderAuthorized(assembleCtx, () => MEMORY_GUIDE_SECTION)
```

Consequences:

- Selected mode: the guide is rendered only for a Session the runtime guard
  authorizes; a moved Session or binding change suppresses it immediately.
- Unbound mode: every Session is denied, so the registered section renders empty.
  No separate "suppress registration in unbound mode" fallback was needed.
- A host that supplied an assembly context without `agent` would suppress the guide
  (fail closed) rather than leak it. The installed host supplies `agent`.
- With no callback (direct module tests), the provider returns the original static
  `MEMORY_GUIDE_SECTION` unchanged.

## Index-mounted hook inventory

| Hook | Location | Gated? | Notes |
| --- | --- | --- | --- |
| `session/event` compaction edges | `src/continuity.js` | Yes | Authorizes the event's Session; denial drops any queued edge and never saves a proposal. |
| `agent/pre-step` continuity rescue | `src/continuity.js` | Yes | Rechecks after `await next()` and before transcript read/proposal/notice; denial drops the edge. |
| `session/event` auto-nudge | `src/pipeline-nudge-auto.js` | Yes | Rejects unauthorized `turn/end` before queueing; the deferred flush rechecks the retained actual Session before scanning. |
| `session/event` execution recorder | `src/pipeline-runner.js` (wired in `src/index.js`) | Yes, via index wrapper | The wrapper gates `ctx.on("session/event")`; only authorized Session events reach the recorder's existing open-window buffer. `/mo-run start/stop/confirm/status` are separately gated before recorder calls. |
| `session/event` autoSummarize | `src/summarize.js` | Yes (prior milestone) | Already checks before LLM work and again before the summary transaction; unchanged here. |
| `systemPrompt.context` memory block | `src/inject.js` | Yes (prior milestone) | Uses `renderAuthorized`; unchanged except keeping the same callback. |
| `systemPrompt.context` user-settings block | `src/inject.js` | Yes (prior milestone) | Uses `renderAuthorized`; unchanged. |
| `systemPrompt.section` memory guide | `src/inject.js` | Yes (this task) | Provider receives the per-assembly `agent`; same callback as the contexts. |
| `session/event` panel preset observability | `src/api.js` | No, read-only | Reads only `session.header.agentPreset` for a panel display string. No memory read, write, proposal, LLM call, or authorization decision. |
| Dream/Sleep schedulers | `src/dream.js`, `src/dream/sleep.js` | Not session/event hooks | Timer-driven and mounted only when a selected Workspace exists; unchanged. |

The only remaining ungated `session/event` consumer is the API observability read
above; it has no memory data path. No new model or HTTP bypass was introduced.

## Scope and lifecycle details

- The authorization closure is created once at mount, before any event hook is
  wired, from the trusted Workspace Registry binding. It re-reads the binding on
  every call, so a binding switch denies the old runtime immediately and latches
  until remount.
- Continuity stores only `sessionId -> edgeSeq`; it still does not retain Session
  objects. Authorization uses the Session supplied by the host at each boundary.
- Nudge retains the triggering Session only until the deferred job runs (one
  macrotask), solely to re-authorize; the entry is removed before any scan.
- A denied continuity edge is deleted. Moving a Session back does not revive a
  rescue moment that was never authorized when the step ran.
- Help (`/mo-run` with no recognized action) is allowed and touches no recorder
  state; all non-help actions are denied before recorder access.
- `runNow(projectRoot, session?)` fails closed when a runtime authorization
  callback is supplied but no trusted Session is passed. Existing direct tests
  without a callback are unchanged.
- The recorder/command block previously pushed to `disposers` before its
  declaration; the full-boot test with `actionRunEnabled: true` exposed a
  `ReferenceError: Cannot access 'disposers' before initialization`. The array is
  now declared before any registration. This path was previously broken whenever
  the opt-in flag was enabled; the default-off behavior is unchanged.

## Tests

Commands (from `dsh-mneme/`):

```text
node test/workspace-hooks.test.js
node test/continuity.test.js
node test/pipeline-nudge-auto.test.js
node test/pipeline-command.test.js
node test/inject-parent-gate.test.js
node test/inject.test.js
node test/workspace-runtime.test.js
node test/lib-smoke.test.js
```

Results:

```text
workspace-hooks.test.js       17 tests, 17 pass, 0 fail
continuity.test.js            17 tests, 17 pass, 0 fail
pipeline-nudge-auto.test.js    9 tests,  9 pass, 0 fail
pipeline-command.test.js      18 tests, 18 pass, 0 fail
inject-parent-gate.test.js     5 tests,  5 pass, 0 fail
inject.test.js                30 tests, 30 pass, 0 fail
workspace-runtime.test.js     13 tests, 13 pass, 0 fail
lib-smoke.test.js              6 tests,  6 pass, 0 fail
```

The new suite covers, per path:

- unauthorized Session (not in the selected Workspace)
- Session moved out after an edge/job/command was accepted
- binding switched to another Workspace
- authorized regression
- continuity: no transcript read or proposal on denial; stale edge dropped
- nudge: no queue on unauthorized `turn/end`; deferred recheck blocks the scan
- commands: start/stop/confirm/status all denied before recorder calls; help and
  the trusted-session source are covered
- guidance section: unauthorized/moved/binding-switched render empty; authorized
  render is the original text; no-callback legacy behavior is unchanged
- full plugin boot with `actionRunEnabled`, `actionNudgeEnabled`,
  `continuityRescueEnabled` and guidance enabled: command registration, command
  denial/authorization and the guide provider all wire correctly (and the
  pre-existing `disposers` TDZ no longer fires)

## Source/lib parity

From `dsh-mneme/`:

```text
npm run sync
node scripts/check-sync.js
✓ src/ 与 lib/ 一致（90 个文件）
```

## Contract check

- [x] Continuity checks the actual Host Session on the compaction event and again
      after `next()`, before transcript read, proposal save, or notice injection
- [x] Continuity stops immediately for a moved Session or binding change and does
      not hold a stale edge
- [x] Nudge rejects unauthorized `turn/end` before queueing and rechecks in the
      deferred job; no scan/save for another Workspace
- [x] `/mo-run` denies non-help actions before recorder access; uses
      `invocation.agent.session`, not parsed text; index supplies the guard
- [x] Original guidance section does not render to an unauthorized Session;
      host section text contract verified before changing it
- [x] Remaining index-mounted session/event and agent/pre-step hooks inspected and
      documented (one read-only API observability hook remains ungated by design)
- [x] Focused tests pass, `npm run sync` ran, and `src/`/`lib/` are identical
- [x] No web search, external agents, child agents, commit, or scope expansion
