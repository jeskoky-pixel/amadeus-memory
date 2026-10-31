# Security Policy

This policy covers the Amadeus Memory enhanced bundle in this repository
(`dsh-mneme/`, package `@amadeus/memory`). The upstream import and license
are recorded in [UPSTREAM.md](UPSTREAM.md); installation and rollback are in
[INSTALL.md](docs/INSTALL.md).

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.2.x | Current Amadeus Memory candidate line |
| < 1.2 | Historical line; upgrade before reporting an issue |

## 支持版本

| Version | Supported |
| --- | --- |
| 1.2.x | 当前 Amadeus Memory 候选线 |
| < 1.2 | 历史版本；报告问题前请先升级 |

## Reporting a Vulnerability / 报告漏洞

Do not open a public issue for an unpatched vulnerability. Report it privately
to the repository owner, include the affected package version, a minimal
reproduction, and whether memory text, credentials, or the local SQLite file
were exposed. Do not attach a real memory database or API key. The owner will
acknowledge the report and coordinate a fix and disclosure.

For repository security design and the API route policy table, see
[docs/AMADEUS_MEMORY_ENHANCER.md](docs/AMADEUS_MEMORY_ENHANCER.md)
and [LICENSE](LICENSE). The Memory host API is owner-authenticated; remote
Embedding and host-model consolidation are described in the README privacy
sections.

## Open reads (API route policy)

- **Open reads:** `/`, `/info`, `/version-check`, `/list`, `/recall-stats`, `/search`, `/profile`, `/persona`, `/llm-providers`, `/semantic`, `/semantic/llm-audit`, `/semantic/llm-audit/stats`, `/semantic/graph/ego`, `/semantic/graph/entity-attrs`, `/entities`, `/memories/entities`, `/dream-status`, `/inject-status`, `/inject-preview`, `/pipeline`, `/candidates`, `/rules`, `/mode`, `/features`, `/commands`, `/nudge`
- **开放读:** `/`, `/info`, `/version-check`, `/list`, `/recall-stats`, `/search`, `/profile`, `/persona`, `/llm-providers`, `/semantic`, `/semantic/llm-audit`, `/semantic/llm-audit/stats`, `/semantic/graph/ego`, `/semantic/graph/entity-attrs`, `/entities`, `/memories/entities`, `/dream-status`, `/inject-status`, `/inject-preview`, `/pipeline`, `/candidates`, `/rules`, `/mode`, `/features`, `/commands`, `/nudge`

The `profile`, `persona`, `rules`, `mode`, `features`, `commands` and `nudge`
entries are token-write routes: reads are open, writes require the configured
token. They are listed here because this section documents read exposure.

When strict QQ Scene isolation is active, or Scene-scoped rows exist, these
ordinary routes are denied by default. The original Mneme library can call an
exact route only when the request is same-origin and the DSH Host authenticates
its principal as Owner. The configured `apiToken`, a forged header, or a QQ
Scene alone never grants this exception; prefix fallback routes remain denied.
This Owner GUI exception does not change model-tool Scene authorization.

严格 QQ Scene 隔离启用或库中存在场景记忆时，普通接口默认拒绝。原 Mneme 记忆库
仅在同源请求经 DSH Host 验证为 Owner 后，才能访问明确注册的接口。`apiToken`、
伪造请求头或 QQ Scene 本身都不能获得这项权限；前缀兜底接口仍拒绝。模型工具的
Scene 授权不因此改变。

## Gated routes

- **Gated routes:** `/profile`, `/profile/extract`, `/persona`, `/test-model`, `/delete`, `/update`, `/create`, `/maintenance/reclaim`, `/rules`, `/vector-config`, `/vector-reindex`, `/runtime/provision`, `/identity/aliases`, `/identity/external-ids`, `/identity/candidates`, `/identity/merge-preview`, `/identity/merge`, `/identity/merge-undo`, `/identity/links`, `/identity/history`, `/identity/entity-detail`, `/identity/pending`, `/preferences`, `/intake`, `/intake/provenance`, `/export`, `/import`, `/conflicts`, `/conflicts/resolve`, `/health`, `/mode`, `/external-api`, `/features`, `/commands`, `/nudge`
- **受门控的路由:** `/profile`, `/profile/extract`, `/persona`, `/test-model`, `/delete`, `/update`, `/create`, `/maintenance/reclaim`, `/rules`, `/vector-config`, `/vector-reindex`, `/runtime/provision`, `/identity/aliases`, `/identity/external-ids`, `/identity/candidates`, `/identity/merge-preview`, `/identity/merge`, `/identity/merge-undo`, `/identity/links`, `/identity/history`, `/identity/entity-detail`, `/identity/pending`, `/preferences`, `/intake`, `/intake/provenance`, `/export`, `/import`, `/conflicts`, `/conflicts/resolve`, `/health`, `/mode`, `/external-api`, `/features`, `/commands`, `/nudge`

The standalone API must be bound to loopback, use a distinct token, and remain
disabled when not needed. The native settings admin API is same-origin and
owner-only. No route returns a plaintext API key or memory body in the overview
payload.
