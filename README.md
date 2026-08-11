# Nyanya Gateway

Nyanya Gateway

Nyanya Gateway 是运行在电脑上的局域网消息网关，通过与电脑上 NapCat 相连接并登录QQ号码，将QQ好友、群组和消息推送到局域网中，帮助局域网中的终端实现QQ聊天功能。
Nyanya Gateway 不是一个新的 QQ 服务器，也不会让客户端直接登录腾讯服务器。可以把它理解成一名留在电脑上的“翻译”：一边听得懂 NapCat/OneBot，另一边听得懂老客户端或 Nyanya 客户端。

```text
老手机或其他设备  ←→  Nyanya Gateway  ←→  NapCat  ←→  QQ
      局域网                 电脑              电脑
```

> **账号风险警告：** NapCat 属于第三方 QQ 协议/自动化接入工具，使用过程中可能触发 QQ 风控，包括但不限于强制下线、限制登录和账号冻结。**不建议使用主力 QQ 账号、保存重要资料的账号或难以找回的账号。** 因平台风控、封禁或账号处置造成的账号及数据损失，由使用者自行承担，本项目及贡献者不承担责任。

## 版本说明

目前仓库里有两个可以独立运行的网关，它们名字相近，但服务的客户端不同。通用 Nyanya Gateway为本项目的主要分支，对应独立编写的Nyanya 客户端，实现客户端的QQ聊天功能。Nyanya Gateway Class为本项目的独立变体，可将j2me平台或symbian平台的手机QQ作为客户端，还原官方服务器接口关闭前的使用体验。：

| 你手里的客户端 | 应该使用 | 说明 |
| --- | --- | --- |
| 原版 J2ME MobileQQ | **Nyanya Gateway Class** | 发布包内置 JAR 注入器，用户需准备自己可用的原始 JAR |
| Symbian QQ | **Nyanya Gateway Class** | 不修改 SIS；手机先设置固定 IPv4 和子网掩码，再把 Wi-Fi 网关指向电脑 |
| Nyanya J2ME 客户端 | **通用 Nyanya Gateway** | 使用项目自己的 Nyanya Protocol v1 |
| 未来的 Nyanya 3DS、PSV 等其他平台客户端 | **通用 Nyanya Gateway** | 不需要为每个平台重复实现 NapCat 接入 |

两个网关默认都占用 TCP 14000 端口，通常只启动一个。原版 QQ 客户端不能连接通用网关，第一方 Nyanya 客户端也不能连接 Gateway Class。目前的Nyanya J2ME 客户端只实现基本框架和可用性测试，更多可用功能还在开发中，暂不建议使用。

如果你只是想让一台 J2ME 或 Symbian 老手机尽快用起来，请直接阅读：

> [零基础教程：从一台电脑和一部老手机开始](docs/BEGINNER-GUIDE.md)

这份教程会从安装 Node.js、配置 NapCat、注入 JAR 或设置 Symbian 设备的Wi-Fi 开始，一直到好友、群组和文字消息验证成功，帮助用户配置Nyanya Gateway Class，实现旧设备上的手机QQ恢复聊天功能。

## 当前Nyanya Gateway Class能做什么

目前 Gateway Class 已经完成第一阶段的实际设备适配，主要能力包括：

- 原版 J2ME MobileQQ 和 Symbian QQ登录；
- 加载真实 QQ 好友、全部群组和群成员；
- 显示自己的 QQ 昵称、好友名称、群名和群成员群名片；
- 收发私聊文字消息和群聊文字消息；
- 群消息接收设置，以及网关侧的全局/按群屏蔽；
- 私聊离线补发、系统通知、本地管理页、运行日志和数据缓存。

目前仅支持文字收发聊天，图片和语音不会完整转发到真实 QQ，搜索、加好友、建群、邀请、踢人等管理操作也没有实现。详细边界见 [使用与配置手册](docs/USAGE.md#功能范围与已知限制)。

## 你需要准备什么

旧客户端路线最适合在 Windows 10/11 上使用，在使用前，你需要：

- 一台可以长时间开机并连接局域网的电脑；
- Node.js 22.5 或更高版本，推荐当前 LTS；
- 已安装、已登录并保持在线的 NapCat；
- 一部能连接 Wi-Fi 的 J2ME 或 Symbian 设备；
- 自己合法持有的 MobileQQ JAR，或已经安装在Symbian设备上的Symbian原版手机QQ（目前测试中使用的Symbian QQ版本是QQ 2013，其他版本不排除可能存在未知的兼容性问题）；
- Gateway Class 发布 ZIP，或本仓库源码。

项目不会提供原版 QQ JAR、SIS、真实 QQ 密码或 NapCat。Gateway Class 发布包会提供 JAR 注入器及其全部脚本，用户不需要再下载“老手机 QQ 复活计划”里的工具。

J2ME 原版客户端推荐使用 QQ2009 及以上版本。QQ2008 及以下可能无法完成登录；已测试的 QQ2008 12.05.2 会提示“付费用户余额不足（ID 31）”，这是协议兼容失败，不代表真实账户余额状态。

## 五分钟了解部署顺序

完整操作请看零基础教程；这里先展示全局顺序，帮助你知道每一步在做什么：

1. 在电脑上启动并登录 NapCat。
2. 在 NapCat WebUI 中创建一个 **WebSocket 服务端（正向 WebSocket）**，建议监听 `127.0.0.1:3001`。
3. 复制 `config.example.json` 为 `config.json`，填入 NapCat token 和老手机登录时使用的本地 `deviceToken`。
4. 启动 Gateway Class，看到 `[napcat] 已连接` 和“镜像已刷新”日志。
5. J2ME 用户运行 `patch-jar.bat` 生成自己的补丁 JAR；Symbian 用户运行 `启用Symbian路由.bat`，先给手机设置同网段的固定 IPv4 和正确的子网掩码，再把当前 Wi-Fi 的网关地址改成脚本显示的电脑局域网 IP。
6. 手机登录时输入真实 QQ 号；密码栏输入 `deviceToken`，**不要输入真实 QQ 密码**。
7. 等待好友和群组加载完成，再测试一条私聊和一条群聊文字消息。

## 项目结构

```text
gateway/                       通用 Nyanya Gateway
nyanya-gateway-class/          原版 J2ME/Symbian QQ 兼容网关
clients/j2me/                  第一方 Nyanya J2ME 客户端
packages/gateway-core/         两个网关共享的消息与会话核心
packages/onebot-adapter/       两个网关共享的 NapCat/OneBot 接入
packages/nyanya-protocol/      第一方客户端使用的 Nyanya Protocol v1
docs/                          正式文档
tools/                         补丁和发布工具
```

本地开发记录和旧客户端研究材料保存在 Git 忽略目录中，不会进入在线仓库或发布 ZIP。发布包也不会包含开发者的 token、生产配置、日志、SQLite 数据或原版 QQ 文件。

## 源码运行与测试

下面的命令面向开发者。普通用户使用发布 ZIP 和批处理脚本即可。

```powershell
# 通用网关
Copy-Item .\gateway\config.example.json .\gateway\config.json
npm test
npm start

# Gateway Class
Copy-Item .\nyanya-gateway-class\config.example.json .\nyanya-gateway-class\config.json
npm run test:class
npm run start:class
```

其他常用命令：

```powershell
npm run test:class:legacy       # 旧协议深度测试，需要用户自己的 TEA harness
npm run build:j2me              # 构建第一方 Nyanya J2ME 客户端
npm run release                 # 生成两个独立发布目录和 ZIP
```

## 文档导航

- [零基础 J2ME/Symbian 教程](docs/BEGINNER-GUIDE.md)：第一次部署从这里开始。
- [使用与配置手册](docs/USAGE.md)：配置字段、日常使用、升级和故障排查。
- [Gateway Class 子项目说明](nyanya-gateway-class/README.md)：旧 QQ 兼容层的能力与边界。
- [架构说明](DESIGN.md)：适合希望理解代码分层的开发者。
- [Nyanya Protocol v1](docs/PROTOCOL.md)：第一方客户端开发者使用。
- [组件版本矩阵](docs/VERSION-MATRIX.md)：查看组件和协议兼容关系。
- [资源与代码归属](docs/ATTRIBUTION.md)：第三方资源、复用代码和发布边界。

## 开源许可证

Nyanya Gateway 采用 [Apache License, Version 2.0](LICENSE) 开源。使用、修改和分发本项目代码时，请遵守该许可证的条款。

第三方资源、复用代码及原版 QQ 客户端的权利归属不因本项目许可证而改变，详情见 [资源与代码归属](docs/ATTRIBUTION.md) 和 [第三方许可文本](THIRD-PARTY-LICENSE.txt)。

## 安全提醒

- 网关默认使用局域网明文协议，只应在可信的家庭网络或可信 VPN 中使用。
- 不要把 14000、13980、13981 或 NapCat 的端口直接映射到公网。
- `deviceToken` 只是老手机连接网关的本地密码，不是 QQ 密码，但仍应使用独立值并妥善保存。
- NapCat 和其他第三方 QQ 协议工具可能触发强制下线、限制登录、账号冻结等风控，也可能因 QQ 或 NapCat 更新暂时失效。不要使用主力账号；因风控或封禁造成的账号及数据损失由使用者自行承担，本项目及贡献者不承担责任。
- 请只处理和使用自己合法持有的客户端文件，不要在发布包中重新分发原版 QQ JAR 或 SIS。
