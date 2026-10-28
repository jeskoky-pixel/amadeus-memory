# Mneme-lite Workspace GUI Verification

Task: `8104d7b1-f3fb-430d-8cbe-e973e91f5a21`

Scope was limited to the three owned paths:

- `dsh-mneme/lib/client.js`
- `dsh-mneme/test/client-workspace.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_WORKSPACE_GUI.md`

No backend/source file, other test, installed package, live DSH profile or
production database was edited. No web search, external agent, child agent,
commit or scope expansion was used. `lib/client.js` is the hand-authored
lib-only GUI bundle, so no `src` mirror or `npm run sync` was required.

## GUI behavior

The existing Amadeus Memory settings page now mounts an `AmadeusWorkspaceCard`
at the top of the Memory view, immediately before the Long-term / Recent
sub-tabs. It is only rendered for the non-`settingsOnly` native page; the
nested owner explorer keeps its existing settings-only hierarchy. The original
top tabs, Long-term card, Recent/Hot Memory panel, Entities, Status and
Settings pages were not changed.

The card is a self-contained owner control:

- `GET /api/amadeus-memory/admin/workspace` is loaded through the shared
  module-level `adminJson("/workspace")` helper on mount (the helper supplies
  same-origin credentials and the owner request marker).
- A native single `<select>` is wrapped in a real `<label>`. Its options are
  built only from `data.workspaces`, use the Registry `id` as the submitted
  value, and display the Registry title plus Session count. There is no
  free-text ID field and no `multiple` attribute.
- A selected-status row shows the persisted selected Workspace title and
  Session count, or the exact Chinese "尚未选择工作区" / English "No Workspace
  selected yet" first-install state. A separate active-status row shows the
  runtime-active Workspace, so a pending selection is never presented as
  active.
- Save is disabled while the Registry is unavailable, while the list is empty,
  while the draft is not an exact Registry ID, and for a same-ID no-op.
- The unavailable-Registry state shows a stable reason code only when it passes
  a strict safe-reason whitelist; path-like or free-form values (drive paths,
  POSIX paths, `token=...`, objects) are suppressed. The card never renders a
  database or control-root path.

## Confirmation and save flow

The first Save click does not call the network. It opens a visible confirmation
block that states:

1. the old Workspace stops serving model memory immediately;
2. the old Workspace data is retained, not deleted, merged or migrated;
3. a plugin restart/reload is required before the new Workspace activates.

Only the confirmation action calls `save()`, which POSTs through `adminJson`
with the exact draft ID:

```json
{ "workspace_id": "<exact Registry id>", "confirm": true }
```

Both the first action and the confirmed action re-check `view.canSave`, so a
same-ID or invalid selection can never reach POST. After a successful POST the
card renders the POST response, then refreshes through a second
`GET /workspace`; the persisted selected state is re-read from that GET. The
pending state is driven by `pending_remount`, `restart_required`, or a
selected/active mismatch, and is shown with the existing `mneme-pending`
warning block and `mneme-badge--pending` badge. The client never writes
`active_workspace_id`, never claims restart is unnecessary, and keeps all other
owner configuration pages usable.

## Styling and accessibility

- Existing semantic styles are reused: `mneme-set-card`, `mneme-set-row`,
  `mneme-set-input`, `mneme-btn`, `mneme-badge--pending`,
  `mneme-pending`, `mneme-maintwarn` and the existing theme variables.
  No new color variables or hard-coded theme colors were introduced.
- The native select is keyboard operable and associated through a wrapping
  label. The confirmation block is a labelled `group` with real buttons.
  Pending and save notices use `role="status"`; save/load failures use
  `role="alert"`.
- The card uses a wrapping action row and the existing 560px media rule for
  narrow settings windows. It inherits light/dark theme colors from the
  existing semantic variables.
- All user-facing strings were added to both the Chinese and English
  dictionaries under `memory.am.workspace.*` (31 keys).

## Tests

Commands run from `dsh-mneme/` (file-by-file; this sandbox blocks the Node test
runner's child-process spawn):

```text
node --check lib/client.js
node test/client-workspace.test.js
node test/client.test.js
node test/contrast.test.js
node test/lib-smoke.test.js
node scripts/check-sync.js
```

Results:

```text
node --check lib/client.js       pass
client-workspace.test.js         7 tests,  7 pass, 0 fail
client.test.js                  93 tests, 93 pass, 0 fail
contrast.test.js                 5 tests,  5 pass, 0 fail
lib-smoke.test.js                6 tests,  6 pass, 0 fail
check-sync                       ✓ src/ 与 lib/ 一致（90 个文件）
```

`client-workspace.test.js` covers:

- bilingual key presence and the exact first-install Chinese copy;
- card placement at the top of the Memory/Recent view and a native labelled
  single-select with no free-text or multi-select control;
- the exact GET/POST route shape through `adminJson` and `confirm: true`;
- first-install selection, same-ID no-op, invalid-ID rejection, unavailable and
  malformed Registry, safe reason suppression of paths/secrets, Session count
  and selected/active titles;
- pending-restart rendering from the API flag and from a selected/active
  mismatch, including the promise that the new Workspace is not claimed active;
- a fake-react renderer path for no-binding, missing-Registry, invalid-ID,
  pending and confirmation states;
- the Save click opening confirmation without POSTing, and the confirmed
  action exposing the three required consequences plus Cancel;
- preservation of the original Hot Memory/Recent panel and its single
  `clearRecent` action.

## Limitations

- **Desktop visual acceptance is pending.** No live DSH desktop screenshot or
  manual narrow-window/light/dark walkthrough was performed in this task. The
  report verifies structure, behavior and existing theme/contrast tests only.
- No automatic remount exists. The GUI honestly shows pending restart and
  requires a host plugin restart/reload, matching the owner API.
- Tests use fixture Registry data, not live owner data or production memory
  stores.

## Contract check

- [x] Added a clear single-Workspace card at the top of the current
      Memory/Recent view without removing or renaming existing pages/cards
- [x] Registry list is populated from the owner GET; display title, Session
      count, selected and active status are visible; no free-text ID or
      multi-select control
- [x] First install with no binding shows the exact "尚未选择工作区" copy and
      permits a GUI selection
- [x] Save is disabled for an unavailable Registry and invalid/same-ID
      selections; reasons are shown without paths or secrets
- [x] A visible confirmation describes immediate old-Workspace stop, retained
      data and plugin restart; POST is only reachable after confirmation
- [x] Same-ID selection is a no-op; after save the card refreshes through GET
      and shows a prominent pending-restart state without claiming the new
      Workspace is active
- [x] Chinese and English strings added; existing card/button/badge styles and
      semantic theme variables only
- [x] Keyboard-accessible label and native select; wrapping/narrow layout uses
      existing responsive and theme behavior
- [x] Original Hot Memory behavior and the old Recent panel are untouched
- [x] Focused new tests and the relevant existing client test pass; client
      syntax is valid
- [x] Desktop visual acceptance is explicitly marked pending
- [x] No backend/src, other tests, installed/production files, commits, web
      search, external agents or child agents were used
