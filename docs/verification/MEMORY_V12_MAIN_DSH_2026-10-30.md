# Amadeus Memory v1.2.0 — main DSH acceptance, 2026-10-30

The candidate package was installed in the user's official DSH Desktop
0.2.1-rc.3 profile alongside QQ, Life, State, and Persona. The Memory data root
was explicitly redirected to a new isolated directory before Desktop startup;
the existing user memory directory was not used. The owner selected the same
trusted DSH Workspace as QQ. `sceneIsolationEnabled` and `sceneStrictQQ` were
both enabled. After a hard Desktop restart, the Workspace binding was active,
the isolated SQLite database passed `quick_check`, and the QQ Host connection
and two authorized Scene Session IDs survived unchanged.

## Real model regression and fix

A standard DSH Session called `memory_save` to store a synthetic project fact.
The tool returned a created ID, but `memory_get`, `memory_search`, and
`memory_list` in that same Session returned no row. Read-only SQLite inspection
confirmed that the row had been committed to the selected Workspace database
with `scene_scope = NULL`; this was a read-policy defect, not lost data.

In strict QQ mode, the shared Scene filter and SQL candidate filter treated an
ordinary DSH Session with no QQ Scene as having no readable scopes. The
`memory_get` tool also rejected its unscoped row. The fix permits an authorized
ordinary DSH Session to read and update unscoped memories while keeping every
QQ-tagged row inaccessible without the matching trusted Host Scene. Known QQ
and custom unverified QQ Presets still fail closed. Owner QQ Scenes may read
legacy rows but may not mutate them through model tools.

After installing the rebuilt candidate package and restarting Desktop, the
same DSH Session called `memory_get` and `memory_search` for the original ID.
Both returned the previously saved fact with its original timestamp. No second
write was needed. The model was instructed not to send QQ messages, and none
were sent in this Memory test.

## Checks and limits

- Focused Scene, Host boundary, and summarizer tests: 37/37 passed.
- Amadeus product gate: 718/718 passed after the fix.
- `src/` and `lib/` synchronized; package audit passed with 281 files; package
  privacy scan found no credentials, database, logs, or temporary artifacts.
- The live test proves standard DSH model tool write and read, SQLite
  persistence across restart, and unchanged QQ Session binding. It does not
  prove a live QQ inbound model turn, Life autonomous external delivery, or
  public Market installation.
