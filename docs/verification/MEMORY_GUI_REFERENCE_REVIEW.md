# Amadeus Memory GUI reference review (2026-10-27)

This review inspected source code from DSH memory plugins on GitHub. It informs
the Amadeus UI; no code or assets were copied. The references were cloned only
into the ignored private development area, not the release package.

| Reference (commit) | Inspected UI | Useful pattern | Limit for Amadeus |
| --- | --- | --- | --- |
| [Mneme](https://github.com/slow-stack/mneme) installed 0.9.4 | `lib/client.js` Memory Explorer | Long-term list, graph, status and configuration have separate views; advanced controls are nested. | Its ordinary graph and identity routes cannot be reused under strict QQ Scene isolation. |
| [Cairn](https://github.com/chenhw7/dsh-memory/tree/401a72951a56d90dc38135f57a9439724dd98f72) | `src/client/MemorySection.tsx`, `MemoryPluginCard.tsx` | Overview, review queue and management are separate jobs; scope filters, health cards and explicit empty states help orientation. | Amadeus has no equivalent review queue, so an empty Review tab would mislead. |
| [Noema](https://github.com/ZSeven-W/dsh-noema/tree/07d2fece531d11dbd5c420c5d44eaea12e6a9d7a) | `src/client/index.tsx` | Memory operations, pending decisions and live server status are independently visible; read-only/writable state is explicit. | Its file-backed MCP lifecycle differs from Mneme's SQLite and Embedding lifecycle. |
| [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory/tree/7e53a81af5fb3b6671ef29e89b8f4b251f89f930) | `src/client.ts`, `src/settings-page.ts` | Short-term injected content and background dream turns use compact expandable disclosure; settings use grouped fields and show write capability. | The plugin modifies chat DOM; Amadeus should retain native host slots and avoid exposing cross-Scene contents. |
| [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve/tree/e6f6b84c56f0fc18ba4a6a1a5959fbf86ea9ec8b) | `src/client/MemoryTabView.tsx`, `MemoryQueueView.tsx` | Memory tracks and pending work have nested views and badges; selection survives host remounts per session. | File tracks and suggestion workflows do not map directly to Amadeus's typed records. |
| [Obsidian Memory](https://github.com/detongz/dsh-client-ui-obsidian-memory/tree/7e672618cdc7907092b3d020f08506a7fe5f7e18) | `src/client/ObsidianMemoryPanel.tsx` | A breadcrumb and folder tree make current location explicit; quick actions stay near the content. | A folder tree is not a suitable model for Scene-isolated entity evidence. |
| [Mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `src/client/use-workspace-navigation.ts`, `StatusPage.tsx`, UI guide | Runtime, long-term spaces, component health and configuration have distinct navigation levels. | Its composed view system is not Mneme's store or authorization model. |

## Applied design judgment

- Keep the existing **Memory / Entities / Status / Settings** top level. Keep
  **Long-term / Recent** under Memory and **General / Retrieval / Scene / Backup**
  under Settings. This follows the job separation in Cairn and Mnemon without
  adding duplicate first-level entries.
- Keep Session hot memory and trusted-Scene Recent Context separate. The former
  cannot be listed through the owner API; the latter may show counts, not raw
  cross-Scene text. Do not present a fake timeline.
- Improve the Scene entity graph as a browsing tool: current fixed first-12
  diagram can omit a node selected from the complete list. A selected-node
  neighborhood with search and visible focus would make large graphs usable
  while keeping one explicit Scene selector and all evidence limits.
- Preserve the user's place when the host remounts the settings section, as
  dsh-memory-evolve does for its session tab, without persisting private graph
  data in browser storage.
- Keep status, editability, empty and error states explicit. Do not add a
  Review queue or copy external code solely to resemble another plugin.

The references are design evidence, not performance or security evidence.
Final acceptance still requires the isolated DSH Desktop with real host slots.
