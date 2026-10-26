# QQ Session 的 Memory 注入边界

`amadeus-qq` preset 的模型请求属于对外场景。Memory 的自动注入在此 preset 中采取默认关闭策略，直到以下条件同时满足：

1. Memory 配置启用 `sceneIsolationEnabled` 和 `sceneStrictQQ`。
2. 同进程 QQ 插件通过 `resolveTrustedSessionScene(sessionId)` 认出当前 DSH Session，并确认其绑定及权限版本仍有效。
3. 返回的 Scene 能由 Memory 校验并铸成进程内可信对象。

满足条件后，自动注入只读取该 Scene 可见的记忆与近期上下文。QQ 插件缺失、Session 已撤销、配置未启用严格隔离或 Host 契约出错时，QQ 的 Memory 注入为空；普通非 QQ Session 沿用原行为。未带受众分类的用户画像与规则也不进入 QQ 请求。

此补丁处理系统提示词注入。模型工具、HTTP 路由和其他插件的来源校验仍各自执行现有权限规则。跨 Scene 授权仍由 `hostContract:false` 关闭；本补丁不打开共享。

`node --test test/qq-host-inject.test.js test/inject.test.js test/scene-recent-core.test.js test/persona-inject.test.js`：51 pass。`npm run quality:amadeus`：512 pass。真实 DSH Desktop 的 QQ→Memory 跨 Scene 路径仍需隔离联调。
