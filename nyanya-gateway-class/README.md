# Nyanya Gateway Class

Nyanya Gateway Class 是 Nyanya Gateway 中专门服务原版 J2ME / Symbian QQ 的兼容子项目。

电脑上的 NapCat 保持真实 QQ 在线；Class 网关把好友、群组、群成员和文字消息翻译成老客户端认识的二进制协议。手机只连接局域网里的电脑，不保存或发送真实 QQ 密码。

```text
J2ME / Symbian QQ
          │ 旧 QQ TCP（默认 14000）
          ▼
Nyanya Gateway Class
          │ OneBot v11 正向 WebSocket
          ▼
      NapCat / QQ
```

> **账号风险警告：** NapCat 属于第三方 QQ 协议/自动化接入工具，可能触发强制下线、限制登录、账号冻结等 QQ 风控。不建议使用主力账号、保存重要资料的账号或难以找回的账号。因平台风控、封禁或账号处置造成的账号及数据损失，由使用者自行承担，本项目及贡献者不承担责任。

第一次部署请直接阅读 [零基础 J2ME/Symbian 教程](../docs/BEGINNER-GUIDE.md)。教程从安装 Node.js 和配置 NapCat 开始，逐步说明 JAR 注入、Symbian Wi-Fi 网关设置、登录和消息验收。

## 发布包包含什么

Gateway Class 发布包包含：

- 可直接运行的 Class 网关；
- J2ME JAR 注入器 `patch-jar.bat` 及全部依赖；
- Symbian 路由脚本 `启用Symbian路由.bat`；
- 配置示例、使用教程和测试。

发布包不包含原版 MobileQQ JAR、Symbian QQ SIS、真实 QQ 密码、用户配置、日志或运行数据库。用户只需要另行准备自己合法持有的原版客户端。

## 最短启动步骤

要求 Node.js 22.5 或更高版本，并确保 NapCat 已登录且开启 OneBot v11 **WebSocket 服务端（正向 WebSocket）**，推荐地址 `ws://127.0.0.1:3001`。

1. 复制 `config.example.json` 为 `config.json`；
2. 填入 NapCat 的 `onebotToken`，把 `deviceToken` 换成自己的本地密码；
3. 双击本目录的 `启动网关.bat`；
4. 等日志出现 `[napcat] 已连接` 和“镜像已刷新”；
5. 再接入 J2ME 或 Symbian 手机。

源码工作区也可以从仓库根目录运行：

```powershell
Copy-Item .\nyanya-gateway-class\config.example.json .\nyanya-gateway-class\config.json
npm run test:class
npm run start:class
```

独立发布包顶层对应 `npm test` 和 `npm start`。管理页默认为 <http://127.0.0.1:13980/>。

## 手机接入

### J2ME MobileQQ

1. 双击 `patch-jar.bat`；
2. 把自己合法持有的 MobileQQ 12.0.16 JAR 拖入窗口；
3. 工具自动检测电脑局域网 IP；
4. 把 `dist/patched-client.jar` 和 `dist/patched-client.jad` 传到手机；
5. 安装后选择与电脑相同的 Wi-Fi。

补丁工具已经在发布包里，不需要另行下载。电脑换网络或局域网 IP 变化后，需要重新生成并安装 JAR。

### Symbian QQ

1. 先启动 Class 网关；
2. 双击 `启用Symbian路由.bat` 并允许管理员权限；
3. 手机连接 Wi-Fi；
4. 记录手机当前 IP，并在电脑运行 `ipconfig` 查看子网掩码；
5. 把手机 IPv4 由自动改成手动，填写同网段且不冲突的固定手机 IP，并填写与电脑相同的子网掩码；
6. 把手机**当前 Wi-Fi 的默认网关**改成脚本显示的电脑局域网 IP；
7. 保存并重新连接 Wi-Fi，回到电脑按 Enter 启用旧节点接管；
8. 保持脚本窗口打开，再在 QQ中登录。

路由脚本不要求在电脑上输入或限制手机 IP，但 Symbian 的 Wi-Fi 配置必须使用有效的固定 IPv4 和子网掩码。只连 Wi-Fi 不够；必须同时满足“手机固定 IP 与电脑同网段、子网掩码与电脑相同、手机 Wi-Fi 网关 = 电脑局域网 IP”。使用结束后，在脚本窗口按 Enter 恢复电脑设置，并把手机 IPv4、网关和 DNS 恢复原值或自动获取。详细填写示例见 [零基础教程](../docs/BEGINNER-GUIDE.md)。

两类客户端登录时都填写真实 QQ 号，密码栏填写 `config.json` 中的 `deviceToken`，不要填写真实 QQ 密码或 NapCat token。

## 已实现

- 原版 J2ME/Symbian 登录和会话密钥；
- 好友、全部群组和群成员的镜像与低内存分页；
- 本人真实昵称、好友名、群名和群成员群名片；
- 私聊和群聊纯文字双向收发；
- 私聊离线补发和系统通知；
- J2ME 群订阅状态、全局和按群消息屏蔽；
- QQ2013 群发现、群资料和讨论组兼容隔离；
- 本机管理页、SQLite、日志和本地媒体降级。

Symbian 客户端会先完成好友分页，再加载群分页和群资料。群很多时请等待几秒到几十秒，初始化期间不要看到空白就立即退出。

## 当前限制

- 一个 NapCat 实例只对应一个真实 QQ 账号；
- 群消息不做离线补发；
- 图片和语音目前只保存到本地或降级为文字提示；
- 搜索、加好友、好友验证和群管理没有完整映射；
- Symbian 讨论组创建只保存在本地镜像；
- 第三方 QQ 协议和客户端版本变化可能带来兼容问题。

完整配置字段、群屏蔽、数据备份和排错见 [使用与配置手册](../docs/USAGE.md#nyanya-gateway-class)。

## 数据与安全

运行数据默认保存在 `nyanya-data/`。升级前停止网关，同时备份 `config.json` 和整个数据目录，不要遗漏 SQLite WAL 文件。

网关只适合可信局域网或可信 VPN。不要把 14000、13980、13981 或 NapCat 端口暴露到公网；日志可能包含消息文字，分享前请脱敏。NapCat 和第三方 QQ 协议工具可能触发强制下线、限制登录、账号冻结等风控，不要使用主力账号；相关账号及数据损失由使用者自行承担，本项目及贡献者不承担责任。
