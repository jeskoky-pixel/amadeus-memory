# Memory QA memoryDir guard

This guard is for **QA, smoke, install verification and package scripts**. It is
not imported by the production Memory `apply()` path: existing end-user
configurations may still point at the historical `~/.dsh/memory`.

## Why

An isolated `DSH_HOME` does not by itself change a plugin's explicit `memoryDir`.
A QA Profile can therefore write to a real user database. The guard requires an
explicit QA root and an explicit child `memoryDir`, then resolves the canonical
identity before a store is created.

## CLI

```powershell
cd dsh-mneme
node scripts/qa-guard.mjs --qa-root "C:\qa\amadeus-memory" --memory-dir "C:\qa\amadeus-memory\profile-a\memory"
```

Exit 0 prints the canonical path. Any other result exits non-zero with
`QA_ROOT_REQUIRED`, `QA_PATH_IS_USER_MEMORY`, `QA_PATH_OUTSIDE_ROOT`,
`QA_PATH_NOT_DIRECTORY` or `QA_PATH_IDENTITY_UNRESOLVED`.

`--forbid <absolute-path>` adds a private/user directory to the rejected set for
one invocation. The local QA orchestrator must pass its actual production root;
it is not stored in this public package.

The privacy gate also accepts `AMADEUS_PRIVATE_PATHS` (semicolon/newline
separated) and scans the packed tarball/source for those roots, local username
paths, session IDs and credential patterns.

## API

```js
import { assertIsolatedMemoryDir } from "./src/qa-guard.js";
const memoryDir = assertIsolatedMemoryDir(target, { qaRoot, forbiddenDirs: [] });
// Create the store/plugin only after this line.
```

## Rejected identity

Default/user Memory path derived from `homedir()`:

- `~/.dsh/memory` (and any child of it)

Additional production/private roots are caller-supplied:

- pass `--forbid <absolute-path>` to the CLI, or
- pass `forbiddenDirs: [...]` to `assertIsolatedMemoryDir`.

The guard does not hardcode a machine username or private QA path.

It also rejects:

- a `memoryDir` equal to the QA root;
- traversal or a different volume escaping the QA root;
- a symlink/junction alias whose canonical target is a forbidden path or outside the root;
- a path whose existing ancestor/file identity cannot be resolved (fail closed).

Windows comparisons are case-insensitive and use `realpathSync.native` for
symlink/junction resolution. The target is created only after the lexical and
canonical-parent checks, so a rejected user path is not even created.

## Product tests

`test/qa-guard.test.js` covers:

- allowed nested isolated directory (and Windows case alias);
- default `~/.dsh/memory` derivation assertion;
- synthetic private-root rejection (no real user path is passed to the guard);
- traversal, missing QA root, non-directory target;
- junction/symlink alias to a custom forbidden directory (rejected before writing through it).

`backup.test.js`, `memory-management-api.test.js`,
`lifecycle-productization.test.js` and `scripts/measure-productization.mjs`
call the guard before creating a store; the quality runner cleans `.test-tmp`
before/after the suite.
