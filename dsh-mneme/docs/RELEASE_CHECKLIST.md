# Memory 固定发行检查单

本页是每次发布的门禁，不等同于发行许可。v1.2.0 公开 npm、公开 Release 和市场收录须另获 Owner 一次性确认。

## 源码与包

- [ ] 从最新 `main` 创建开发分支；记录源码 Commit SHA、上一个稳定 Tag 和 PR。
- [ ] 核对包名 `@amadeus/memory`、运行 ID `dsh-mneme`、版本、`dsh.bundle`、`dsh.client`、`engines.dsh`、入口及 `cordis.patch.yml`。
- [ ] `npm ci --ignore-scripts`、`npm run sync`、`npm test`、`npm run verify:release` 通过；额外运行必要的跨插件契约测试。
- [ ] 用 `npm pack --ignore-scripts` 产生 `.tgz`，检查内容、SHA-256 与预构建 Client/Console/翻译/图标，确认没有凭据、数据库、日志和个人资料。
- [ ] 在目标官方 DSH Desktop 隔离 Profile 实测单独安装、五插件联合安装、禁用/启用、重启、旧版升级、卸载和恢复。只声明实测过的 DSH 版本。

## 数据与兼容

- [ ] 按 `UPGRADE_POLICY.md` 和 `DATA_MIGRATION.md` 备份并运行上一稳定版 → 当前版的合成升级回归；验证关键内容、关系、权限、绑定、功能及失败恢复。
- [ ] 确认数据路径不位于包目录；升级和卸载不删除用户数据；旧版代码回滚与数据库恢复分别演练。
- [ ] 核对 QQ Scene、Memory、Life、State、Persona 的公开 Host 契约版本与兼容矩阵，避免重复注册、重复注入和双实例。

## 发行授权

- [ ] 核实 `@amadeus` npm scope 的实际发布权限和本包发行许可证；解决 `private: true` / `UNLICENSED` 等阻碍，不擅自改名或更换许可证。
- [ ] 准备不可变的 `v1.2.0` Tag、GitHub Release 说明、可下载 `.tgz`、SHA-256、Schema Version、升级/回滚说明；正式创建公开资源前等待 Owner 确认。
- [ ] `awesome-dsh-plugin` 只增加本仓库对应的 `data/plugins/*.yml`；不编辑生成 README。市场展示、下载源和安装行为实际验证后再提交外部收录 PR。
