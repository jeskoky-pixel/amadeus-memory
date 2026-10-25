# Performance and token cost (measured)

All measurements below are synthetic, local, and use an explicit
`dsh-mneme/.test-tmp/measure-*` directory (never `~/.dsh/memory` or a production
database). No remote Embedding or model request is made. Run:

```powershell
cd dsh-mneme
node scripts/measure-productization.mjs
```

Latest run (Windows, Node 22, 500 synthetic memories, 50 iterations where
applicable):

| Metric | Measured |
|---|---|
| SQLite rows seeded | 500 |
| Admin-style list (limit 20) | 0.288 ms/op |
| Keyword search (limit 20) | 0.161 ms/op |
| Consistent backup (`VACUUM INTO`) | 11.403 ms |
| Backup size | 884,736 bytes |
| Backup preflight (`quick_check` + SHA-256) | 2.154 ms |
| Injection render | 4.308 ms/turn |
| Injected memory block | 1,170 chars |

The injection token estimate is **≈293 tokens/turn** using the conservative
`chars / 4` approximation. This is not a model tokenizer measurement; actual
token counts depend on the host tokenizer, language, and the configured
`maxInjectedItems` / `injectContentMaxChars` / pinned entries. The 1,170-char
sample includes the injected titles/truncated bodies and the user-settings block;
hot memory was disabled for a stable measurement.

These numbers characterize local overhead only. Remote Embedding latency,
model consolidation cost, and semantic quality are deployment-time evaluations
and are not claimed as measured here.
