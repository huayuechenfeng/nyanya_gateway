# MobileQQ JAR 注入器兼容性移植说明

## 用途

本文供维护另一个 JAR 注入器项目的 agent 阅读。目标是把原先只支持单一 MobileQQ 12.0.16 二进制布局的补丁流程，改造成“结构识别、已知布局完整补丁、未知布局安全降级”的通用注入器。

本文不包含原版 MobileQQ JAR，也不授权上传、分发或提交用户的私有样本。测试时只处理用户自己合法持有的文件，并把样本目录加入 Git 忽略规则。

## 已复现的问题

旧注入器无条件在 `ao.class` 中寻找：

```text
http.jl(Ljava/lang/String;)Ljavax/microedition/io/HttpConnection;
```

并强制要求恰好出现一次。不同 MobileQQ 版本或同版本的直连构建中没有这个方法引用，因此统一报错：

```text
expected one http.jl(...) reference, found 0
```

这不是网卡、路径或目标局域网 IP 的问题。TCP 地址替换实际上已经完成，失败发生在后续、针对单一样本编写的 HTTP/WAP 修补阶段。

不能简单删除这项检查：

- 已验证的 HTTP 辅助类版确实需要把 `http.jl(String)` 修成 `http.open(String)`，否则相关路径可能出现 `NoSuchMethodError`；
- 原生直连版没有 `http.class`，下一步如果仍然强制读取它会继续失败；
- 旧版本中同名 `ao.class` 可能承担完全不同的功能，盲改控制流可能生成能安装但启动或联网崩溃的 JAR；
- 补丁还必须处理失效的 `10.0.0.172` WAP 分支，并防止剩余公网地址被访问。

## 本项目的参考实现

可以阅读并移植以下实现；另一项目应根据自己的目录和发布流程调整，不要机械复制绝对路径：

- [`nyanya-gateway-class/tools/client-jar-analyzer.js`](../nyanya-gateway-class/tools/client-jar-analyzer.js)：Manifest、常量池、签名、TCP 入口、群网页入口和 `ao` HTTP 路径识别；
- [`nyanya-gateway-class/tools/class-direct-http-patcher.js`](../nyanya-gateway-class/tools/class-direct-http-patcher.js)：识别 HTTP 辅助类路径和原生 `Connector.open` 路径，并在保持 CLDC StackMap 字节码偏移不变的前提下强制直连；
- [`nyanya-gateway-class/tools/patch-client.ps1`](../nyanya-gateway-class/tools/patch-client.ps1)：按分析结果选择补丁配置、生成 JAR/JAD，并进行补丁后安全复查；
- [`nyanya-gateway-class/tools/local-network-guard.js`](../nyanya-gateway-class/tools/local-network-guard.js)：阻断未被允许的公网 HTTP、Socket、IP 和 QQ 域名；
- [`nyanya-gateway-class/tests/client-patcher-self-test.js`](../nyanya-gateway-class/tests/client-patcher-self-test.js)：配置分类和安全规则单元测试。

## 已见样本矩阵

| SHA-256 | Manifest 版本 | class 数 | HTTP 结构 | 当前模式 |
| --- | --- | ---: | --- | --- |
| `6D4F0FF059C53C76D41B348F61440EE0388D4A3E66DFD0367B52A98E7D4086B2` | 12.0.16 | 434 | `http.class` + `ao -> http.jl(String)` | 完整补丁 |
| `987098740107CB4C37DCD03EEC76A6BFAF094986DC945E9FB424821EFA45C73B` | 12.0.16 | 433 | 无 `http.class`，`ao` 已直接调用 `Connector.open` | 完整补丁 |
| `423EA9857486B9E26E8ED50E26FFA7C63E75940D53779B91263BC3BDA032BEE7` | QQ2011 11.00.12 | 439 | 无 `http.class`，未命中 12.0.16 HTTP 路径 | 实验性 TCP 核心模式（真机已验证可登录、同步好友/群、收发群聊图片） |
| `F38A4C0C81D28E863FB7CC01A165A1C722A30226E60F019E3777E5D75A9C0CC3` | 10.0.40 | 340 | 未识别为 12.0.16 HTTP 路径 | 实验性 TCP 核心模式 |
| `DE7F8E579AF246B99532E684174292F57E36C31699E7019258023741E3542FE5` | 09.0.60 | 173 | 未识别为 12.0.16 HTTP 路径 | 实验性 TCP 核心模式 |
| `E7DC17F2F6DED86D639EA85E401C539001D36BA5DF0C42DDBAE61ECC01F62691` | 12.05.2 / QQ2008 | 160 | 未识别为 12.0.16 HTTP 路径 | 可打包，但实测登录失败 ID 31 |

版本号只能作为辅助信息，不能作为唯一判断条件。同为 12.0.16 的两个样本已经证明其 class 数量和 HTTP 调用结构可能不同；同为“无 `http.class`”的样本也可能落在不同配置里（QQ2011 11.00.12 走实验性 TCP 核心模式，而 12.0.16 直连版走完整补丁）。

真机回归结果：两种 12.0.16、QQ2010 10.0.40、09.0.60 和 QQ2011 11.00.12 均可用；QQ2008 12.05.2 在登录阶段提示“付费用户余额不足（ID 31）”。该提示是当前网关响应与 QQ2008 登录解析不兼容的表现，不是实际账户余额结论。对外应推荐 QQ2009 及以上，QQ2008 及以下保留兼容性警告。

> **群网页重定向的判据（本项目实际踩过）**：早期实现要求同时命中 `bid=205` 和 `bid=342` 才启用群网页重写，结果 QQ2011 这类不含这两个 bid 的版本整段跳过，群图片入口（`bid=331`）没被重定向。现在改为「只要该客户端出现任意群网页入口（`groupBids.size > 0`）就启用重写」，把包括 `?bid=` 群图片在内的全部群网页地址改成网关地址（含媒体端口）。判据放宽后必须配合补丁后的公网常量审计，确保没有漏网的公网地址。

## 推荐的注入流程

### 1. 安全解包和预检

1. 永远复制到构建目录，不覆盖输入 JAR。
2. 防止 ZIP 路径穿越：每个解包目标的规范化绝对路径必须位于 staging 根目录下。
3. 要求存在 `META-INF/MANIFEST.MF`。
4. 检测 `META-INF/*.SF`、`*.RSA`、`*.DSA`、`*.EC`；发现签名时默认拒绝，因为修改会使签名失效。
5. 读取 Manifest 时处理以空格开头的续行。

### 2. 结构分析

遍历所有 `.class` 的常量池，并记录：

- `socket://...:14000` 的数量和所在 class；
- `ao.class` 是否存在；
- `http.class` 是否存在；
- `ao.a(js, boolean): HttpConnection` 中 `iload_2; ifeq` 的直连目标；
- 直连目标是 `http.jl(String)`、`http.open(String)` 还是 `Connector.open(String)`；
- HTTP URL 中是否同时存在 `bid=205` 和 `bid=342`；
- 仍会被公网隔离规则改写的常量；
- JAR 签名文件。

不要按固定常量池下标或固定 class 长度识别；应解析 Owner、Name、Descriptor 和控制流关系。

### 3. 配置分类

建议至少提供三种配置：

#### `mobileqq-12.0.16-http-helper`

条件：版本为 12.0.16，存在 `http.class`，`ao` 直连分支调用 `http.jl(String)` 或已经调用 `http.open(String)`。

操作：

1. 必要时把唯一的 `http.jl(String)` Methodref 改为 `http.open(String)`；
2. 把 `http.open(String)` 方法体替换为直接 `Connector.open(String)`；
3. 把 `ao` 方法中原有的 `iload_2` 改为 `iconst_0`，保留原 `ifeq`、分支目标和全部字节码偏移；
4. 可在检测到 `bid=205/342` 后执行群网页重定向。

#### `mobileqq-12.0.16-connector-direct`

条件：版本为 12.0.16，`ao` 直连分支已经调用 `Connector.open(String)`。

操作：

1. 跳过 `http.jl -> http.open`；
2. 不要求存在 `http.class`；
3. 仍将 `ao` 的 `iload_2` 改成 `iconst_0`，强制走现有直连分支；
4. 可在检测到 `bid=205/342` 后执行群网页重定向。

#### `generic-tcp-core`

条件：存在一个或多个 `socket://...:14000`，但没有命中完整支持的 HTTP 布局。

操作：

1. 只替换 TCP 14000 地址；
2. 不修改未知方法引用或字节码控制流；
3. 不强制要求 `http.class`、`ao.class` 或 `bid=205/342`；
4. 使用局域网保护规则禁用其余公网入口；
5. 输出必须标记为 `experimental-tcp`，明确说明协议未验证。

### 4. TCP 地址替换

将每个严格匹配以下形式的常量替换为本机网关：

```text
socket://<旧主机>:14000
```

必须至少替换一次，否则拒绝生成。不要只替换第一个地址；不同客户端通常带有 6～10 个备用节点。

### 5. 公网隔离和补丁后审计

补丁结束后再次遍历所有 class 常量池和 Manifest：

- 允许 `127.0.0.1`、`localhost` 和本次指定的局域网主机；
- 其余带协议的 HTTP/Socket 地址、裸 IPv4、QQ 域名改为不可用的本地地址；
- 再运行一次相同分析；如果仍发现规则可识别的公网常量，则拒绝打包。

这一步不能因为“没有找到可改地址”而失败；零处修改可能表示输入本来已经是局域网封闭状态。真正的验收标准是补丁后的残留数为零。

### 6. JAR/JAD 生成

1. JAR 第一条 ZIP 条目应为 `META-INF/MANIFEST.MF`。
2. JAD 去掉旧的 `MIDlet-Jar-URL` 和 `MIDlet-Jar-Size`，写入新文件名和精确字节数。
3. 输出显示输入/输出 SHA-256、Manifest 版本、配置 ID、支持级别、替换数量和警告。
4. 生成失败时不得留下看似成功的新产物。

## 安全边界

- “找不到固定 Methodref”应触发重新分类，而不是静默忽略所有检查。
- 对未知版本只能改常量池中的网络地址，不能猜测字节码偏移。
- 修改 opcode 时必须保持原指令长度和 CLDC 预计算 StackMap 可达性；当前做法用同为 1 字节的 `iconst_0` 替换 `iload_2`。
- 所有“应恰好出现一次”的断言仍应保留在命中的具体配置内。
- 不要把私有 JAR、解包后的原版 class、生成 JAR、真实 token、日志或数据库加入 Git、发布包或在线服务。
- 注入器兼容只代表 JAR 能被安全修改；旧客户端的登录、好友、群组和消息协议仍需网关端逐版本适配。

## 验收清单

另一项目完成移植后至少执行：

1. 两种 12.0.16 布局均能生成，且分别命中正确配置；
2. 直连版不再要求 `http.class`；
3. QQ2010、09.0.60、QQ2008 可以生成 `experimental-tcp`，且不会修改未知 HTTP 控制流；QQ2008 输出必须带 ID 31 已知风险警告；
4. 每个输入中的全部 `socket://...:14000` 都被替换；
5. 补丁后公网审计为零；
6. Manifest 是 JAR 第一条目；
7. JAD 的 `MIDlet-Jar-Size` 与 JAR 实际大小一致；
8. 两种完整支持版中 `ao` 目标位置变为 `iconst_0; ifeq`；
9. 签名 JAR、无 Manifest JAR、无 TCP 14000 入口 JAR均能给出明确错误；
10. 运行项目原有全部测试，确认没有破坏旧的已支持样本。

## 当前验证结论

本项目已用上表六个本地样本完成端到端打包验证：两种 12.0.16 命中完整配置，另外四种命中实验性 TCP 配置。所有输出均通过 Manifest 首条目、JAD 大小和补丁后公网地址检查。真机测试进一步确认除 QQ2008 外的五个样本可用；QQ2008 12.05.2 登录失败并显示 ID 31。注入成功与协议兼容必须继续作为两个独立结论。
