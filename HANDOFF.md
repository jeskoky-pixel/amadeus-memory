# amadeus-memory 交接

记录日期：2026-10-24（Asia/Shanghai）。

## 仓库

- 远端：https://github.com/jeskoky-pixel/amadeus-memory
- 默认分支：main
- 可见性：公开（2026-10-25 用户明确要求）
- 开发顺序：P1
- 本地位置：主项目目录下 plugins/amadeus-memory/，属于独立 Git 仓库。

## 已完成

仓库创建、独立本地克隆、README 与本交接文档初始化。文档随本仓库提交并同步到远端。提交版本通过 git log 或主项目交付消息核对。

## 计划职责

管理有来源和权限范围的共同经历、关系信息、授权召回及可替换记忆后端。

检索前按可信场景授权，派生摘要和关系继承来源限制。基础身份、Life 账本和发送回执不依赖记忆服务；关闭后当前对话可继续。

## 下一步

等待基础身份、scope 与事件契约确定，先定义 record/retrieve/correct/forget/health 与跨场景正反例。

需求与验收关注：R-07、R-11、R-13、R-15；重点验收 A-08—A-10、A-17。

先阅读 README、主仓库 HANDOFF、多仓库约定和相关规格章节。正式开发由 Codex 编写有明确路径、契约、验收和预算的任务包；DSH 使用隔离开发 home 和工作区，不继承生产账号、记忆或发布凭据。

## 未运行与限制

- 未实施插件代码、构建、安装、升级、卸载或发布流程。
- 未验证实际 DSH、QQ、NapCat、设备或其他平台兼容性。
- 未运行本插件功能、契约、降级、权限或集成验收。
- 当前无契约兼容版本、release 或可安装依赖组合。
- 本仓库许可证未确定；任何第三方复用均须单独核查。

文档初始化不能计为产品验收通过。保留可选依赖边界，授权失败时不放行受影响动作；不把计划、超时或取消请求记作完成。

## 本地同步

在本仓库目录内查看 git status、git log 和 git remote -v；主项目不会代为跟踪本仓库文件。拉取与推送针对本仓库的 origin；主仓库的 plugins/ 被忽略，不使用 Git Submodule。

## 账号切换核查（2026-10-25）

- 当前分支 `main`；无未合并 PR（2026-10-25 实查）。状态：只有仓库和职责文档，尚无插件实现或功能验收。本轮只补交接文档，没有新功能。
- 当前文档提交请运行 `git log -1 --format=%H`；主项目 REPOSITORY_MAP 保存插件精确交付 SHA。
- 契约：尚未声明运行时兼容版本；主项目 QQ/Life 0.1-draft 仅供设计参考。独立许可证待拥有者选择，不继承主仓库 MIT。
- 当前项目只推进 Life；本插件继续按上文职责保留，未经用户新指令不切换开发。QQ 遗留独立 NapCat 和真实链路验收仍待核实。
- 必读主项目 [接手入口](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/NEXT_CODEX_START.md)、[项目状态](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/handoff/CURRENT_STATE.md)、[架构](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/codex/life-development/docs/ARCHITECTURE.md)。
- 禁止改动生产 SnowLuma、QQ Bridge、生产 DSH 或登录/记忆数据；禁止 Computer Use、真实发送、擅自发布/merge；保留独立安装和可选依赖边界。文档保存不等于插件验收。
