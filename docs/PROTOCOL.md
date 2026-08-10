# Nyanya 客户端协议 v1

Nyanya Protocol 是第一方 J2ME、3DS、PSV 等客户端与通用 Nyanya Gateway 之间的局域网协议。原版 QQ 客户端使用的旧二进制协议属于 `nyanya-gateway-class`，不在本文范围内。

## 帧格式

```text
Magic(2B)=0x4A51 | FrameVersion(1B)=1 | Type(1B) | Seq(4B, 大端) | Len(4B, 大端) | Payload(UTF-8 JSON)
```

每帧为 12 字节头加 Payload。客户端请求的 `Seq` 从 1 递增，网关响应回显请求 `Seq`；服务端主动推送使用 `Seq=0`。v1 最大 Payload 由实现限制，Node 默认 256 KiB，J2ME 客户端接受 64 KiB。

共享 Node 实现在 `packages/nyanya-protocol/`。Node 与 J2ME 共用的字节级测试向量见 [v1.tsv](../packages/nyanya-protocol/vectors/v1.tsv)。

## AUTH 与版本协商

新客户端登录示例：

```json
{
  "device": "device-id",
  "token": "local-token",
  "protocolVersion": 1,
  "capabilities": ["text", "contacts", "notice", "offline"]
}
```

为兼容阶段 4 以前的客户端，以下旧格式仍被视为 v1，不会拒绝：

```json
{"device":"device-id","token":"local-token"}
```

认证成功响应：

```json
{
  "serverTime": 1750000000,
  "heartbeatMs": 30000,
  "offlineCount": 0,
  "protocolVersion": 1,
  "capabilities": ["text", "contacts", "notice", "offline"],
  "legacyProtocol": false
}
```

`capabilities` 是客户端请求与服务端支持能力的交集。旧 AUTH 的 `legacyProtocol` 为 `true`，并保持阶段 4 以前的完整 v1 行为。显式请求未知版本时返回：

```json
{
  "code": "unsupported_protocol_version",
  "message": "unsupported protocol version: 99",
  "supportedVersions": [1]
}
```

随后服务端关闭连接。

## v1 能力

| 名称 | 含义 |
| --- | --- |
| `text` | 私聊、群聊文本收发及媒体文本占位符 |
| `contacts` | 好友和群列表同步 |
| `history` | 内存历史分页 |
| `notice` | 系统通知推送 |
| `offline` | 设备离线消息缓冲与重连补发 |

J2ME 当前声明 `text`、`contacts`、`notice`、`offline`。v1 能力用于声明和协商，不对旧客户端进行功能裁剪；后续版本新增可选功能时，服务端必须先检查能力再发送对应数据。

## 消息类型

| 值 | 方向 | 名称 | 用途 |
| --- | --- | --- | --- |
| 1 | C→S | AUTH | 鉴权与协议/能力协商 |
| 2 | C→S | PING | 心跳 |
| 3 | 双向 | PONG | 心跳应答 |
| 10 | C→S | SEND_TEXT | `{"chatType":"private\|group","peer":"...","text":"..."}` |
| 11 | C→S | FETCH_CONTACTS | 拉取好友/群列表 |
| 12 | C→S | FETCH_HISTORY | `{"peer":"..."}` |
| 13 | C→S | READ_ACK | `{"peer":"..."}` |
| 20 | S→C | AUTH_OK | 鉴权成功、协商结果、心跳和离线计数 |
| 21 | S→C | AUTH_FAIL | 失败信息，随后断开 |
| 30 | S→C | MSG_PUSH | `{"chatType":"...","peer":"...","senderName":"...","text":"...","time":...,"messageId":"..."}` |
| 31 | S→C | CONTACTS_SYNC | `{"friends":[{id,name,remark}],"groups":[{id,name}]}` |
| 32 | S→C | HISTORY_PAGE | `{"peer":"...","messages":[...]}` |
| 33 | S→C | KICK | 同设备被替换 |
| 34 | S→C | NOTICE | `{"text":"...","time":...}` |
| 40 | S→C | ERROR | `{"code":"...","message":"..."}` |
| 41 | S→C | SEND_RESULT | `{"ok":true,"messageId":...}` |

## 版本兼容规则

- v1 帧头、现有 Type 数值和既有字段含义冻结；不得复用 Type 数值表达其他语义。
- 接收方必须忽略不认识的 JSON 字段，新增可选字段不提升主版本。
- 新的可选功能使用 capability；缺少 capability 时按 v1 基础文本能力降级。
- 无法保持语义兼容时提升 `protocolVersion`，服务端必须明确拒绝不支持的版本。
- 每个版本必须维护 Node 与至少一个客户端实现共同使用的黄金字节向量。

## 基本流程

1. 客户端连接 TCP，发送 AUTH；
2. 网关校验 token 和版本，返回 AUTH_OK，随后补发离线 MSG_PUSH；
3. 客户端每 `heartbeatMs` 发送 PING，网关返回 PONG；
4. SEND_TEXT 经 gateway-core 路由到 OneBot，并返回 SEND_RESULT；
5. OneBot 消息经 gateway-core 标准化后转为 MSG_PUSH；
6. 断线重连使用 1/2/4/8/16/30 秒退避。

## 安全

- 局域网默认明文，token 防误连但不防嗅探；
- 不要把网关端口暴露到公网，远程连接应放在 VPN/WireGuard 后；
- 网关默认限制 800 ms 发送间隔和每分钟 30 条消息。
