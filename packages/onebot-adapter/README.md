# @nyanya/onebot-adapter

两个网关共享的 NapCat/OneBot v11 正向 WebSocket 适配器，包含零依赖 RFC6455 客户端、action 调用、事件接收和重连逻辑。

应用通过工作区相对路径加载该内部包，避免维护两套 OneBot 实现。

```powershell
npm run test:onebot
```

部署说明见 [使用教程](../../docs/使用与配置手册.md#1-准备-napcat)。
