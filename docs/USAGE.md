# Nyanya Gateway 使用与配置手册

这份文档是 Nyanya Gateway 的长期使用手册，适合已经完成第一次部署、需要查配置或排障的用户。

如果你从未使用过 Node.js、NapCat，也不知道 JAR 注入和 Symbian Wi-Fi 网关是什么，请先按 [零基础 J2ME/Symbian 教程](BEGINNER-GUIDE.md) 从头操作。那份教程只要求一台 Windows 电脑和一部能连接 Wi-Fi 的老手机。

> **账号风险警告：** NapCat 属于第三方 QQ 协议/自动化接入工具，可能触发强制下线、限制登录、账号冻结等 QQ 风控。不要使用主力账号、保存重要资料的账号或难以找回的账号，建议使用专门的测试账号。因平台风控、封禁或账号处置造成的账号及数据损失，由使用者自行承担，本项目及贡献者不承担责任。

## 先确认自己使用哪条路线

Nyanya Gateway 现在包含两个独立应用：

| 路线 | 服务的客户端 | 程序目录 | 默认端口 |
| --- | --- | --- | --- |
| 通用 Nyanya Gateway | 第一方 Nyanya J2ME、未来 3DS/PSV 等客户端 | `gateway/` | 14000 |
| Nyanya Gateway Class | 原版 J2ME MobileQQ 、Symbian QQ | `nyanya-gateway-class/` | 14000 |

两者都通过 NapCat/OneBot 使用真实 QQ 账号，但手机侧协议不同。默认端口相同，所以一台电脑通常只启动其中一个。下文中“通用网关”和“Class 网关”分别指这两个程序。

## 整体工作方式

无论选择哪条路线，数据都要经过三段：

```text
客户端设备 ←局域网→ Nyanya Gateway ←本机 WebSocket→ NapCat/QQ
```

- NapCat 保持现代 QQ 账号在线，并提供好友、群组和消息接口；
- 网关只保存运行所需的配置和缓存，不需要真实 QQ 密码；
- 客户端连接的是电脑，不是腾讯服务器；
- 手机上的登录密码是本地 token，不是真实 QQ 密码。

因此，NapCat、网关和局域网任何一段断开，老设备都会暂时不可用。

## 公共准备：NapCat 和 Node.js

### Node.js

要求 Node.js 22.5 或更高版本，推荐当前 LTS。Class 网关使用了 22.5 引入的内置 SQLite 模块，因此 22.0～22.4 不在支持范围。安装后执行：

```powershell
node --version
```

只要输出 `v22` 或更高版本即可。本项目的运行代码没有额外 npm 依赖，官方发布 ZIP 解压后可以直接使用；`npm test` 和 `npm start` 只是方便运行测试和启动的命令。

### NapCat

先按照 [NapCat 官方安装文档](https://napneko.github.io/guide/install) 安装、启动并登录 QQ。然后在 WebUI 的“网络配置”中新建：

```text
WebSocket 服务端（正向 WS）
```

推荐值：

| NapCat 选项 | 推荐值 |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `3001` |
| 消息格式 | `array` |
| Token | 自己生成的独立英文/数字字符串 |
| 启用 | 是 |

WebSocket **服务端**和“正向 WS”是同一方向：网关作为客户端，主动连接 NapCat。不要误选 WebSocket 客户端/反向 WS。NapCat 的界面和字段说明见其 [WebUI 网络配置指南](https://napneko.github.io/config/basic)。

如果 NapCat 和网关不在同一台电脑，需要额外处理监听地址、防火墙和 token；这不属于默认部署，建议先在同一台电脑完成测试。

## Nyanya Gateway Class

Class 网关是目前原版 J2ME/Symbian QQ 的兼容路线。发布包已经包含 J2ME JAR 注入器及所需脚本，但不会提供原版 JAR 或 Symbian SIS。

### 创建配置

把示例配置复制为正式配置：

```powershell
Copy-Item .\nyanya-gateway-class\config.example.json .\nyanya-gateway-class\config.json
```

发布包用户也可以直接在资源管理器中复制并重命名文件。请确认不是 `config.json.json`。

第一次部署通常只修改：

```json
"onebotUrl": "ws://127.0.0.1:3001",
"onebotToken": "与 NapCat 相同的 token",
"deviceUin": 0,
"deviceToken": "你自己的老手机登录密码"
```

`deviceUin` 保持 `0` 时，连接 NapCat 后自动使用其 `self_id`。老手机 QQ 号栏仍输入真实 QQ 号，密码栏输入 `deviceToken`。

### 配置字段说明

#### 接入和身份

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `host` | `0.0.0.0` | 监听全部本机 IPv4，让局域网手机可以连接 |
| `port` | `14000` | 原版 QQ TCP 协议端口；改动后 J2ME 补丁也要重做 |
| `onebotUrl` | `ws://127.0.0.1:3001` | NapCat 正向 WebSocket 地址 |
| `onebotToken` | 空 | NapCat WebSocket token；两边必须一致 |
| `deviceUin` | `0` | 允许登录的 QQ 号；0 表示采用 NapCat 当前账号 |
| `deviceToken` | 示例值 | 老手机密码栏使用的本地 token，建议 8～16 位英文和数字 |

#### 群消息和同步

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `pushGroupMessages` | `true` | `false` 时不向旧客户端推送任何群消息 |
| `mutedGroupIds` | `[]` | 填真实群号数组，只屏蔽这些群的推送 |
| `groupMemberMirrorLimit` | `60` | 登录时完整拉取成员列表的群数量；不限制群列表总数 |
| `symbianGroupDiscoveryBatchSize` | `10` | QQ2013 每批群发现数量，低内存机型不要随意调大 |
| `symbianGroupDiscoveryDelayMs` | `750` | Symbian 好友同步后开始群发现的等待时间 |
| `symbianGroupDiscoveryIntervalMs` | `250` | Symbian 群分页之间的间隔 |
| `symbianDiscussionListLimit` | `60` | QQ2013 讨论组兼容列表的本地上限 |

`groupMemberMirrorLimit` 只控制“启动时为多少个群完整拉成员”，不会把第 61 个之后的群从群列表中删掉。群成员列表很大时，提高该值会显著增加 NapCat 请求量和首次同步时间。

其余 `symbianBuddyDetailsPageSize`、`symbianFriendRosterPageSize`、probe 和 profile 参数用于特定机型兼容，已有保守默认值。除非正在根据日志排查，不建议修改。

#### 发送、数据和管理

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `sendMinIntervalMs` | `800` | 发送节流参数；Class 当前主要使用每分钟上限 |
| `sendMaxPerMinute` | `30` | 每分钟最多向真实 QQ 发送的文字消息数 |
| `offlineCap` | `200` | 每个目标最多保留的私聊离线消息数 |
| `dataDir` | `nyanya-data` | SQLite、WAL、日志、PID 和本地媒体目录 |
| `traceProtocol` | `false` | 输出详细旧协议跟踪；只在排障时临时开启 |
| `adminHost` / `adminPort` | `127.0.0.1:13980` | 本机管理页地址 |
| `adminToken` | 空 | 管理页访问 token；默认仅本机时可以留空 |
| `mobileHost` / `mobilePort` | `0.0.0.0:13981` | 旧客户端媒体/WAP 降级服务 |
| `mediaPublicHost` | 空 | 收到 NapCat 图片时推给手机的链接里用的主机。留空则自动探测局域网 IP；多网卡（VMware/虚拟网卡）挑错时在这里写死手机能访问的那个 IP |

不要为了“让手机连接”而把 `adminHost` 改成 `0.0.0.0`。管理页不是手机登录入口。若确实要从其他电脑访问管理页，必须同时设置强 token，并只在可信局域网放行。

### 启动和成功标志

Windows 用户进入 `nyanya-gateway-class/`，双击 `启动网关.bat`。也可以在发布包顶层运行：

```powershell
npm test
npm start
```

源码工作区对应：

```powershell
npm run test:class
npm run start:class
```

还可以直接进入子目录执行：

```powershell
node server.js
```

正常启动至少应看到：

```text
老客户端 TCP 网关已监听 0.0.0.0:14000
[napcat] 已连接 ws://127.0.0.1:3001
[napcat] 镜像已刷新：self=... 好友=... 群=...
```

管理页默认为 <http://127.0.0.1:13980/>。如果镜像日志中的 `self` 不是准备登录手机的账号，不要继续，先检查 NapCat 当前登录账号。

### 接入 J2ME MobileQQ

Gateway Class 发布 ZIP 内置 `patch-jar.bat`，用户只需准备合法持有的 MobileQQ jar：

1. 让电脑先连接最终使用的局域网；
2. 双击 `nyanya-gateway-class/patch-jar.bat`；
3. 把原始 JAR 拖入窗口或粘贴完整路径；
4. 检查自动检测到的电脑局域网 IP；
5. 等待“制作完成”；
6. 把 `dist/patched-client.jar` 和 `dist/patched-client.jad` 一起传到手机；
7. 安装 JAR，在联网询问中选择与电脑相同的 Wi-Fi。

注入器会先按常量池和 HTTP 控制流识别客户端，而不是只看文件名或版本号。两种已知 MobileQQ 12.0.16 布局会完整修改 TCP 地址、失效的 WAP 代理以及相关群网页入口；其他含 `socket://...:14000` 的版本使用“实验性 TCP 核心模式”，只修改核心 TCP 地址并阻断剩余公网入口，不改未知字节码控制流。它不会把用户的原始 JAR 上传到网络。

制作结果中的 `SupportLevel: full` 表示注入布局完整支持；`experimental-tcp` 只表示产物通过结构和网络隔离检查，旧版本的登录及业务协议仍需要逐版本验证。注入器拒绝带签名的 JAR，因为修改会使原签名失效。

J2ME 客户端推荐使用 **QQ2009 及以上版本**。QQ2008 及以下存在登录协议兼容风险；已测试的 QQ2008 12.05.2 在连接当前 Gateway Class 时会提示“付费用户余额不足（ID 31）”。该提示在此场景中表示客户端没有正确接受登录响应，不代表真实 QQ 账户的付费余额状态。

如果电脑换了网络或局域网 IP 变化，需要重新运行注入器并安装新生成的 JAR。发布包已经包含工具，不需要另找补丁程序。

手机登录时：

- QQ 号栏：NapCat 当前登录的真实 QQ 号；
- 密码栏：`deviceToken`；
- 不使用真实 QQ 密码，也不填写 `onebotToken`。

### 接入 Symbian QQ

Symbian 路线使用现有的“手机修改 Wi-Fi 网关，电脑接管旧节点”方案：

1. 先启动 Gateway Class，确认 14000 正在监听；
2. 手机连接与电脑互通的 Wi-Fi；
3. 双击 `nyanya-gateway-class/启用Symbian路由.bat`，允许 UAC 管理员权限；
4. 记下脚本自动显示的电脑局域网 IP；
5. 在修改前记录手机当前自动获得的 IPv4、原网关和 DNS；在电脑运行 `ipconfig`，记录当前适配器的子网掩码；
6. 在手机当前 Wi-Fi 的高级 IPv4 设置中，把“手机 IP 地址”由自动改为手动/固定，填写手机刚才获得的 IP 或路由器为它保留的 IP；
7. 把手机“子网掩码”设成与电脑相同，把**默认网关改成电脑局域网 IP**，DNS 保持原值；
8. 保存后让手机重新连接 Wi-Fi，再回到电脑按 Enter，让脚本添加临时旧节点地址和局域网防火墙规则；
9. 保持脚本窗口和网关运行，在 QQ2013 中使用真实 QQ 号 + `deviceToken` 登录；
10. 使用结束后回到脚本窗口按 Enter 恢复电脑设置，再把手机 IP、子网掩码、默认网关和 DNS 恢复为自动获取或改动前的原值。

只连接 Wi-Fi 并不足以接入 QQ；Symbian 端必须先完成固定 IPv4 和子网掩码，随后让“手机当前 Wi-Fi 的网关 = 电脑局域网 IP”。部分机型只有在手机 IP 和子网掩码改为手动后，网关栏才允许编辑或真正生效。

脚本会自动检测电脑 IP，不需要在电脑上输入手机 IP，也不会把规则限制到某一台手机。但手机固定 IP 必须与电脑处于同一子网，并且不能等于电脑、路由器或其他设备的 IP。第一次测试可以使用手机刚刚自动获得的地址；长期使用建议在路由器中为手机保留该地址。不要把 `127.0.0.1`、手机自身 IP 或 NapCat 端口填到 Wi-Fi 网关栏。

### 群消息接收和屏蔽

Class 网关提供三层控制：

1. J2ME MobileQQ 的群接收状态：客户端把当前接收清单报告给网关；未选择接收的群不会推送。
2. `mutedGroupIds`：无论客户端设置如何，指定真实群号都不会推送。
3. `pushGroupMessages=false`：关闭所有群消息推送。

例如：

```json
"pushGroupMessages": true,
"mutedGroupIds": [123456789, 987654321]
```

修改配置后重启网关。屏蔽只影响老手机，不会让 NapCat 或现代 QQ 退群、静音或删除消息。电脑本地日志仍可能记录消息文字用于排障，请像保护聊天记录一样保护 `nyanya-data`。

### 好友、群组和名称加载顺序

旧客户端不会一次接受完整 JSON 列表，而是按旧协议逐页请求：

1. 登录和本人资料；
2. 好友详情分页；
3. 好友名册分页；
4. 群发现分页；
5. 单群资料和成员资料。

所以“好友出现了，群还空白几秒”不一定是故障。好友或群较多时应等待几秒到几十秒，不要立即退出。

群消息发送者名称优先级是：该群群名片 → QQ 昵称 → QQ 号。NapCat 实时事件已带群名片时会直接显示；资料尚未加载或对方没有昵称信息时，才可能暂时显示号码。

### 日志和管理页

Class 网关的主要排障入口：

```text
http://127.0.0.1:13980/
nyanya-gateway-class/nyanya-data/gateway.jsonl
```

报告问题时，最好同时说明：

- 使用 J2ME 还是 Symbian、客户端具体版本；
- 登录后等待了多久；
- 日志最后一个正常阶段；
- 是所有好友/群都失败，还是某一个群或消息失败；
- 复现时间和相关 QQ/群号，可在分享前打码。

日志可能包含联系人编号、群号和消息文字。公开上传前必须检查并脱敏。

## 通用 Nyanya Gateway

通用网关只供项目自己的 Nyanya 客户端使用，不翻译原版 QQ 协议。原版 MobileQQ 或 QQ2013 请使用上一节的 Class 网关。

### 创建配置

```powershell
Copy-Item .\gateway\config.example.json .\gateway\config.json
```

主要字段：

| 字段 | 默认示例 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 手机连接时必须改为 `0.0.0.0` |
| `port` | `14000` | Nyanya Protocol TCP 端口 |
| `token` | 示例值 | 第一方客户端的设备令牌，请更换 |
| `onebotUrl` | `ws://127.0.0.1:3001` | NapCat WebSocket 服务端地址 |
| `onebotToken` | 空 | 与 NapCat 相同的 token |
| `heartbeatMs` | `30000` | 客户端心跳周期 |
| `sendMinIntervalMs` | `800` | 同一设备两次发送的最小间隔 |
| `sendMaxPerMinute` | `30` | 同一设备每分钟最大发送数 |
| `offlineCap` | `200` | 每个设备保留的离线消息数 |
| `historyCap` | `100` | 内存中的历史消息上限 |

客户端需要填写：电脑局域网 IP、端口、相同的设备 token，以及稳定且唯一的设备 ID。不要把 `127.0.0.1` 填到手机，因为它在手机上代表手机自己。

### 启动和验证

Windows 可以双击仓库或发布包根目录的 `启动网关.bat`，也可以执行：

```powershell
npm test
npm start
```

日志出现以下内容后才让客户端连接：

```text
[onebot] connected
[gateway] listening on 0.0.0.0:14000
```

第一方 J2ME 客户端的构建和登录说明位于源码仓库的 `clients/j2me/README.md`；线协议说明位于源码仓库或通用发布包的 `docs/PROTOCOL.md`。Class 独立发布包不包含这两项，因为原版 J2ME/Symbian 客户端不使用 Nyanya Protocol。

## 两个网关之间切换

两个程序默认都监听 14000。切换时：

1. 先退出手机客户端；
2. Symbian 用户先恢复路由；
3. 在当前网关窗口按 `Ctrl + C`；
4. 确认窗口已经结束，再启动另一个网关。

如果日志出现 `EADDRINUSE`，说明端口仍被占用。Windows 通用发布包提供 `停止网关.bat`；也可以在任务管理器中确认旧 Node.js 进程。启动批处理可能询问是否结束占用 14000 的旧进程，操作前先确认那确实是旧网关。

可以把其中一个网关改到其他端口，但客户端必须同步修改：第一方 Nyanya 客户端直接改登录端口；J2ME 原版客户端需要按新端口重新制作补丁 JAR；Symbian QQ2013 的兼容路线按当前脚本设计使用 14000，不建议新手改端口。

## 数据、升级和恢复

通用网关当前不依赖持久化数据库。Class 网关的重要内容是：

```text
nyanya-gateway-class/config.json
nyanya-gateway-class/nyanya-data/
```

升级 Class 网关前：

1. 停止手机客户端和网关；
2. 复制 `config.json`；
3. 复制整个 `nyanya-data` 目录，包括 SQLite 的 WAL/SHM 文件；
4. 把新版解压到新目录；
5. 再把配置和整个数据目录复制过去；
6. 启动后检查 NapCat 账号、好友数和群数。

不要把新版直接覆盖到仍在运行的旧目录。官方 ZIP 不包含任何用户配置或数据，升级前不备份就无法自动恢复自己的 token 和缓存。

## 故障排查速查

| 现象 | 首先检查 |
| --- | --- |
| 启动窗口一闪而过 | 在子目录运行 `node server.js` 保留错误；检查 Node 和 JSON |
| NapCat 一直重连 | 是否创建 WebSocket 服务端、端口/token 是否一致、QQ 是否在线 |
| 手机连接超时 | 同一局域网、电脑 IP、专用网络防火墙、14000 监听 |
| 手机提示密码错误 | QQ 号 = NapCat self_id；密码 = `deviceToken`；改配置后重启 |
| 好友有、群暂时没有 | 等待好友分页完成，再观察群发现和群资料日志 |
| 只有部分群 | 确认镜像日志群总数，等待全部分页，不要把成员镜像上限误当群上限 |
| 群成员显示 QQ 号 | 对方可能无群名片，或该群成员资料尚未拉取 |
| 能收不能发 | NapCat 在线、群成员/禁言状态、限频和 `send_*` 日志 |
| 屏蔽群仍弹消息 | 确认 J2ME 已完成群状态同步，或用 `mutedGroupIds` 强制屏蔽 |
| Symbian 完全无连接 | 是否已设置同网段固定手机 IP、正确子网掩码，以及指向电脑 IP 的默认网关 |

### Windows 防火墙

第一次启动 Node.js 时，只允许“专用网络”即可。如果当时点了拒绝，可以进入“Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙”，允许 Node.js 在专用网络通信。

不建议为了省事完全关闭防火墙，也不要为 14000、13980、13981 创建公网入站规则。Symbian 路由脚本会临时创建只允许 `LocalSubnet` 的 8080/14000 规则，并在正常退出时删除。

### 配置 JSON 错误

JSON 对英文双引号和逗号很严格。常见错误包括：

- 把英文 `"` 改成中文引号；
- 最后一项后面多一个逗号；
- 群号数组漏掉逗号；
- 文件实际名称是 `config.json.txt`。

出错时保留旧文件作为备份，重新复制示例，再只修改必要字段。不要从聊天软件直接粘贴带中文标点的 JSON。

## 功能范围与已知限制

### Gateway Class 第一阶段已完成

- J2ME MobileQQ 和 Symbian QQ登录；
- 好友、群组、群成员的镜像和低内存分页；
- 自己昵称、好友名、群名、群成员群名片；
- 私聊和群聊纯文字双向收发；
- 收到图片时落本地媒体库，并在聊天里推一条 WAP 链接供手机点开查看；
- 私聊离线补发、系统通知；
- J2ME 群订阅状态、全局和按群推送屏蔽；
- QQ2013 群发现、群资料和讨论组兼容隔离；
- 本机管理页、SQLite、JSONL 日志和本地媒体降级。

### 当前限制

- 一个 NapCat 实例只对应一个真实 QQ 账号；
- 群消息不做离线补发；
- 图片以 WAP 链接形式接收，不在聊天气泡里直接显示；手机发出的图片和语音只保存到本地，不转发真实 QQ；
- 搜索用户、添加好友和好友验证没有可靠的标准 OneBot 映射；
- 建群、邀请、踢人等老客户端命令不会操作真实 QQ；
- Symbian 讨论组创建只保存在本地镜像；
- QQ、NapCat 或老客户端行为变化后，特定功能可能需要重新适配。

## 开发和发布

在源码工作区根目录运行：

```powershell
npm test                        # 全部 Node 测试
npm run test:class:legacy       # 旧 QQ 深度测试，需要用户自己的 TEA harness
npm run build:j2me              # 构建第一方 J2ME 客户端
npm run release                 # 生成两个独立发布目录和 ZIP
```

`npm run release` 会生成通用和 Class 两个独立包，并自动排除：

- `config.json` 和本机 token；
- `nyanya-data`、SQLite、WAL、日志和 PID；
- 原版 QQ JAR/SIS、补丁产物和逆向研究材料；
- 仅供本地开发的中间记录。

发布包的重点入口是根 `README.md`、本手册和零基础教程。

## 安全建议

- 只在可信家庭局域网或可信 VPN 中使用；
- 不要把网关、管理页、媒体端口或 NapCat WebSocket 直接暴露到公网；
- NapCat 和设备 token 使用不同值，不要复用真实 QQ 密码；
- 日志可能包含 QQ 号、群号和消息文字，上传前先脱敏；
- NapCat 和第三方 QQ 协议工具可能触发强制下线、限制登录、账号冻结等风控；不要使用主力账号。因风控或封禁造成的账号及数据损失由使用者自行承担，本项目及贡献者不承担责任；
- 只处理自己合法持有的客户端文件，不要在发布物中分发原版 QQ 程序。
