# @nyanya/gateway-core

两个网关共享的协议无关核心，负责联系人、群、群成员、消息、通知、发送路由、限频、会话、历史和离线投递接口。

它不生成 Nyanya TCP 帧，也不生成旧 QQ 二进制包：`gateway/` 和 `nyanya-gateway-class/` 分别负责自己的传输适配。兼容网关的 SQLite 仍由该子项目维护。

```powershell
npm run test:core
```

架构说明见 [架构说明.md](../../架构说明.md)。
