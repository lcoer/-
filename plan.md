# 双鱼助手实施计划

日期：2026-10-09。基线：`5f862f8`。状态：用户已授权实施，首轮稳定性代码、离线验证、隔离渲染与构建完成；真实设备验收待开展。

实际进展：A–E 核心改造完成；F 的本地测试、CI 配置、诊断、构建和审查完成，实机发送、安装升级与长期运行未验收。第二轮提前完成历史持久化、分页前搜索及观察元数据；第三轮需先取得当前 App 搜索入口证据。

合理调整：设备占用放在 CommonJS 服务 `electron/services/device-session.js`，确保首次 await 前同步取得占用；新增 safe-handle IPC 边界；发送结果改为单份原子 outcome journal 派生统计；人工核对按 runId 处理。详情见 review.md。

## 执行原则

采用 [design.md](design.md) 的方案 A。先做第一轮稳定性修复，再做数据历史和用户定位扩展。每个测试用例或实现分支作为小任务执行；表中一行可包含多个 2–5 分钟的原子步骤，不承诺整批完成时长。

重要行为先写失败测试，再写实现，再审查。使用 Node 内置 `node:test`，避免为当前回归增加大型测试框架。测试只使用合成用户与控件树，不提交现有真实昵称、会话、截图或设备数据。

每批完成后验证规范和代码质量。实现阶段按 superpowers 工作流使用独立子代理承担明确文件范围，主代理完成集成；共享文件由主代理串行修改。审批前不启动实现代理。

## 第一轮：稳定性版本

### 批次 A：数据查询正确、目标来源可信

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| A1 | `tests/data-store.test.cjs` | 用临时目录和固定时钟建立隔离数据仓库测试；先覆盖未知性别和跨日错误 | 旧实现对应断言失败 |
| A2 | `electron/services/data-store.js` | 抽出 `createDataStore({ dataDir, clock, persist })` 工厂，保留现有默认实例导出 | 两个实例数据和计时器互不污染；测试不依赖 Electron |
| A3 | 同上 | 统一日期过滤；查询、统计、小时汇总使用同一记录集合；校验分页参数 | 昨天/今天/跨午夜、无记录、非法分页、unknown 汇总 |
| A4 | 同上 | 小时预览保留 `source`、`uidReal`；全部性别包含 unknown | 汇总人数等于分组总和；占位元数据不丢失 |
| A5 | `src/target-policy.mjs`、`tests/target-policy.test.mjs` | 纯函数解析本地列表，保留完整昵称；规范 UID、批内去重、来源检查 | 昵称含空格/逗号、空行、重复、占位、demo 来源 |
| A6 | `design/js/rules-view.js`、`design/js/guest-view.js`、`design/index.html` | 改来源显示、目标预览、刷新规则快照；兼容旧 source 值 | 数据更新后启动目标是当前筛选；未知和占位显示清楚 |

批次 A 完成条件：所有日期入口口径一致，未知性别不报错，主进程能识别演示和占位目标；旧配置可读取。

### 批次 B：启动校验、结果和统计隔离

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| B1 | `tests/task-policy.test.mjs`、`src/task-policy.mjs` | 为目标/文案/媒体/延迟/上限写配置校验 | 空文案、空指定项、媒体模式、负值、NaN、反向延迟被拒绝 |
| B2 | `electron/services/task-runner.js`、`electron/services/client-manager.js` | 真实任务先连接和预检；演示改为显式选项，去除 shouldDemo 的隐式成功路径 | 断线不转模拟；有效连接不会被缓存 demo 状态阻断 |
| B3 | `src/task-result.mjs`、`tests/task-result.test.mjs` | 定义结构化结果和统计归类 | simulated、unconfirmed、cancelled 均不增加真实成功 |
| B4 | `electron/services/data-store.js`、`electron/services/task-runner.js` | 新真实记录采用独立版本命名空间；旧统计保留为未核验；待确认不自动重发 | demo 不写真实去重；旧数据不删除；待确认目标不会二次点击发送 |
| B5 | `design/js/task-console.js`、`design/js/copywriting.js`、`design/js/settings.js`、`design/index.html` | 媒体能力提示、显式演示、准确结果栏、启动前有效目标摘要 | 无支持媒体配置不能静默只发文字；界面显示模式与待确认 |
| B6 | `electron/ipc/system-ipc.js`、`electron/preload.js` | 能力与模式 API 校验，配置保存错误返回 | 非法配置/写盘失败可见；无“写失败但保存成功” |

建议结果契约：

```js
{
  runId, targetUid, mode: 'android',
  outcome: 'confirmed_ui', // failed | unconfirmed | cancelled | skipped | simulated
  stage: 'verify', reason: null,
  evidence: { inputMatched: true, newExactText: true, failureMarker: false }
}
```

批次 B 完成条件：没有发送的路径不能计成功；演示与真实持久化隔离；旧统计迁移可解释且可回退。

### 批次 C：设备占用、取消与生命周期

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| C1 | `src/device-session.mjs`、`tests/device-session.test.mjs` | 同步取得占用、按 owner/runId 释放、拒绝冲突 | 两个同时启动只一个成功；错误释放和旧 runId 不影响新任务 |
| C2 | `src/async-control.mjs`、`tests/async-control.test.mjs` | 可取消 sleep/wait；顺序轮询；统一 AbortError | 等待可中断；排队取消 promise 收敛；轮询最长并发为 1 |
| C3 | `electron/services/task-runner.js` | private/welcome/call/collect/resolve 全部注册占用和状态；就绪后才发布 driver | 六种冲突双向检查；初始化失败释放；并发初始化去重 |
| C4 | `src/adb-client.mjs`、`src/android-ui.mjs`、`src/android-driver.mjs` | signal 到子进程与每次等待、读树、点击；操作前后检查当前 runId | 停止发生在导航/输入/发送前均无后续动作；子进程中断可见 |
| C5 | `src/room-collector.mjs`、`src/android-driver.mjs` | 采集从异步 interval 改顺序循环；stop 等待本轮收尾 | 慢 dump 不重入；停止后不入库；重启不接收旧回调 |
| C6 | `electron/ipc/system-ipc.js`、`electron/services/client-manager.js` | 安装、重连、改路径纳入占用；指定 adb 真正重建连接 | 活动任务时拒绝改设备；选新路径不返回旧缓存连接 |
| C7 | `electron/main.js`、`electron/services/data-store.js`、`electron/ipc/task-ipc.js` | shutdown await、清所有定时器、采集和解析；状态事件推送 | 应用退出不遗留任务；starting/stopping 不被显示为 stopped |

建议占用契约：

```js
const lease = session.acquire({ owner: 'private', runId, serial });
// 冲突：{ ok: false, reason: 'DEVICE_BUSY', owner: 'collect' }
// release 校验 owner/runId；整个任务收尾前不放行下一任务。
```

批次 C 完成条件：真实设备首版单任务，停止不再安排动作；已经发出的操作以结果证据处理，不能宣称取消撤回了消息。

### 批次 D：桥接协议与 APK 同步

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| D1 | `tests/bridge-client.test.mjs` | 模拟 ADB：旧响应、乱序、缺字段、半写 JSON、超时、并发 dump | 旧实现读取旧结果的用例先失败 |
| D2 | `src/bridge-client.mjs` | requestId/版本握手、共享每设备串行队列、按请求路径读取、取消和清理 | 响应必须匹配；失败后队列继续；点击超时不自动重试 |
| D3 | `tools/syl-bridge/app/src/main/java/com/syl/bridge/CommandReceiver.java` | requestId 白名单、协议版本、结构化 JSON、按请求输出 | 非法 ID 不写路径；未知指令返回关联错误 |
| D4 | `tools/syl-bridge/app/src/main/java/com/syl/bridge/SylAccessibilityService.java` | dump 按 requestId 路径写；原子写入；ping 返回协议能力 | 响应与 dump 对应；读取不到半文件 |
| D5 | `tools/syl-bridge/build.sh`、可新增 `tools/syl-bridge/build.ps1` | 相对路径与 SDK/JDK 参数，检查全部工具，固定版本，签名复用 | 在临时 build 目录编译；不误删工程；路径含空格可用 |
| D6 | `tools/syl-bridge/syl-bridge.apk`、`electron/ipc/system-ipc.js`、`design/js/settings.js` | 重建 APK、校验签名与 hash、安装后握手检查 | 旧 APK 显示升级提示；bridgeReady=false 不显示已就绪 |

协议样例：

```json
{"protocolVersion":2,"requestId":"3b85d637-9b4c-4e76-944b-002d5b46b858","cmd":"dump","ok":true,"out":"requests/3b85d637-9b4c-4e76-944b-002d5b46b858.ui.json"}
```

依赖：C 的取消基础可复用；桥接协议独立测试可与 A/B 分文件开展。源码改完但未重建 APK 不算 D 完成。现有本机编译工具与签名文件存在，但尚未验证可编译。

### 批次 E：已有会话身份与发送证据

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| E1 | `tests/android-ui.test.mjs`、`tests/android-driver.test.mjs` | 合成控件树与模拟 ADB 记录；注入等待/时钟以避免慢测试 | 测试不连接模拟器、不发消息 |
| E2 | `src/android-ui.mjs`、`src/android-driver.mjs` | 精确昵称定位与会话滚动；同名歧义拒绝；资料 UID 核验 | 目标在第二页可找；UID 不符/读不到不发送 |
| E3 | 同上、`src/adb-client.mjs` | 输入法健康检查、完整清空与输入核验；记录并恢复原输入法 | 残留、截断、中文/emoji、取消均无错误内容发送 |
| E4 | `src/android-ui.mjs`、`src/task-result.mjs` | 严格发送证据；失败控件判定；待确认结果；不依赖左右坐标 | 来信增加、旧相同文本、列表滚动、输入框消失都不误确认 |
| E5 | `electron/services/task-runner.js`、`design/js/task-console.js` | 结果全程保留原因、阶段；存待确认记录，限制自动重发 | 成功/失败/待确认/跳过总量一致；停止后无下一目标 |

批次 E 完成条件：核验目标 UID 后才点击发送；UI 确认与服务器送达区别明确。未探测的发送失败控件保持“待确认”，不得猜测成功。

### 批次 F：工程检查与受控验收

| 编号 | 文件 | 原子工作 | 验证 |
| --- | --- | --- | --- |
| F1 | `package.json`、`scripts/dev.cjs`、`.gitignore`、`package-lock.json` | 增加 test/check 脚本；解决 cross-env 缺失；锁文件纳入管理 | npm test、语法检查、可复现依赖；无需跨 shell 设置环境变量 |
| F2 | `start.bat`、`ShuangyuAssistant_DEBUG.bat` | `%~dp0` 相对定位；不结束所有 electron.exe；保留 ASCII/CRLF | 其他目录启动成功；无关 Electron 进程保留 |
| F3 | `electron/main.js` | 静态服务错误明确失败或分配自有可用端口，不加载其他进程服务 | 端口占用和非法 URL 不导致错误页面接管 |
| F4 | `manifest.json`、`README.md`、`docs/验收清单.md` | 真实能力/任务互斥/待确认/运行依赖；legacy 明确标注 | 文档、界面、实际行为一致；本轮不批量删除历史引擎 |
| F5 | `.github/workflows/check.yml` | 离线单元测试与语法检查 CI，受控使用锁文件 | 无设备账号、无密钥也能跑；不自动操作真实应用 |
| F6 | `scripts/diagnose.mjs`、`docs/验收清单.md` | 只读环境诊断；人工控制测试账号、文字与次数；构建安装包 | 诊断不点击或发送；实机/安装包检查单独记录 |
| F7 | `review.md`、`final_report.md` | 规范符合性和代码质量审查；总结通过/失败/未测项 | 严重缺陷关闭；未完成实机项不标记已验收 |

验证命令（实现后提供脚本）：

```powershell
npm test
npm run check
npm run diagnose
npm run dist
```

实机必测：桥接升级握手、正常采集、未知性别、跨日筛选、任务冲突双向、断线、停止中、指定测试会话文字输入、发送失败与待确认、重启、退出。30 分钟稳定性运行属于人工环境验收，不能由几条离线测试代替。

## 第二轮：数据历史与来源质量

在第一轮通过后实施；细化代码前先根据实际记录样本确认模型。

1. `electron/services/data-store.js`：版本化记录存储、原子写、损坏恢复、退出 flush；测试重启、写失败和保留旧备份。
2. `src/room-collector.mjs`、Java `Dumper.java`：携带房间号和节点父子关联，用同一消息行/父容器配对 UID；括号 UID 规范化；修复 className/contentDesc 字段使用。
3. 数据模型：带证据的占位转真实身份、同名不同 UID 保留、最后观察时间和未知在线状态；不能用昵称直接作为跨房间身份主键。
4. 界面：按观察日期/房间查询，区分真实 UID 数与仅昵称数；全局搜索在仓库过滤后再分页。
5. 来源质量：公会和性别缺失不伪造；刷新字段时缺失值不覆盖已有高置信数据；明确 800 条截断和历史保留策略，必要时迁移数据库。

## 第三轮：采集到准确私聊的闭环

前置条件：第一轮可靠运行，第二轮身份模型可追踪，已确定测试账号。

1. 只读探测搜索 UID → 结果 → 主页 → 私聊路径，记录目标 App 版本和合成后的选择器样本。
2. 根据实测新增 `src/user-navigation.mjs`；按精确 UID 定位，进入主页二次核验，找不到返回结构化原因。
3. 昵称解析遍历完整会话列表，按目标 UID 提前结束，支持取消；从结果回填时保留未匹配的原昵称。

## 后续候选

图片/语音、多设备、云端、应用升级和界面美化在完整文字闭环通过后评估。每个候选先定义真实用途、接口证据、维护成本和验收条件，再决定是否加入。

## 批次依赖与交付

`A → B → C → D → E → F` 为用户可理解的交付顺序；D 的离线协议用例可独立准备，但设备验收必须等新 APK 就绪。每批都交付代码、必要回归和状态说明。

不在任务内默认推送、合并或发布 GitHub 版本。实施完本地验证后给出可审阅变更；涉及测试账号发送的实机项，以用户确定的目标和内容为准。

## 当前下一步

当前下一步是对协议 v2 升级和明确测试对象进行受控实机验收，随后探测 UID 搜索与新建会话入口。功能、测试和未完成项以 final_report.md 及 docs/验收清单.md 为准。

## 密码房增量计划（1.2.1，已执行）

1. 在 tests/room-navigator.test.mjs 增加密码弹窗、房间背景、取消按钮、聊天误判和中止回归，先验证现有实现失败。
2. 在 src/room-navigator.mjs 增加保守弹窗识别、立即结束进入等待、有限返回和本轮去重，保持其他导航行为。
3. 执行完整测试及源码检查，构建 1.2.1，验证打包版本界面及导航源文件后更新桌面程序。

## 首次私聊增量计划（1.3.0）

1. 实机读取截图中失败 UID 888188 的搜索、用户结果、完整主页、首次聊天控件，建立可靠导航证据。
2. tests/private-navigator.test.mjs 先定义精确 ID、主页二次核对、隐藏/重复结果、取消和聊天改变回归；src/private-navigator.mjs 实现有界导航。
3. src/android-driver.mjs 改按 UID 打开会话；src/android-ui.mjs 用受核对的聊天读取，并在意图持久化后重定位发送控件；允许有效 UID 无昵称。
4. 文案保存/启动纳入草稿并预览文案，恢复规则来源/采集日期时段；前端行为测试验证保存失败不启动。
5. 实机验证已有文案完整输入，在发送前中止并清除验证草稿。完整回归、独立审查、源码/打包界面检查后交付桌面 1.3.0。

## 批次与耗时增量计划（1.3.1）

1. 读取真实 rc_errorhint 与消息行，测量旧导航 ADB 调用数量/耗时；不发送新消息。
2. 在 send-proof.cjs 建立严格本条拒绝证据；UI/runner/datastore 与测试一起修复明确拒绝继续、同run清intent、未知结果不重发。
3. ADB串口短缓存及桥接同往返响应，先写回归再实现；保留协议校验、队列和单次广播。
4. Bridge直接中文输入，读取核对正文，实机干跑在发送前中止并清除草稿；同路径对比导航耗时。
5. 完整回归、独立审查、源码检查、构建及打包冒烟后更新桌面1.3.1。

## 停止全流程计划（1.3.2）

1. scripts/device-flow.cjs 用真实页面、preload、IPC及模拟器复现；独立数据，不发消息，记录状态事件顺序及停止耗时。
2. task-runner发布递增状态版本，guest-view/task-console拒绝晚到状态；VM/生命周期测试验证停止、查询、启动应答交错。
3. 采集实例按runId隔离；room-card识别新版返回结构，room-navigator/resolver恢复被中断页面，保持UID证据要求。
4. 实机六场景停止/再次启动验证；完整回归、独立审查、源码检查和打包冒烟后交付1.3.2。
