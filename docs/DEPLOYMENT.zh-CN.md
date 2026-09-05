# Nightscout for Cloudflare 部署与首次使用

[English](DEPLOYMENT.md) | **简体中文**

本文只说明当前版本如何部署、如何验证以及已知限制。开发过程和每一轮版本记录
由 Git 历史保存，不再堆放在用户文档中。

## 当前发布状态

- Nightscout for Cloudflare 版本：`1.1.1-beta`
- Nightscout 上游版本：`15.0.7`
- 部署平台：Cloudflare Workers Free
- 存储：SQLite Durable Object
- 页面：官方 Nightscout 页面
- 数据：全新实例为空，需要连接用户自己的数据源
- 发布状态：适合新建实例测试，尚未宣称完整上游等价或正式生产可用

已经在全新的 Cloudflare 账号上验证过源码部署、Profile 保存、Admin 登录、
测试数据写入、官方首页图表以及远程 API/实时协议测试。还需要在仓库公开后完成
一次普通用户点击 Deploy 按钮的完整验收，并由用户完成真实 AAPS/Loop 测试。

## Nightscout 管理工具名称对照

Nightscout for Cloudflare 使用 SQLite Durable Objects 替代 MongoDB。原版
Admin Tools 的对应功能仍然保留，但实际操作的是 SQLite 数据。管理页面只调整
以下四个标题文字；这份文档保留原版名称对照，方便配合原版 Nightscout 教程
使用：

| 原版 Nightscout 名称 | Nightscout for Cloudflare 名称 |
| --- | --- |
| Clean Mongo status database | Device status maintenance（设备状态维护） |
| Clean Mongo treatments database | Treatment records maintenance（治疗记录维护） |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance（血糖记录维护） |
| Remove future items from mongo database | Future-dated records maintenance（未来时间记录维护） |

这些工具会真实删除对应记录。删除前应确认数据类型和时间范围，并保留所需备份。

## Cloudflare 会创建什么

一次 NSCF 部署只使用：

1. 一个 Cloudflare Worker；
2. 一份 Workers Static Assets；
3. 两个 SQLite Durable Object 命名空间：主数据与实时协议使用的
   `EntryStore`，以及默认关闭的独立 Dexcom Share Connector；
4. 一个明文 Worker 变量：`API_SECRET`。

不会创建 D1、R2、KV、Queues、自定义域名或 Cloudflare Zone 路由。

## 一键部署

Cloudflare 的 Deploy to Cloudflare 功能要求源仓库是公开仓库。仓库公开后，点击
项目 README 顶部的按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

部署页面只需要填写一项：

### `API_SECRET`

这串字符后续会用于授权，请记住它。部署后在 Nightscout 网页、AAPS 或其他
数据源中使用同一个值。

用户可以在部署页面调整 GitHub 仓库副本名称、Worker 名称和资源名称。完成授权
后，Cloudflare 会构建源码、创建声明的资源并部署 Worker。

Cloudflare 官方说明：

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Deploy 按钮支持环境变量和 Secrets](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/)

## 更新已有部署

先查看[更新日志](../CHANGELOG.zh-CN.md)，再确认最初的安装方式。GitHub 上的源码更新
不会自动替所有用户升级实例。

| 最初的安装方式 | 当前升级方式 |
| --- | --- |
| GitHub 上的 Deploy to Cloudflare 按钮 | 符合条件的源码部署可按下面的方法重新构建 |
| 网页快速安装器 | 尚无升级已有实例的网页入口；重新安装会新建实例 |
| 本地 Git／Wrangler | 使用本文末尾的本地更新流程 |

### 通过 Deploy to Cloudflare 按钮安装的实例

Cloudflare Deploy 按钮创建的是用户自己的独立 Git 仓库，不是 GitHub Fork，
因此不会自动出现 `Sync fork`，导入过程也不会保留项目提供的 GitHub Actions
更新工作流。新部署改用 Cloudflare 自己的构建记录更新：

1. 在 Cloudflare Dashboard 中打开现有 Worker；
2. 进入 `Deployments`，点击 `View build history`；
3. 打开最近一次成功构建；
4. 点击 `Retry build`。

`npm run build` 会识别 Workers Builds 提供的 `WORKERS_CI` 环境以及 Cloudflare
创建的单提交源码副本，然后把官方 `main` 拉取到临时目录。构建使用官方最新版
源码，同时保留生成仓库中的 Worker 名称、明文 `API_SECRET` 和 Cloudflare
自动生成的资源标识。更新只发生在一次性的 Cloudflare 构建目录中，不会向用户
GitHub 仓库写入内容。

下载、依赖安装、源码构建或 Wrangler 部署任何一步失败时，新版本不会成为活动
部署，当前 Worker 和 Durable Object 数据继续运行原版本。

为了避免覆盖用户开发工作，自动更新默认只对只有一个 `source repo import`
提交的部署副本启用。用户仓库增加自定义 Git 提交后，构建使用用户自己的源码。
只有确定允许 Cloudflare 构建忽略这些自定义提交时，才添加构建变量
`NSCF_AUTO_UPDATE=1`。

在此构建更新器发布前创建的旧副本，需要最后重新部署一次或手动初始化。包含
更新器后，以后只需 `Retry build`。

### 通过网页快速安装器安装的实例

网页快速安装器直接上传发布包，不使用上述 Git 源码构建流程，因此不能通过
`Retry build` 套用上述升级方法。目前安装器只负责新建实例，尚未提供升级已有实例
的入口。

重新运行快速安装器会创建独立的新实例，不会升级原来的 Worker，也不会自动迁移
原数据库。请保留已有实例与数据；网页升级功能发布后，其适用范围和操作步骤会在
[更新日志](../CHANGELOG.zh-CN.md)说明。

## 第一次打开

全新实例没有 Profile。第一次打开首页时自动跳转到 `/profile/` 是官方
Nightscout 的正常流程。

1. 滚动到 Profile Editor 底部。
2. 点击 **(Authenticate)**。
3. 输入部署时设置的 `API_SECRET`。
4. 在自己的设备上勾选 **Remember this device**。
5. 点击 **Authenticate**。
6. 根据需要修改名称、时区和单位。默认 `Default` 与 `UTC` 也可以直接保存。
7. 点击 **Save**。
8. 确认页面显示 `Status: success`，然后返回首页。

如果关闭 Profile Editor 后又回到同一页面：

- 检查底部是否仍显示 `Unauthorized`
- 确认输入的是部署时设置的原始密码
- 确认密码没有多余的前后空格
- 重新点击 **Authenticate**，成功后再点 **Save**

这通常是认证未完成，不是 Profile 必填字段缺失，也不是 Cloudflare
Durable Object 无法保存。

## 修改 API_SECRET

用户以后可以自行修改：

1. 打开 Cloudflare Dashboard。
2. 进入 **Workers & Pages**。
3. 选择自己的 NSCF Worker。
4. 打开 **Settings → Variables and Secrets**。
5. 编辑 `API_SECRET`，类型保持为 **Text**。
6. 保存并等待新版本部署完成。
7. 在 Nightscout 网页、AAPS 和其他上传端改成同一个值。

其他显示、认证、API 与插件变量见
[配置与高级功能](CONFIGURATION.zh-CN.md)。

## Dexcom Share（Beta，高级用户）

此功能默认关闭，不影响普通部署。需要使用时，在 Cloudflare Dashboard 的
**Settings → Variables and Secrets** 中手动添加：

- `ENABLE`：保留现有值并加入 `connect`
- `CONNECT_SOURCE`：`dexcomshare`
- `CONNECT_SHARE_ACCOUNT_NAME`：Dexcom Share 账号
- `CONNECT_SHARE_PASSWORD`：Dexcom Share 密码
- `CONNECT_SHARE_REGION`：`us`

美国以外的 Dexcom Share 账号把 `CONNECT_SHARE_REGION` 改为 `ous`。协议和模拟
服务测试已经完成，真实账号社区验收尚未完成。

保存变量并等待部署完成后，打开 Nightscout 首页（或 `/admin/`）一次以启动
Connector。此后它通过独立 Durable Object alarm 定时拉取数据。

完整变量、Secret 类型和状态检查方法见
[配置与高级功能](CONFIGURATION.zh-CN.md)。

## 本地或命令行部署

建议使用 Node.js 22 LTS 或更新版本。

```sh
git clone https://github.com/sid-luo/nightscout-for-cloudflare.git
cd nightscout-for-cloudflare
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
```

登录 Cloudflare：

```sh
npx wrangler login
```

部署后在 Cloudflare Dashboard 的 **Settings → Variables and Secrets** 中填写
明文 `API_SECRET`。

确认本地测试全部通过后部署：

```sh
npm run deploy
```

本地开发时新建 `.dev.vars`：

```sh
touch .dev.vars
```

在 `.dev.vars` 中填写本地测试密码：

```dotenv
API_SECRET=choose-your-own-password
```

启动：

```sh
npm run dev
```

打开 <http://localhost:8787/>。

## 部署后检查

### 普通页面

- `/healthz` 返回正常状态和 Nightscout `v15.0.7`
- `/profile/` 能认证并保存 Profile
- `/admin/` 在记住认证后能加载 Subjects、Roles 和数据维护工具
- `/admin/` 的四个数据维护标题不再使用 MongoDB 名称
- 数据维护工具实际操作 SQLite Durable Objects，不依赖 MongoDB
- `/food/` 能打开并完成一条测试记录的创建和删除
- `/report/` 能打开报告页面
- 连接自己的数据源后，首页能显示当前血糖、趋势箭头和曲线

### API

- v1 Status 和 Entries 读取正常
- v2 Status、Properties 和 Summary 读取正常
- v3 能取得 JWT，并对所需集合完成授权读写
- EIO3/EIO4 polling、WebSocket 和实时 `dataUpdate` 正常

项目自带的远程检查命令：

```sh
npm run smoke:public -- https://your-worker.workers.dev
```

不要只以“页面能打开”作为兼容完成的证据。API、授权、实时连接和持久化必须分别
检查。

## AAPS 或 Loop 验收

当前代码已经覆盖常见 AAPS、AndroidAPS 和 Loop 数据形状与协议契约，但正式
发布前仍需要用户在自己的测试环境完成真实客户端验收。

建议先做最小测试：

1. 在客户端填写新的 NSCF 地址和自己设置的 `API_SECRET`。
2. 只启用数据上传，不立即改变现有治疗或闭环设置。
3. 确认最新血糖、Device Status 和 Treatments 出现在 NSCF。
4. 确认时间、时区、单位、Profile 和趋势一致。
5. 确认断网后恢复上传不会丢失或错误重复普通记录。
6. 完成观察后再决定是否进入更完整的闭环兼容测试。

NSCF 不新增剂量算法，也不修改客户端的治疗逻辑。

## 当前限制

- 不提供旧 MongoDB 多年历史数据的一键迁移
- 任意 Mongo 查询和无限量读取不保证兼容
- API 和批量写入有适合 Workers Free 的明确上限
- Engine.IO 二进制包尚未适配
- 少量 Node.js 动态服务端插件和第三方集成仍待适配
- 公开 Deploy 按钮和真实闭环设备仍待最终用户验收
- 当前 `1.1.1-beta` 不应承载正式医疗数据

完整差距见 [UPSTREAM_COMPATIBILITY.md](UPSTREAM_COMPATIBILITY.md)。

## 删除和重新测试

删除 Worker 不一定等于已经明确删除对应 Durable Object 命名空间中的全部存储
数据。若要验证完全干净的新用户流程，最简单可靠的方法是：

- 使用新的 Cloudflare 测试账号；或
- 使用新的 Worker 和 Durable Object 命名空间名称。

通过 Durable Object migration 删除类命名空间会永久删除其中的数据，只有在
确认不再需要任何内容时才应执行。参见 Cloudflare 的
[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。

## 更新

更新代码前先备份或保留现有实例，然后：

```sh
git pull
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

部署后仍应重新执行页面和 API 检查。
