# Nyanya J2ME Client

第一方 Nyanya J2ME 客户端，面向 CLDC 1.1 / MIDP 2.0 设备，通过 Nyanya Protocol v1 连接通用 `gateway/`。它不能连接 `nyanya-gateway-class/`。

## 构建

在工作区根目录执行：

```powershell
npm run build:j2me
```

输出位于：

```text
clients/j2me/dist/QQJ2ME.jar
clients/j2me/dist/QQJ2ME.jad
```

也可以直接运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\clients\j2me\tools\build.ps1
powershell -ExecutionPolicy Bypass -File .\clients\j2me\tools\run-emulator.ps1
```

## 登录

启动通用网关后，在客户端登录页填写 PC 局域网 IP、端口、设备 ID 和 `gateway/config.json` 中的设备 token。设置会保存在 RMS 中。

客户端声明 `text`、`contacts`、`notice`、`offline` 能力。Node 与 J2ME 共同读取 `packages/nyanya-protocol/vectors/v1.tsv`，验证帧字节完全一致。

完整部署步骤见 [使用与配置手册](../../docs/使用与配置手册.md#通用-nyanya-gateway)，协议见 [Nyanya Protocol v1](../../docs/PROTOCOL.md)。

当前仍保留 `QQJ2ME.jar` 和 `QQJ2ME.jad` 产物名称；Java 包名使用项目命名空间 `com.nyanya.qqj2me`。
