# 资源与代码归属

本文记录工作区中复用的代码、工具和外部客户端边界。发布包不包含原版 QQ JAR、class、抓包或反编译提取物。

Nyanya Gateway 项目自身的代码采用 Apache License, Version 2.0，完整文本见根目录 `LICENSE`。下列第三方资源、复用代码和原版客户端仍分别受其自身权利与许可约束。

## J2ME 工具链与工具类

第一方 J2ME 客户端的构建脚本和部分基础工具类源自用户已有的 `j2me大模型` 项目，该项目使用 Apache License 2.0，Copyright 2026 huayuechenfeng。

复用内容包括：

- ECJ、CLDC/MIDP API、ProGuard 和 MicroEmulator 的构建参数与脚本结构；
- `Json.java`、`JsonStreamWriter.java`、`Utf8.java`、`Base64.java`、`Crc32.java`；
- `ImageDimensions.java`、`ImageReferenceParser.java`、`ImageScaler.java`；
- `ByteLineReader.java`。

这些文件已经迁入 `clients/j2me/` 并按当前包名调整。完整许可文本见根目录 `THIRD-PARTY-LICENSE.txt`。

## 旧 QQ 兼容协议

`nyanya-gateway-class/legacy/` 的 QQ-TEA、JCE/WUP、旧命令编解码、媒体服务、存储和部分管理逻辑，以及 `nyanya-gateway-class/tools/` 中的 J2ME JAR 补丁器，复用自用户自有的“老手机 QQ 复活计划”，并为当前发布结构与 NapCat/OneBot 后端做了接入改造。

原版 MobileQQ、Symbian QQ 及其资源版权属于各自权利人。本项目只提供兼容网关代码和研究接口，不在源码仓库或发布包中分发这些客户端。

## 本项目实现

- `gateway/`：第一方 Nyanya TCP 接入、鉴权和应用组装；
- `packages/nyanya-protocol/`：Nyanya Protocol v1、能力协商和黄金向量；
- `packages/onebot-adapter/`：NapCat/OneBot WebSocket 上联；
- `packages/gateway-core/`：协议无关的领域模型、路由、限频和投递接口；
- `clients/j2me/`：Nyanya J2ME MIDlet、界面、RMS 和网络层；
- `nyanya-gateway-class/`：旧 QQ 客户端与共享核心之间的兼容适配。

## 发布要求

公开发布时必须保留 `LICENSE`、本文件与 `THIRD-PARTY-LICENSE.txt`，并继续排除本机配置、账号 token、运行数据库、日志以及没有再分发授权的原版客户端文件。
