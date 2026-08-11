# Nyanya Gateway Class

这是供原版 J2ME MobileQQ 和 Symbian QQ2013 使用的独立兼容网关发布包。

电脑上的 NapCat 负责保持真实 QQ 在线，Gateway Class 把好友、群组和文字消息翻译成老客户端认识的格式。手机只连接局域网里的电脑，登录时不需要把真实 QQ 密码交给本项目。

> **账号风险警告：** NapCat 属于第三方 QQ 协议/自动化接入工具，可能触发强制下线、限制登录、账号冻结等 QQ 风控。不要使用主力账号、保存重要资料的账号或难以找回的账号。因平台风控、封禁或账号处置造成的账号及数据损失，由使用者自行承担，本项目及贡献者不承担责任。

## 第一次使用从哪里开始

如果你不熟悉 Node.js、NapCat、JAR 注入或 Symbian 网络设置，请不要只照着几行命令猜。打开：

> [零基础教程：用 J2ME / Symbian 老手机收发 QQ 消息](docs/BEGINNER-GUIDE.md)

教程会从安装软件开始，逐步带你完成 NapCat、网关、J2ME JAR 或 Symbian Wi-Fi 设置，并告诉你每一步看到什么才算成功。

已经部署过的用户可以查阅 [使用与配置手册](docs/USAGE.md)。

## 你需要准备

- Windows 10/11 电脑；
- Node.js 22.5 或更高版本；
- 已登录 QQ 的 NapCat；
- 能连接 Wi-Fi 的 J2ME 或 Symbian 设备；
- 自己合法持有的 MobileQQ JAR，或手机上已经安装好的 Symbian QQ2013。

本包已经包含 J2ME JAR 注入器和全部补丁脚本。用户只需要准备原始 JAR，不需要另外下载“老手机 QQ 复活计划”或其他补丁工具。本包不提供原版 JAR/SIS。

## 最短部署顺序

1. 在 NapCat WebUI 中创建并启用“WebSocket 服务端（正向 WS）”，推荐 `127.0.0.1:3001`。
2. 把 `nyanya-gateway-class/config.example.json` 复制为同目录的 `config.json`。
3. 填入与 NapCat 一致的 `onebotToken`，并把 `deviceToken` 换成自己的本地登录密码。
4. 双击 `nyanya-gateway-class/启动网关.bat`。
5. 等待日志出现 `[napcat] 已连接` 和“镜像已刷新”。
6. 按下面的 J2ME 或 Symbian 路线接入手机。

也可以从本发布包根目录运行：

```powershell
npm test
npm start
```

管理页默认为 <http://127.0.0.1:13980/>。

## J2ME 手机

1. 双击 `nyanya-gateway-class/patch-jar.bat`；
2. 把自己合法持有的 JAR 拖入窗口，按 Enter；
3. 工具自动检测电脑局域网 IP；
4. 把生成的 `dist/patched-client.jar` 和 `dist/patched-client.jad` 传到手机并安装；
5. 手机选择与电脑相同的 Wi-Fi。

电脑换网络或局域网 IP 变化后，重新运行注入器并安装新 JAR。

注入器会按客户端结构选择配置：两种已知 MobileQQ 12.0.16 布局使用完整补丁；其他包含 TCP 14000 入口的版本生成“实验性 TCP 核心版”，只重定向 TCP 并阻断剩余公网地址。看到 `experimental-tcp` 不代表旧版本协议已经兼容，仍需根据网关日志和真机逐项验证。带签名的 JAR 会被拒绝，因为修改会使原签名失效。

推荐使用 **QQ2009 及以上版本**。QQ2008 及以下可能无法登录；已测试的 QQ2008 12.05.2 会提示“付费用户余额不足（ID 31）”。这是该旧客户端与当前网关登录响应不兼容的表现，不代表真实 QQ 账户余额不足。

## Symbian QQ2013

1. 先启动网关；
2. 双击 `nyanya-gateway-class/启用Symbian路由.bat`，允许管理员权限；
3. 手机连接 Wi-Fi；
4. 记录手机当前 IP，在电脑运行 `ipconfig` 查看子网掩码；
5. 把手机 IPv4 改为手动，填写同网段且不冲突的固定手机 IP 和与电脑相同的子网掩码；
6. 把手机当前 Wi-Fi 的**默认网关地址改成脚本显示的电脑局域网 IP**；
7. 保存并重新连接 Wi-Fi，回到脚本按 Enter，保持窗口打开，再登录 QQ2013。

脚本会自动检测电脑 IP，不要求在电脑上输入手机 IP，但 Symbian 端必须先配置固定 IPv4 和子网掩码，默认网关才能正确生效。使用结束后，在脚本窗口按 Enter 恢复电脑设置，并把手机 IPv4、网关和 DNS 恢复原值或自动获取。完整填写示例见 [零基础教程](docs/BEGINNER-GUIDE.md)。

## 手机登录填写什么

- QQ 号：NapCat 当前在线的真实 QQ 号；
- 密码：`config.json` 中的 `deviceToken`；
- 不要填写真实 QQ 密码，也不要填写 NapCat token。

好友通常先出现，群组和群成员需要继续分页加载。群较多时请等待几秒到几十秒，不要看到群列表短暂空白就立即退出。

## 当前能力与边界

第一阶段支持好友、全部群组、本人昵称、好友名、群名、群名片、私聊文字和群聊文字双向收发，也支持 J2ME 群接收设置以及网关侧按群屏蔽。

图片和语音目前只会本地保存或显示文字提示；搜索、加好友、群管理等操作没有完整映射；群消息不做离线补发。NapCat 和第三方 QQ 协议工具存在兼容及账号风控风险，不要使用主力账号；相关账号及数据损失由使用者自行承担，本项目及贡献者不承担责任。

本包不会包含你的 `config.json`、token、日志、PID、SQLite 数据、补丁 JAR 或逆向研究材料。请勿把 14000、13980、13981 或 NapCat 端口暴露到公网。

## 开源许可证

Nyanya Gateway 采用 Apache License, Version 2.0，完整文本见包内 `LICENSE`。第三方资源和复用代码的归属见 `docs/ATTRIBUTION.md` 与 `THIRD-PARTY-LICENSE.txt`。
