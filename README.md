# 双鱼部落写作业机器人

一个基于 **Electron + ADB** 的语音厅自动化桌面软件，用于在**雷电模拟器**里的
「双鱼部落」Android 应用中自动完成**私聊(写作业)**、**自动欢迎**、**自动打call**。

> ⚠️ 「双鱼部落」是 **Android 应用**(`com.sybl.voiceroom`)，**没有 Windows 原生客户端**。
> 本软件通过 **ADB 驱动模拟器** 实现自动化，不修改 App 文件，账号与登录态真实。

## 核心原理

```
Electron 桌面端 (UI + 任务调度)
        │  ADB (雷电模拟器自带 adb.exe)
        ▼
雷电模拟器中的「双鱼部落」Android App
        │
        ├─ 普通页面：uiautomator dump 读控件树
        └─ 动效页面(房间页)：自建无障碍服务 syl-bridge 读取
```

- **读控件树**：普通页用系统 `uiautomator dump`；房间页有持续动效会导致 uiautomator
  永远拿不到 idle，改用自建 `AccessibilityService`(`tools/syl-bridge/`)直取节点树。
- **中文输入**：走 `ADBKeyboard` 广播注入(`ADB_INPUT_B64`)，**无需**切换默认输入法。
- **发送验证**：以「消息条数增加 + 新文本出现 + 输入框清空」三重信号确认发送成功。

## 功能

| 模块 | 说明 |
|---|---|
| **自动私聊** | 按目标昵称定位会话并发送文字；随机延迟、黑名单、今日去重、发送上限 |
| **自动欢迎** | 轮询房间公屏的进入事件，自动欢迎新用户 |
| **自动打call** | 房间内循环点击表情(打call) |
| **实时贵宾位** | 采集记录卡片流 + 实时统计 |
| **规则设定** | 云端/本地 ID 来源、延迟范围、性别与工会筛选、**一键解析昵称** |
| **文案编辑** | 多条文案(随机/指定) |
| **黑名单** | 发送目标过滤 |

## 环境要求

- Windows
- [雷电模拟器](https://www.ldplayer.net/)(LDPlayer)，已安装并登录「双鱼部落」
- Node.js(开发/运行)

## 快速开始

```bash
npm install
npm start
```

或直接双击 `start.bat`。若启动异常，双击 `ShuangyuAssistant_DEBUG.bat`
(会先清理残留进程再启动，并打印日志)。

## 使用步骤

1. **先启动雷电模拟器**，进入桌面，并**在模拟器里登录「双鱼部落」**。
2. 打开本软件 → 左侧「**设置**」页：
   - **连接状态** 应显示 `已连接`(设备 `emulator-5554`)
   - **无障碍桥接** 应显示 `已就绪`
   - 若未连接：点「检测并连接模拟器」；仍不行则「手动指定 adb 路径」
     (通常是 `D:\leidian\LDPlayer14\adb.exe`)
   - 若桥接未就绪：点「安装/启用无障碍桥接」
3. 进「**规则设定**」页，选择目标来源并填写文案。
   - **本地 ID 列表**里可填 `uid` 或 `uid,昵称`
   - 真实模式**必须带昵称**才能定位会话 → 点「**自动解析昵称**」可自动补全
     (会遍历模拟器会话逐个读取，约 15–20 秒/个，期间请勿操作模拟器)
4. 进「**控制台**」启动对应任务(私聊 / 欢迎 / 打call)，实时日志会显示每步进度。

## 调试 / 排障须知

> 1. 启动脚本保持**纯英文(ASCII)**且换行为 **CRLF**，勿写中文或加 `chcp`。
> 2. 所有 GPU / 沙箱开关写在 `electron/main.js`(`app.commandLine.appendSwitch`)，
>    **不要**在命令行于应用路径前追加 `--disable-gpu` 等 Chromium 开关，
>    否则 `electron.exe` 会报 `bad option` 立即退出(表现为"黑窗一闪")。
> 3. 启动前若环境里有 `ELECTRON_RUN_AS_NODE`，需清空，否则 Electron 会退化为纯 Node。
> 4. 单实例锁：已有实例在运行时再次双击会静默退出(正常)。
> 5. 若 ADB 连不上：先确认模拟器已启动，再在设置页重连；必要时用
>    `adb start-server` + `adb devices` 手动检查。

## 打包为 EXE

```bash
npm run dist
```

产物在 `dist/`(NSIS 安装包)。打包时 `tools/syl-bridge/syl-bridge.apk` 会通过
`asarUnpack` 释放到 `resources/app.asar.unpacked/`(adb install 需要真实文件路径)。

## 目录结构

```
electron/            主进程(窗口 / 静态服务 127.0.0.1:39110 / IPC)
  config.js          集中配置
  ipc/               system / task / data / window 四组 IPC
  services/          client-manager(模拟器连接) / task-runner(三任务) / data-store
src/*.mjs            Android 自动化引擎(ESM)
  adb-client.mjs     ADB 底层(连接/输入/点击/dump/截图)
  bridge-client.mjs  无障碍桥接客户端
  android-ui.mjs     页面识别 + 导航 + 发送核心
  android-driver.mjs 三功能业务实现
design/              前端(index.html + css/ + js/ 按视图分文件)
tools/syl-bridge/    自建无障碍服务 APK 工程(Java) + 编译脚本 build.sh
docs/                技术方案与探测记录
```

## 许可

仅供学习与研究使用。请遵守目标平台的用户协议与相关法律法规。
