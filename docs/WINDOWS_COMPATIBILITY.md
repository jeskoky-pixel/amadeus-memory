# Windows compatibility probe (explicit non-green)

This is a capability report, not a product test. It never creates a Memory store
or touches a user/QA database.

```powershell
cd dsh-mneme
npm run test:compat-windows
```

Latest local result (Windows, Node v22.23.2):

```json
{
  "ok": false,
  "checks": {
    "platform": "win32",
    "node": "v22.23.2",
    "existingFileSymlink": false,
    "existingFileSymlinkCode": "EPERM",
    "danglingSymlink": false,
    "danglingSymlinkCode": "EPERM",
    "childSpawnWithPipes": true,
    "childSpawnCode": null
  },
  "note": "non-green capability probe; not a product test"
}
```

The command exits non-zero when a capability is unavailable. This explains the
11 full-suite environment failures:

- `capabilities` and `session-usage` need symlink creation; this Windows host
  returns `EPERM`.
- `maintenance`, `peer-blockers`, `publish-gate`, `release-notes` and `serve-bin`
  need child-process/pipe modes that the current test sandbox denies.
- `mcp-stdio` needs piped child stdio and times out.

`childSpawnWithPipes` here is a minimal probe and may succeed while a particular
test's helper/sandbox mode still fails; the per-test inventory records the exact
error. These suites remain non-green and must be rerun on a host with the
required capabilities. No test assertion was weakened or blanket-skipped.
