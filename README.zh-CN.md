![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

[English](README.md) | **简体中文**

将 Nightscout 部署到自己的 Cloudflare 账号，无需单独租用服务器或 MongoDB。项目使用 Cloudflare Workers 与 SQLite Durable Objects，保留 Nightscout 的主要页面、图表、插件和计算行为，并为 Cloudflare 适配存储、同步和后台任务。

这是独立、非官方的开源移植项目。实际费用取决于所选 Cloudflare 套餐和用量，优化不会提高平台额度。

> **当前版本：NSCF 1.3.0-beta.2 · 基于 Nightscout 15.0.8。**
>
> 1.3 仍是测试版。快速安装器与下方 GitHub 一键部署按钮均提供 **1.3.0-beta.2**，快速安装器支持符合条件的 1.2.0 原站升级。详见[Beta 发布说明](https://github.com/sid-luo/nightscout-for-cloudflare/releases/tag/v1.3.0-beta.2)；此前正式版保留在 [v1.2.0](https://github.com/sid-luo/nightscout-for-cloudflare/tree/v1.2.0)。

> ### 🚀 [打开快速安装器](https://ns.sidluo.com/)
>
> 无需 GitHub，无需命令行，按页面提示部署到自己的 Cloudflare 账号。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

## 为什么做这个项目

Nightscout 是一个伟大的项目。作为多年的用户，我希望更多人能简单、快速、低成本地部署和使用 Nightscout。

## 现在已经能做什么

- 使用 Nightscout 首页、血糖曲线、趋势箭头、状态信息、时钟、报表和设置页面。
- 通过常用 v1、v2、v3 API 与实时连接同步数据，支持 AAPS／NSClientV3 常见上传流程。
- 在 Admin Tools 中管理记录，按日期预览和清理血糖、治疗及设备状态，保留指定数量的 Profile。
- 按需启用数据来源与 Webhook；新增接入默认关闭，真实第三方兼容范围仍在验证。

## 1.3 Beta 更新了什么

### 跟进官方 Nightscout 15.0.8

以下对照[官方 15.0.8 发布说明](https://github.com/nightscout/cgm-remote-monitor/releases/tag/v15.0.8)。**“已适配”表示已有对应代码与专项验证，不表示所有客户端、设备和真实账号都已验收。**

| 官方更新 | NSCF 1.3 Beta 的完成情况 |
| --- | --- |
| 日期范围清理、Profile 清理 | 已适配；按 Profile 时区预览并分批处理，保留已完成数量。 |
| GMI／Revised GMI、报表与时区修复 | 已适配；覆盖单位换算、固定时差和夏令时日界线。 |
| AAPS 临时基础率图表、OpenAPS 预测、历史 COB、BWP | 已适配并有专项回归；特定控制器场景仍需真实使用对照。 |
| 时钟表情、单位和旧趋势箭头、翻译 | 已同步客户端，并适配 Worker 趋势处理；已有组件和语言检查。 |
| 写入文本清洗、输出保护、API3 筛选和身份校验 | 已适配；保留 NSCF 更严格的请求容量限制。 |
| 分屏、配置来源 CSP、可选同源嵌入限制 | 已适配；同源限制按设置启用。 |
| Dexcom Connect、旧 BRIDGE 配置、Nightscout-source、LibreLinkUp、Glooko | 已有 Cloudflare 实现和模拟测试；新增来源默认关闭，真实账号流程待验收。 |
| 新血糖 Webhook、去重和重试 | 已有持久化任务及模拟测试；默认关闭，真实接收端待验收。 |
| 依赖与测试更新 | 同步实际使用的客户端和清洗依赖，扩充 Workers 测试；没有照搬整套 Node 服务端。 |
| Docker、MongoDB、文件挂载密钥、服务器监听地址 | 不适用于 Workers 架构；使用 Cloudflare 存储与变量配置。 |

### 我们额外修复和优化了什么

**进一步减少 AAPS 同步的重复读写。** 沿用 1.2.0 的读取优化，补上“新血糖到达后，紧接着 AAPS 上传设备状态”仍会重复读历史的场景。缓存随记录变化更新，减少空轮询和连接保活时的重复查询，并移除两个冗余索引。

| 同一组本地合成数据 | 1.3 Beta 优化前 | 优化后 |
| --- | ---: | ---: |
| 一次新血糖＋随后一次 AAPS 状态：读取行数 | 6,128 | 102 |
| 同一组合：写入行数 | 45 | 42 |
| 10,000 条设备状态完整补传：写入行数 | 160,001 | 150,001 |

组合场景读取减少约 **98.3%**。这是同一组数据在本次 Beta 优化前后的对比，**不是正式版 1.2.0 与 1.3 的直接测量，也不代表全天用量降幅**。记录、历史同步和上传确认保留；缓存不会把旧血糖标成新数据，也不增加每秒访问服务器的外部任务。

**补齐缓存与数据库的一致性处理。** 写入失败时丢弃相应缓存副本，避免数据库已回滚而内存留下未成功的数据；已有数据库激活时避免重复扫描历史索引。

**修复报表计算和显示。** 处理首条血糖重复计数、同时间戳重复记录、RMS 漏算末条、单点和空小时的无效结果，保留小时均值的小数，跳过空蜡烛图数据。

**修复跨日和报表加载。** 保留选中的数据集，按 Profile 所在时区的下一次午夜取数，正确处理夏令时 23／25 小时日期；查询失败时清除旧结果并允许修正条件后重试。

**补充 Cloudflare 接入边界。** 规范 Nightscout 来源地址，处理超大响应和无效日期，持久保存同步进度与 Webhook 重试状态；测试版构建不会自动切回正式源码。

**修复原站升级确认与旧实例识别。** 解决程序已经更新后，升级页仍显示“尚未确认”的问题；兼容部分旧快速部署实例在更新 Cloudflare 设置后丢失安装标记的情况。升级继续核对原实例和原数据库，保留地址、数据、设置及原密钥。

1.2.0 已发布的基础读取优化、网页升级入口和授权跳转修复继续保留，不重复列为本次新增功能。

## 测试进度

- 最新缓存修订：**95 个 Workers 测试文件、991 项测试通过**，类型、构建和上游映射检查通过。
- 此前 15.0.8 适配：355 项官方客户端测试通过、162 项官方服务端插件测试通过；两项上游原有跳过用例仍保留记录，不能宣称全套上游测试通过。
- 报表：13 项官方模块测试、33 项覆盖层测试，另有合成数据下 11 个报表视图的浏览器验证。
- AAPS：已使用虚拟泵验证上传确认、实时回推与手机队列归零，并观察跨日上传和数据库用量；不扩展为全部真实泵、Loop 或第三方服务均已验收。
- 安装与升级：2026-09-15 在独立 Cloudflare 实例上使用合成数据，验证 1.2.0 原站升级保留地址、原数据库、记录及修订历史、设置和原密钥；成功响应丢失后可恢复，重复完成请求不会再次上传。新装 Beta 的认证读写通过，安装器共 **172 项测试通过**，并完成类型检查和双语构建检查；这些检查与 991 项应用测试分开统计。

Beta 仍有待处理项：内部任务偶发连接中断及一次未定位程序异常；超过 48 小时无血糖后的断更提醒缺口。第三方真实接入与受控断网补传也仍需继续验证。完整测试范围保留在[测试记录](docs/testing/NIGHTSCOUT_15_0_8.md)。

## 使用方法

### 一、首次安装

使用[快速安装器](https://ns.sidluo.com/)部署 **1.3.0-beta.2**，无需 GitHub 或命令行。

也可以使用 GitHub 一键部署按钮，从 `main` 部署 **1.3.0-beta.2**，操作见[首次部署教程](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started)。

### 二、升级

通过快速安装器部署的 1.2.0 实例，可在[升级页面](https://ns.sidluo.com/sj/)授权原账号、选择实例并确认升级至 **1.3.0-beta.2**。升级保留原网址、数据、设置和原密钥，AAPS 继续使用原配置；不会自动升级其他实例。

GitHub 一键部署或无法识别的实例不适用此通道。若原 `API_SECRET` 使用 Cloudflare Secret，页面会提示先将同一个原值保存为普通文本，再重新检查升级。

### 三、API 密钥

后续新部署和升级统一使用 Cloudflare 后台可查看、可修改的普通文本 `API_SECRET`。升级保留原密钥值，不自动生成新密码。网站继续使用 HTTPS，客户端认证方式不变；明文变量不应写进公开源码。现有实例不需要为此单独调整。

## Nightscout 与 Nightscout for Cloudflare

Nightscout for Cloudflare 是 Nightscout 的独立、非官方 Cloudflare
移植版本。Nightscout 上游版本和移植版本使用各自独立的版本号：

- Nightscout 上游版本：**15.0.8**
- Nightscout for Cloudflare 版本：**1.3.0-beta.2**

原版 Admin Tools 的对应功能仍然保留，但本项目使用 SQLite Durable Objects
存储数据，而不是 MongoDB。因此，页面中的部分名称会调整为与实际存储方式无关
的名称，避免用户误以为部署中仍然存在 MongoDB。

| 原版 Nightscout 名称 | Nightscout for Cloudflare 名称 |
| --- | --- |
| Clean Mongo status database | Device status maintenance（设备状态维护） |
| Clean Mongo treatments database | Treatment records maintenance（治疗记录维护） |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance（血糖记录维护） |
| Remove future items from mongo database | Future-dated records maintenance（未来时间记录维护） |

## 技术文档

- [配置与高级功能](docs/CONFIGURATION.zh-CN.md)
- [Cloudflare 架构](docs/ARCHITECTURE.md)
- [上游兼容性矩阵](docs/UPSTREAM_COMPATIBILITY.md)

## 安全说明

Nightscout for Cloudflare 是独立、非官方的开源社区项目，不是 Nightscout 官方
版本，也不提供有保证的技术或医疗支持。本项目没有获得任何用于糖尿病治疗的正式
批准或监管认可。自行部署者需要自行负责构建、配置、安全、维护和运行，并自行
承担使用风险。

Nightscout for Cloudflare 需要正常的网络连接和可用的 Cloudflare 服务。不得把
它作为了解血糖数值或趋势的唯一方式，也不得将其作为诊断、治疗或胰岛素剂量决定
的依据。应为意外故障做好准备，并始终保留独立检查血糖的方法。

以上说明沿用 [Nightscout 官方安全指引](https://nightscout.github.io/) 的结构和核心原则。

## License and attribution

这个项目使用 `AGPL-3.0-only`。Nightscout 上游工作的权利归原贡献者所有。参见
`LICENSE`、`NOTICE.md`，以及保留的
`vendor/nightscout/COPYRIGHT` 和 `vendor/nightscout/LICENSE`。
