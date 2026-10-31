# Publishing @fg-lab/amadeus-memory 1.3.0

Publication is an explicit operation after release acceptance, not a side effect of a main-branch push. The `npm-publish.yml` workflow is manual and only accepts a version tag whose commit is contained in main. It uses GitHub OIDC (`id-token: write`) and npm provenance, not a repository npm token.

## Account setup

The npm package must exist and the maintainer must have publication rights in `@fg-lab`. Configure npm Trusted Publishing for owner `jeskoky-pixel`, repository `amadeus-memory`, workflow file `npm-publish.yml`, environment `npm-release`. Never put an npm token or recovery code in an issue, commit or screenshot. Initial package creation may require an authenticated, 2FA-approved publish; OIDC configuration is not assumed to exist before the package does.

## Release gates

1. Review the final commit, tests, prebuilt assets, license, package inventory and sensitive-file scan.
2. Complete the current real-runtime and platform gates. CI alone is insufficient.
3. Test install, upgrade, disable, uninstall/reinstall and recovery using the candidate archive. Retain the package hash and report.
4. Verify main protection, required checks and protected `v*` tags. Tags cannot be updated or deleted.
5. Create a tag from the final tested main HEAD. Never reuse a version or move a published tag.
6. Dispatch the workflow with the exact commit SHA. Its `npm-release` environment must be configured for the same Trusted Publisher identity. Review generated package contents before authorizing any account-side publish.
7. Download the published npm and GitHub Release archives; compare SHA-256 and npm integrity with the actual published bytes, inspect metadata and install from the public source. If builds differ, do not claim byte identity or silently replace artifacts.
8. Publish checksums, source commit, tested Desktop version, schema compatibility, upgrade/rollback instructions and known limitations with the release.

## Recovery

Do not overwrite a published npm version. Investigate and publish a new patch when necessary. Data rollback may require restoring the matching backup, not only old code. Preserve historical archives and checksums. Market directory inclusion is not a security audit; external Market PR submission remains a separate action.

## 当前状态

正式发行仍以最终验收报告为准。当前本地 npm 认证失效，不能据此确认 Scope 权限或 Trusted Publisher 已配置。普通代码推送不会运行正式发布。禁止将账户凭证写入代码。
