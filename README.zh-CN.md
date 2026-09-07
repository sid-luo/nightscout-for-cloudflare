![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

[English](README.md) | **简体中文**

> **独立测试分支：NSCF 1.3.0-beta.1 / Nightscout 15.0.8。**
> 请使用独立 Worker、地址和数据空间，参照[测试说明](docs/testing/NIGHTSCOUT_15_0_8.md)。
> 下方快速安装器和一键部署链接仍安装正式版。


> ### 🚀 [打开快速安装器](https://ns.sidluo.com/)
>
> 无需 GitHub，无需命令行，直接部署到你自己的 Cloudflare 账号。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

这个仓库提供一种快速、免费的方式，把
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) 部署到
Cloudflare。它在 Cloudflare 免费套餐额度内运行，不需要付费服务器或
MongoDB 服务。它是独立的非官方移植版，不是 Nightscout 官方发布。

Nightscout for Cloudflare 版本：**1.3.0-beta.1**

Nightscout 上游版本：**15.0.8**

本项目保留官方 Nightscout 的页面、布局、图表、插件、翻译和计算逻辑，只增加
Cloudflare 平台适配层。

## 为什么做这个项目

Nightscout 是一个伟大的项目。作为多年的用户，我希望更多人能简单、快速、免费地部署和使用 Nightscout。

## 现在已经能做什么

- Nightscout 绝大部分常用功能已经实现
- 首页、血糖曲线、趋势箭头、状态信息和设置页面可以正常使用
- v1、v2、v3 的常用读写 API 已经实现

## 1.2.0 更新内容

- 减少 AAPS 同步时的重复读取，降低数据库开销。
- 新增中英文网页升级流程，保留原数据、地址、密码和设置。
- 改善升级提示和失败重试，修复授权跳转与实例检查问题。

详细变化、测试结果和发布进度见[更新日志](CHANGELOG.zh-CN.md)。

## 使用方法

### 一、首次安装

- **方法一：使用[快速安装器](https://ns.sidluo.com/)（推荐）。** 按照页面提示完成安装。
- **方法二：使用 GitHub 提供的一键安装。** 详情请参照[初次部署教程](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started)。

### 二、升级

目前仅支持通过**快速安装器**部署的实例升级。打开[升级页面](https://ns.sidluo.com/sj/)，连接原 Cloudflare 账号，选择已有实例并确认升级。

升级保留原数据、地址、密码和设置。不要用“新安装”代替升级，新安装会创建另一个实例。

通过 GitHub 一键部署的实例暂不支持一键升级。


## Nightscout 与 Nightscout for Cloudflare

Nightscout for Cloudflare 是 Nightscout 的独立、非官方 Cloudflare
移植版本。Nightscout 上游版本和移植版本使用各自独立的版本号：

- Nightscout 上游版本：**15.0.8**
- Nightscout for Cloudflare 版本：**1.3.0-beta.1**

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
