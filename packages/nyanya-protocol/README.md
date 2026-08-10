# @nyanya/protocol

第一方 Nyanya 客户端与通用网关之间的版本化局域网协议。当前包版本为 1.0.0，线协议版本为 v1。

- 12 字节帧头、Magic `0x4A51` 和现有 Type 数值保持稳定；
- 未声明 `protocolVersion` 的旧客户端按 v1 处理；
- 新客户端通过 AUTH 声明版本和 capability；
- `vectors/v1.tsv` 是 Node 与 J2ME 共用的黄金向量。

Gateway Class 的原版 QQ 二进制协议不依赖此包。

```powershell
npm run test:protocol
```

完整格式见 [Nyanya 客户端协议 v1](../../docs/PROTOCOL.md)。
