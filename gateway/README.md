# Nyanya Gateway（通用网关）

通用网关连接 NapCat/OneBot，并通过 Nyanya Protocol v1 服务第一方 Nyanya J2ME、未来 3DS/PSV 等客户端。原版 MobileQQ 或 Symbian QQ2013 应使用 `nyanya-gateway-class/`，两类客户端不能混用网关。

## 启动

从工作区或发布包根目录执行：

```powershell
Copy-Item .\gateway\config.example.json .\gateway\config.json
# 编辑 gateway/config.json
npm test
npm start
```

手机连接时把 `host` 改为 `0.0.0.0`，并在客户端填写 PC 的局域网 IP、端口 14000 和配置中的设备 `token`。NapCat 中应创建“WebSocket 服务端（正向 WS）”，默认地址为 `ws://127.0.0.1:3001`。手机不能填写 `127.0.0.1`，因为它在手机上代表手机自己。

完整步骤见 [使用与配置手册](../docs/使用与配置手册.md#通用-nyanya-gateway)。

## 代码边界

- TCP 会话和 Nyanya 帧适配位于本目录；
- 领域模型、消息路由和离线队列来自 `packages/gateway-core/`；
- NapCat 上联来自 `packages/onebot-adapter/`；
- 帧编解码和 AUTH 协商来自 `packages/nyanya-protocol/`。

协议说明见 [Nyanya 客户端协议 v1](../docs/PROTOCOL.md)。

## 安全

协议默认是局域网明文。不要把网关端口暴露到公网；远程连接应放在可信 VPN 后。
