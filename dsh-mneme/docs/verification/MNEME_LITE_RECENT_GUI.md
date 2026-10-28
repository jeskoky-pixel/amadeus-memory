# Mneme-lite Cross-Session Recent Activity GUI Verification

Task: `f6376ad9-b44f-4ffa-af09-65de6c4c6d0b`

Scope was limited to the three owned paths:

- `dsh-mneme/lib/client.js`
- `dsh-mneme/test/client-recent.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_RECENT_GUI.md`

No backend/source file, other test, installed package, live DSH profile or
production database was edited. No web search, external agent, child agent,
commit or scope expansion was used. `lib/client.js` is the hand-authored
lib-only Web panel bundle, so no `src` mirror or `npm run sync` was required.

## Placement and preservation

The obsolete "可信 Scene 近期上下文" buffer/clear card is no longer shown for
the new recent-activity state shape. The Memory -> Recent view keeps the
original Session Hot Memory card untouched and mounts the new
`AmadeusRecentActivityCard` below it. The old trusted-buffer card remains only
as a compatibility fallback when GET `/recent` still returns the legacy
`ttl_ms`/`scenes`/`total_events` shape during a rolling backend deploy; it is
not rendered when the new `sessions`/`config`/`stats` contract is present.

The independent Workspace selector card, the Long-term memory card, list,
search, graph, entities, status, settings, Amadeus identity/weight/backup pages,
the full owner explorer, and the Memory -> Recent nesting are all preserved.

## Owner API integration

All reads and writes use the module-level same-origin `adminJson` helper; the
component never calls `fetch` directly and never simulates permissions.

| UI action | Request |
| --- | --- |
| Initial load / refresh | `GET /recent` |
| Save global configuration | `POST /recent/config` with `{enabled, ttl_hours, auto_inject, max_items, max_tokens}` |
| Save one Session policy | `POST /recent/policy` with `{source_session_id, enabled, mode, shared_session_ids}` |
| Preview one target | `GET /recent/preview?target_session_id=<encoded exact ID>&include_self=false` |

The policy request always uses the exact stable Session ID from the server
list. Shared targets are the exact stable IDs of checked other Sessions; titles
are display text only, never authorization evidence. Every successful config or
policy save re-reads `GET /recent` and then refreshes the server preview.

## Summary card

The light summary card shows:

- selected and active Workspace IDs, with "尚未选择工作区" when unbound;
- enabled / configured state and a prominent pending-restart badge and banner;
- participating Sessions over total listed Sessions;
- summary (event) count and saved policy count;
- last update timestamp, approximate summary storage, source distribution;
- the configured injection budget and the latest server preview token estimate.

Pending restart is derived from the API `pending_restart` flag, from an
enabled/configured mismatch, and from a successful POST echo. No platform-
specific switch is introduced.

## Session participation and sharing

- The list comes only from GET `/recent.sessions`, is deduplicated by exact ID,
  and falls back to the stable ID whenever the Host title is null/empty.
- A native search input filters by title or stable ID.
- Clicking a Session row opens a labelled detail card with a native participation
  checkbox and a native three-mode select: `self`, `owner`, `shared`.
- Shared mode renders a bounded checklist of other Sessions. Each checkbox value
  is the exact stable ID. Existing shared IDs that are not in the current list
  are retained and displayed separately. The core limit of 32 targets is
  enforced before submission.
- Owner mode is labelled as server-gated. Because the state contract has no
  trusted-Owner predicate, the UI shows an explicit safe-degradation note unless
  the response explicitly declares an available binding; it never presents
  Owner sharing as already effective.
- Save validates the policy locally, posts the exact body, displays safe status
  or error text, refreshes state, and refreshes the preview.

## Preview

The preview selector chooses one target Session. Changing it immediately
requests the server-filtered DTO; a Refresh button re-requests the current
target. The renderer shows only the safe DTO's summary text, source label and
exact source ID, kind, timestamp, count, estimated Tokens and truncation state.
Denied previews display the server reason through a localized safe-reason map.
No raw transcript, message body, or client-side permission simulation is used.

## Global configuration

The global card provides:

- feature enable/disable;
- TTL 1, 6, 24 or 72 hours;
- auto-inject on/off;
- maximum summaries 1-10;
- Token budget 100-800;
- the fixed deterministic completed-turn summarization strategy description.

Local validation runs before POST and rejects invalid booleans, TTLs, item
counts and Token budgets. Backend error text is displayed only when it matches a
short code/HTTP-status allowlist; path-like or free-form details are suppressed.
`pending_restart` from the POST response or the refreshed state is shown after a
save.

## Styling and accessibility

- Uses existing `mneme-set-card`, `mneme-set-row`, `mneme-set-grouphead`,
  `mneme-set-hint`, `mneme-set-input`, `mneme-btn`, `mneme-badge`,
  `mneme-pending` and `mneme-saved` styles, plus existing semantic theme
  variables and the existing responsive wrap behavior.
- Grouped cards carry `role="group"` and `aria-label`; native wrapping labels
  associate every input, select and checkbox.
- Save success uses `role="status"`; load/save/preview failures and validation
  problems use `role="alert"`.
- All user-facing strings were added to both the Chinese and English
  dictionaries under `memory.am.recentActivity.*`.

## Tests

Commands run from `dsh-mneme/`:

```text
node --check lib/client.js
node test/client-recent.test.js
node test/client.test.js
node test/client-workspace.test.js
node test/contrast.test.js
```

Results:

```text
node --check lib/client.js       pass
client-recent.test.js            12 tests, 12 pass, 0 fail
client.test.js                   93 tests, 93 pass, 0 fail
client-workspace.test.js          7 tests,  7 pass, 0 fail
contrast.test.js                  5 tests,  5 pass, 0 fail
```

`client-recent.test.js` covers:

- bilingual keys, Chinese-first title, Memory -> Recent placement, the new card
  mount, the preserved Hot Memory card and original GUI surfaces;
- owner-only `adminJson` route shapes, exact config/policy bodies, encoded
  preview target with `include_self=false`, and absence of direct fetch/HTML/raw
  transcript rendering;
- nullable Session metadata and stable-ID fallback, deduplication, mode
  defaulting, pending-restart derivation, filtering and timestamp/byte display;
- local config and policy validation, duplicate/self shared-target removal and
  the 32-target bound;
- safe preview normalization, denied-preview suppression and path/secret
  suppression for reason and error text;
- fake-react renderer states for summary, pending, empty, loading, error, denied
  preview, Session list, exact-ID shared checkboxes and preview items;
- policy/config save order: POST, GET `/recent`, then GET preview with the exact
  target;
- invalid drafts never reaching the network.

## Additional observation

`node scripts/check-sync.js` currently reports one pre-existing/concurrent
out-of-scope drift: `lib/recent-activity.js` differs from
`src/recent-activity.js`. This task did not edit either file and did not run
`npm run sync`, because doing so would modify backend files outside the
contract while the recent backend work is still being assembled.

## Limitations

- **Desktop visual acceptance is pending.** No live DSH desktop screenshot or
  manual narrow-window/light/dark walkthrough was performed. Structure,
  behavior, semantic styles and the existing contrast suite are verified only.
- The owner routes are being built independently; tests use the contract-shaped
  fixtures, not live owner data or production stores.
- The legacy trusted-buffer fallback exists only for rollback compatibility; it
  is not the new page and receives no new features.

## Contract check

- [x] New cross-Session recent activity sections replace the obsolete trusted
      buffer/clear card for the new state shape
- [x] Original Hot Memory card, Workspace selector and all original Mneme /
      Amadeus pages remain reachable
- [x] Selected/active Workspace, pending restart, enabled state, participating
      count, summary count, last update, approximate storage and token estimate
      are visible
- [x] Dynamic searchable Session list and exact-ID detail editing
- [x] All three sharing modes; shared mode has an exact-ID bounded checklist;
      Owner mode carries a safe-degradation note
- [x] Server preview selector with source labels, timestamps, token estimate,
      truncation and safe denial reasons; no raw chat
- [x] Global enable, TTL 1/6/24/72, auto-inject, max items and 100-800 Token
      budget with local validation and fixed deterministic strategy copy
- [x] Config/policy saves refresh state and preview; pending restart is shown
- [x] Chinese-first bilingual copy, existing semantic styles and native
      keyboard-accessible labels/controls
- [x] Focused new renderer/static tests pass; existing client, workspace and
      contrast tests pass; syntax is valid
- [x] Desktop visual acceptance is explicitly marked pending
- [x] No backend/src, other tests, installed/production files, commits, web
      search, external agents or child agents were used
