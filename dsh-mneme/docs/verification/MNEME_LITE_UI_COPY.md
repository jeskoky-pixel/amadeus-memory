# Mneme-lite UI Copy Cleanup Verification

Task: `3b1cc682-f9e3-4df2-aa68-18490fe885d3`

## Changed files

- `dsh-mneme/lib/client.js`
  - Renamed the visible Memory -> Recent subtab in both dictionaries:
    - Chinese: `近期上下文` -> `跨会话近期动态`
    - English: `Recent` -> `Cross-Session recent activity`
  - Replaced the retired trusted-intake wording in the memory management tag
    hint in both dictionaries:
    - Chinese: `普通标签可手工编辑；事件标签只能由受信 intake 生成。` ->
      `普通标签可手工编辑；受保护的事件标签无法通过普通管理伪造。`
    - English: `Ordinary tags are editable; event tags can only be minted by
      trusted intake.` -> `Ordinary tags can be edited; protected event tags
      cannot be forged through ordinary management.`
- `dsh-mneme/test/client-recent.test.js`
  - Added focused assertions for the new Chinese and English subtab labels and
    the new tag-hint copy, plus a regression guard that the old subtab label is
    gone.

This task did not edit any `src` file. `lib/client.js` is lib-only, so no
`npm run sync` was required. No feature logic, settings structure, route, schema, installed
package, live DSH profile or production data was touched. No web search,
external agent, child agent or commit was used.

## Tests

Commands run from `dsh-mneme/`:

```text
node test/client-recent.test.js
node test/client.test.js
```

Results:

```text
client-recent.test.js   12 tests, 12 pass, 0 fail
client.test.js          93 tests, 93 pass, 0 fail
```

`node --test test/client.test.js test/client-recent.test.js` could not run in
this sandbox because the Node test runner spawns each test file with piped
stdio and fails with `spawn EPERM`. Running the same test files directly, as
shown above, executes them in-process and both files pass.

## Contract check

- [x] Visible recent subtab uses `跨会话近期动态` and
      `Cross-Session recent activity`.
- [x] Retired Life/trusted-intake hint replaced with neutral copy: ordinary
      tags are editable and protected event tags cannot be forged through
      ordinary management.
- [x] Event-tag protection itself was not removed or changed.
- [x] Focused client tests pass.
- [x] Changes stay within `lib/client.js`, `test`, and this report.
