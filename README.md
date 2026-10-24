# amadeus-memory

管理有来源和权限范围的共同经历、关系信息、授权召回及可替换记忆后端。

**当前状态：仅仓库与文档初始化，无实现、安装包或正式发布；尚未完成平台联调。**

项目入口：[Amadeus-dsh](https://github.com/jeskoky-pixel/Amadeus-dsh)。开发顺序：P1。当前仓库为私有。

## 职责与边界

检索前按可信场景授权，派生摘要和关系继承来源限制。基础身份、Life 账本和发送回执不依赖记忆服务；关闭后当前对话可继续。

基于官方 DSH 运行，不另建主 Agent 推理循环。人格统一由项目基础能力定义。需要受保护动作时不可绕过可信身份、数据范围与外发权限；可选模块未安装或故障时仅降级受影响能力。

## 模块约定

独立安装、升级、卸载，独立版本、测试和发布。后续必须声明能力、必要/可选依赖、契约兼容版本、健康状态与故障降级。目前这些契约仍待核实和确定，不声称已有可用接口。

## 开发入口

- [HANDOFF.md](HANDOFF.md)：当前状态、下一步与未运行检查。
- [总体规格](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/AMADEUS_SPEC.md)
- [多仓库约定](https://github.com/jeskoky-pixel/Amadeus-dsh/blob/main/docs/ARCHITECTURE.md)

需求与验收关注：R-07、R-11、R-13、R-15；重点验收 A-08—A-10、A-17。

下一步：等待基础身份、scope 与事件契约确定，先定义 record/retrieve/correct/forget/health 与跨场景正反例。

## 发布与隐私

尚无可用安装命令。许可证尚待明确，不因主仓库选择 MIT 而自动继承授权。第三方代码在复用前核查许可并保留来源；不提交真实凭据、私聊、记忆、设备登录资料或未经授权素材。
