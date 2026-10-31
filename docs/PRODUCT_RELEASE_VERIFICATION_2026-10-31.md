# Product release verification — 2026-10-31

Status: candidate; not a public release. Final public download/install and npm provenance verification remain pending publication.

- Runtime baseline: official DSH Desktop 0.2.1-rc.3 bundled Host, isolated Profile. Primary DSH and NapCat configuration were not modified.
- Five prebuilt archives installed independently through the official plugin-manager CLI from local HTTP download URLs. Joint upgrade also succeeded. This verifies download installation, not public npm availability or a Market listing.
- Current Memory, QQ and Persona pages loaded in a real Edge Chromium browser with no page errors. Existing Life/State native settings screenshots remain historical evidence.
- Real NapCat group and private inbound markers arrived; installed QQ trusted classification, Scene mapping and Life binding passed.
- Learn retention and Borrow revocation passed against real trusted QQ Session identities with synthetic content in a separate test database. This is Host integration, not a model-generated memory test.
- An outbound-only instance of the installed QQ core and actual DSH Session controller sent one controlled private message through real NapCat HTTP. Same-action deduplication and post-revocation rejection passed. It did not subscribe to inbound events or send to any group. This is not evidence of autonomous model conversation.
- QQ Linux symlink security gate: four passed, zero skipped, run https://github.com/jeskoky-pixel/amadeus-qq/actions/runs/41168808648 . Windows retains the explicit environment skips.
- Main requires CI and disallows force push/deletion. Version tags disallow update/deletion. Publishing remains manual, exact-tag and exact-commit guarded; npm-release environment admission and npm Trusted Publisher account setup are separate controls.
- Local npm authentication returned E401; npm scope authorization and Trusted Publisher configuration are not verified. No package was published, no Release or release tag was created, and no Market PR was submitted.

## Test evidence boundaries

The first README rewrite omitted Memory privacy and model-tool sections. Documentation guards caught this; both sections were restored and the final complete Memory suite passed 782/782. Test assertions were not weakened.

One Host harness rerun reused old Borrow delivery evidence and failed the Learn-retention assertion. Fresh independent test databases separate repeated synthetic scenarios; the original failure log remains local. This does not establish a product defect or a database restart test. Existing restart evidence must be identified separately.

Remaining acceptance includes final artifact lifecycle/recovery, public artifact integrity and installation, npm account/OIDC setup, and any model-led end-to-end scenario not covered by the real transport plus Host tests above. Do not mark these passed from CI alone.
