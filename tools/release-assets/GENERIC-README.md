# Nyanya Gateway

这是供第一方 Nyanya 客户端使用的独立 PC 网关发布包。它连接 NapCat/OneBot，把好友、群组和文字消息送到局域网里的 Nyanya J2ME 客户端，以及未来的 3DS、PSV 等客户端。

原版 J2ME MobileQQ 或 Symbian QQ2013 不能连接本包，需要使用 **Nyanya Gateway Class** 发布包。

> **账号风险警告：** NapCat 属于第三方 QQ 协议/自动化接入工具，可能触发强制下线、限制登录、账号冻结等 QQ 风控。不要使用主力账号、保存重要资料的账号或难以找回的账号。因平台风控、封禁或账号处置造成的账号及数据损失，由使用者自行承担，本项目及贡献者不承担责任。

## 准备

- Node.js 22.5 或更高版本；
- 已登录 QQ 的 NapCat；
- NapCat WebUI 中已启用“WebSocket 服务端（正向 WS）”，推荐 `127.0.0.1:3001`；
- 手机和电脑处于可以互相访问的同一局域网。

## 第一次启动

1. 把 `gateway/config.example.json` 复制为 `gateway/config.json`。
2. 把 `host` 改为 `0.0.0.0`，否则其他设备无法连接。
3. 把 `token` 换成自己的独立设备 token。
4. 填入 NapCat 的 `onebotUrl` 和相同的 `onebotToken`。
5. 双击根目录的 `启动网关.bat`，或运行：

```powershell
npm test
npm start
```

看到以下日志后再打开手机客户端：

```text
[onebot] connected
[gateway] listening on 0.0.0.0:14000
```

## 客户端填写

- 服务器：电脑的局域网 IPv4，不是 `127.0.0.1`；
- 端口：默认 14000；
- 设备令牌：与 `gateway/config.json` 的 `token` 完全一致；
- 设备 ID：为这台手机设置稳定且唯一的名称。

详细配置、升级和排障见 [使用与配置手册](docs/USAGE.md)，客户端协议见 [Nyanya Protocol v1](docs/PROTOCOL.md)。如果你实际使用的是原版 J2ME/Symbian QQ，可以先阅读包内的 [旧手机零基础教程](docs/BEGINNER-GUIDE.md)，然后改用 Gateway Class 发布包。

本包不包含本机配置、token、日志、PID、SQLite 数据或旧 QQ 研究材料。协议默认是局域网明文，请只在可信家庭网络或可信 VPN 中使用，不要把网关或 NapCat 端口暴露到公网。

## 开源许可证

Nyanya Gateway 采用 Apache License, Version 2.0，完整文本见包内 `LICENSE`。第三方资源和复用代码的归属见 `docs/ATTRIBUTION.md` 与 `THIRD-PARTY-LICENSE.txt`。
