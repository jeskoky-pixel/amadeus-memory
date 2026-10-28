# Mneme-lite performance and token cost (2026-10-28)

## Measured environment

Windows, Node 22.23.2, local temporary SQLite database, 50 recent-activity
rows, 1,000 authorized reads. This is a storage/query microbenchmark, not a
DSH Desktop end-to-end timing or a representative production workload.

| Measure | Result |
| --- | ---: |
| Authorized recent-activity read, median | 0.3093 ms |
| Authorized recent-activity read, P95 | 0.3888 ms |
| SQLite file growth after 50 rows | 49,152 bytes |
| Example server preview | 3 summaries, about 81 tokens |
| Live GUI preview after A3 → A1 grant | 1 A3 summary, about 98 tokens |

The default automatic injection is bounded to three recent summaries and a
300-token budget. The GUI permits 100–800 tokens. Disabled recent activity
does not mount its event listener, prompt block or model tool; that is a code
path observation, not a measured latency comparison.

## Costs not yet measured

- Original Mneme versus enhanced Mneme full prompt assembly latency on the
  same DSH host and memory corpus.
- End-to-end time added by recent activity to a real model turn.
- The count and cost of summary LLM calls in a live deployment. The current
  recent-activity path uses deterministic completed-turn summaries and does
  not invoke an LLM per event; other original Mneme jobs remain separate.
- Retrieval quality and latency with a real Embedding provider. The isolated
  Desktop Profile used for this acceptance has no Embedding configuration.

Do not interpret the sub-millisecond SQLite result as a full model-turn
latency, or the token examples as a population average. Re-run an A/B trace
with identical sessions, corpus and Embedding settings before production
deployment.
