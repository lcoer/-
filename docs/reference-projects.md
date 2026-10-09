# GitHub 参考项目调研

调研日期：2026-10-09。用途：验证设计选择，借鉴工程方式；本次未下载、复制或安装这些项目。

## 1. openatx/uiautomator2

来源：[项目 README](https://github.com/openatx/uiautomator2)。

项目将 Android 设备服务和 Python 客户端分开，提供基于控件条件的等待、定位和设备状态查询。我们借鉴“设备接口独立、明确超时、按页面条件等待”的设计。

不在首轮引入 Python 客户端或替换驱动。迁移前须验证动效页面、打包体积、服务启动和异常恢复。当前项目的 ADB 驱动不能等同于 UiAutomator2 服务。

## 2. appium/appium-uiautomator2-driver

来源：[驱动 README](https://github.com/appium/appium-uiautomator2-driver)，尤其是 Settings 与 Troubleshooting。

官方文档介绍设备会话、环境检查、定位策略，以及 `waitForIdleTimeout` 对持续动画页面的影响。关闭 idle 等待可能改善速度，但也可能在过渡页面误操作。

借鉴会话管理、环境诊断和等待条件；可做小规模动效页面对照验证。首轮不迁移到完整 Appium，也不能仅根据文档宣称它一定适配“双鱼部落”。

## 3. sindresorhus/p-queue

来源：[项目 README](https://github.com/sindresorhus/p-queue)。

提供 Promise 并发控制和 AbortSignal 取消。文档明确：排队取消与正在执行任务的取消不同，运行中的函数必须主动处理信号；清空队列不能替代完整取消。

借鉴单设备串行、等待空闲、取消传播和错误处理。首轮只需小型占用管理器与串行队列，不为几个任务引入完整调度平台。若以后直接采用依赖，再核实版本和模块兼容。

## 4. qbalsdon/accessibility_broadcast_dev

来源：[项目 README](https://github.com/qbalsdon/accessibility_broadcast_dev)。

展示 ADB 广播、BroadcastReceiver 和 AccessibilityService 的分层方式，与本项目桥接结构相似。可参考职责划分和启用体验。

仓库 README 标注已归档，不作为持续维护的运行时依赖。请求 ID、原子响应文件与协议握手是针对本项目缺陷提出的设计，不宣称来自该仓库。

## 5. senzhk/ADBKeyBoard

来源：[项目 README](https://github.com/senzhk/ADBKeyBoard)。

支持 Base64 Unicode 输入和 `ADB_CLEAR_TEXT`。官方使用步骤包含启用输入法并将其设为默认或当前 EditText 的输入法。

这与本项目“无需成为默认输入法”的历史环境结论不同。规划要求检查安装与输入能力，并读取输入框核验完整文字；不能把历史观察作为所有模拟器都成立的保证。

该仓库标注 GPL-2.0。如未来将其 APK 随软件分发，应先明确适用许可义务与分发方式；本轮不复制或捆绑它。

## 6. 调研结论

保留现有架构，采用成熟自动化项目中的条件等待、会话占用、取消传播与环境诊断思路。桥接协议针对现有固定文件竞态重新设计。不存在可以直接替代本项目全部业务的已验证参考项目。

参考资料会更新；实施时如直接引入第三方代码或依赖，需要记录具体版本、许可证和来源。当前调研依据 README 和公开文档，未完成这些仓库的完整源码审计。
