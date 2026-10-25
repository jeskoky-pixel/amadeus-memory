# Amadeus Memory development

This repository contains a forked Mneme package in `dsh-mneme/`. Source is in
`dsh-mneme/src/`; `dsh-mneme/lib/` is synchronized output. Run `npm run sync`
from the package directory after changing source, then run relevant tests.

Preserve Mneme's existing store, memory importance, autoDream, Sleep, archive,
forgetting, scope and retrieval behavior when enhancement switches are off.
Database changes must be additive, idempotent, auditable and safe for existing
libraries. Never run migration experiments or entity merges on production data.

New routes need explicit API policy and tests. New opt-in feature flags belong
in both `src/config.js` and `src/settings.js`. Keep the panel's semantic color
variables for both themes. Do not edit the installed package or the live DSH
profile. Keep secrets, real memory data and local paths out of commits.

The original upstream AGENTS.md and contribution rules were reviewed before
import. The upstream source commit and license are recorded in `UPSTREAM.md`.
Do not add AI authorship or co-author trailers to commits.
