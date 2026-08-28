![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

[English](README.md) | **简体中文**

> ### 🚀 [打开快速安装器](https://ns.sidluo.com/)
>
> 无需 GitHub，无需命令行，直接部署到你自己的 Cloudflare 账号。

昵称：**Nightscout 泡面版**（The Instant Noodle Edition）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

这个仓库提供一种快速、免费的方式，把
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) 部署到
Cloudflare。它在 Cloudflare 免费套餐额度内运行，不需要付费服务器或
MongoDB 服务。它是独立的非官方移植版，不是 Nightscout 官方发布。

当前 Nightscout for Cloudflare 版本：**1.1.1-beta**

Nightscout 上游版本：**15.0.7**

本项目保留官方 Nightscout 的页面、布局、图表、插件、翻译和计算逻辑，只增加
Cloudflare 平台适配层。

## 为什么做这个项目

Nightscout 是一个很伟大的项目，我们曾经可以在 Heroku 免费部署，那已经是
很久以前的事情了。而 Cloudflare 堪称赛博大善人，但它并不支持 MongoDB。

Nightscout 已经提供了非常好的泡面，但是没有叉子和开水（曾经有）。这个项目
提供了一把叉子，并且把开水（Cloudflare）递到你面前。只需要点击几下，一个
泡面的时间，你就可以得到一个 Nightscout。

## 现在已经能做什么

- Nightscout 绝大部分常用功能已经实现
- 首页、血糖曲线、趋势箭头、状态信息和设置页面可以正常使用
- v1、v2、v3 的常用读写 API 已经实现

## 使用方法

- [打开快速安装器](https://ns.sidluo.com/)
- [初次部署教程](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started)

## Nightscout 与 Nightscout for Cloudflare

Nightscout for Cloudflare 是 Nightscout 的独立、非官方 Cloudflare
移植版本。Nightscout 上游版本和移植版本使用各自独立的版本号：

- Nightscout 上游版本：**15.0.7**
- Nightscout for Cloudflare 版本：**1.1.1-beta**

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
- [部署与首次使用](docs/DEPLOYMENT.zh-CN.md)
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
