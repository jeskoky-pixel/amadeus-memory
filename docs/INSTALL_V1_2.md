# Amadeus Memory v1.2.0 安装与升级

本仓库根目录是可安装包，发行包名为 `@fg-lab/amadeus-memory@1.2.0`。公开 npm、GitHub Release 与外部市场的实际状态应以发行报告为准。先前隔离测试使用官方 DSH Desktop `0.2.1-rc.3` 附带的 DSH 运行时；更广泛的兼容性仍需实测。普通用户不需要 Node、源码构建或 Codex。

## 首次安装

1. 在 DSH Desktop 打开目标 Profile 的插件管理器，选择安装本地预构建包；发行获准后也可使用对应的 Market/GitHub 条目。
2. 选择 `fg-lab-amadeus-memory-1.2.0.tgz` 或安装 `@fg-lab/amadeus-memory@1.2.0`，确认已安装插件列表显示新包名，并打开其设置页。GitHub 根目录安装不再需要 `#path:/dsh-mneme`。
3. 先在设置中核对 `memoryDir` 与目标 Workspace；同一 Profile 只能启用一个 `dsh-mneme`。旧根 `memory.db` 不会自动收养。
4. 按宿主提示重载或重启，回到设置页检查健康状态。安装失败时不要修改数据目录；保留错误信息与原安装包，然后恢复备份的 Profile。

## 升级

旧版升级前先导出 DSH Profile，停止插件写入，并对用户数据做一致性备份：`memoryDir` 下的 Workspace 数据库、向量、图谱、授权和备份；内部插件 ID 始终是 `dsh-mneme`。从旧 `@amadeus/memory` 或 `@modusensus/dsh-mneme` 切换包名时，先停用并移除旧 Bundle 配置，再安装新包；不能同时启用两个 `dsh-mneme`。保持原 Workspace、插件 ID、数据路径与配置，硬重启后检查内容和关键关联。确认新版本正常后才清理旧安装包。详细迁移和回滚规则见 [升级政策](UPGRADE_POLICY.md) 与 [数据迁移](DATA_MIGRATION.md)。

## 禁用、卸载与恢复

禁用只停止功能，保留数据。卸载默认只移除代码；用户数据位于安装包之外。插件管理器对 Profile 中配置条目的保留行为取决于宿主，卸载前必须导出 Profile。重新安装同一版本并恢复原配置路径可重新读取数据。彻底删除数据是独立、明确的人工操作，不能由安装脚本自动执行。

## 发行边界

当前本地预构建包已通过隔离官方 `dsh plugin` 安装；尚未通过公开 Market 下载源，也未验证生产 QQ/NapCat 或个人 Profile。不要把内部候选包当作已公开发布版本。
