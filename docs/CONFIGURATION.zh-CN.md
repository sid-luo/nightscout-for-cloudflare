# Nightscout for Cloudflare 配置与高级功能

[English](CONFIGURATION.md) | **简体中文**

本文说明 Nightscout for Cloudflare（NSCF）当前实际支持的 Worker 环境变量，
以及 AAPS、OpenAPS、Pump、Loop 和 Dexcom Share 等高级功能的配置方法。

NSCF 保留 Nightscout 15.0.7 的主要页面、插件和接口，但运行环境已经从
Node.js、Express 和 MongoDB 改为 Cloudflare Workers 与 SQLite Durable
Objects。因此，不应把原版 Nightscout 的全部环境变量直接复制到 NSCF。

本文只列出当前 NSCF 代码已经读取和适配的变量。变量来源以
[`src/status.ts`](../src/status.ts)、[`src/index.ts`](../src/index.ts)、
[`src/dexcom-share.ts`](../src/dexcom-share.ts) 和相应的测试为准。

## 在 Cloudflare 中添加变量

打开 Cloudflare Dashboard，然后进入：

1. **Workers & Pages**
2. 选择自己的 NSCF Worker
3. **Settings**
4. **Variables and Secrets**
5. 点击 **Add**
6. 填写变量名称和值
7. 点击 **Deploy**

普通开关、显示选项和数值使用 **Text**。密码、令牌和私钥应使用
**Secret**。Secret 保存后无法在 Dashboard 中再次查看，但 Worker 读取方式
与普通变量相同。

Cloudflare 官方文档：

- [Environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

> 一键部署流程当前会把 `API_SECRET` 创建为 Text 变量。不要把它写入公开仓库，
> 也不要与其他账号共用。手动添加的 Dexcom Share 密码和 APNs 私钥应使用
> Secret。

本地开发使用项目根目录下的 `.dev.vars`，不要把它提交到 Git：

```dotenv
API_SECRET=choose-a-long-unique-password
```

## 最小配置

一键部署只要求一个变量：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `API_SECRET` | 是 | 无 | Nightscout 网页、上传端和管理接口使用的密码，至少 12 个字符 |

部署后先打开 `/profile/`，使用 `API_SECRET` 完成认证并保存 Profile。没有数据源
时，新实例不会自动产生血糖数据。

## 默认显示与基础行为

| 变量 | 默认值 | 可用值或格式 | 作用 |
| --- | --- | --- | --- |
| `DISPLAY_UNITS` | 优先使用当前 Profile；没有 Profile 时为 `mg/dl` | `mg/dl`、`mmol/L`、`mmol` | 设置默认血糖单位 |
| `LANGUAGE` | `en` | 例如 `zh_cn`、`zh_tw`、`en` | 设置 Nightscout 页面默认语言 |
| `DAY_START` | `7` | `0`–`24` | 日间开始时间，供安静时段等功能使用 |
| `DAY_END` | `21` | `0`–`24` | 日间结束时间 |
| `SHOW_PLUGINS` | 由 Nightscout 默认组合生成 | 空格分隔的插件名 | 控制首页显示哪些已启用插件 |
| `SHOW_FORECAST` | `ar2` | 例如 `ar2 openaps loop` | 控制首页显示哪些预测曲线 |
| `FOCUS_HOURS` | `3` | 小时数 | 首页默认聚焦的时间范围 |
| `SHOW_CLOCK_DELTA` | `false` | `true`、`false`、`on`、`off` | Clock 页面是否显示血糖变化值 |
| `SHOW_CLOCK_LAST_TIME` | `false` | `true`、`false`、`on`、`off` | Clock 页面是否显示最后读数时间 |
| `HEARTBEAT` | `60` | 秒；NSCF 限制在 15 秒至 24 小时 | 后台插件重新检查与重复提醒间隔 |
| `ADMIN_NOTIFIES_ENABLED` | `true` | `true`、`false`、`on`、`off` | 是否保留 Nightscout Admin 通知 |

`LANGUAGE=zh_cn` 使用简体中文，`LANGUAGE=zh_tw` 使用繁体中文。若语言代码无效，
Nightscout 会回退到英文。

`SHOW_PLUGINS` 和 `SHOW_FORECAST` 只控制显示，不会启用插件。插件必须先出现在
`ENABLE` 或 Nightscout 默认启用列表中。

示例：

```dotenv
DISPLAY_UNITS=mmol/L
LANGUAGE=zh_cn
DAY_START=7
DAY_END=23
SHOW_PLUGINS=dbsize openaps pump iob cob
SHOW_FORECAST=openaps
```

### Split View

`/split` 页面可以显示最多 8 个 Nightscout 视图。每一格使用一对变量：

| 变量 | 说明 |
| --- | --- |
| `FRAME_URL_1` … `FRAME_URL_8` | 对应视图加载的 URL |
| `FRAME_NAME_1` … `FRAME_NAME_8` | 对应视图显示的名称 |

这些变量只把默认值传给浏览器。它们不会让 Worker 在后台请求这些 URL，也不会
产生定时任务或数据库写入。

### 嵌入保护（15.0.8）

`ALLOW_UNRESTRICTED_FRAME_EMBEDDING` 与官方 15.0.8 一样默认 `true`。
设为 `false` 或 `off` 后，返回 `X-Frame-Options: SAMEORIGIN` 和强制生效的
CSP `frame-ancestors 'self'`，只允许同源网页嵌入。`true`／`on`、未设置或
无效值保留兼容默认值。它控制哪些网页能嵌入本站；`FRAME_URL_n` 独立控制
本站分屏页面加载什么内容。更广泛的 `SECURE_CSP*` 服务器配置仍不属于本移植范围。

## 功能开关

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ENABLE` | 空 | 添加可选功能，使用空格分隔 |
| `DISABLE` | 空 | 关闭默认功能，使用空格分隔 |

NSCF 保留的 Nightscout 默认功能包括：

```text
bgnow delta direction timeago devicestatus upbat errorcodes profile
bolus dbsize runtimestate basal careportal
```

预测告警默认使用 `ar2`。设置任意 `BG_*` 阈值后，默认改为
`simplealarms`。也可以通过 `ALARM_TYPES` 明确选择。

常见可选功能：

```text
rawbg iob cob bwp pump openaps loop xdripjs cage sage iage bage
boluscalc connect
```

示例：

```dotenv
ENABLE=openaps pump iob cob
DISABLE=upbat
```

不要把 `aaps` 加入 `ENABLE`。AAPS 是连接 Nightscout API 的客户端，不是
Nightscout 插件。

## 血糖阈值与告警类型

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALARM_TYPES` | 未设置 `BG_*` 时为 `predict`，否则为 `simple` | 可填 `predict`、`simple` 或 `predict simple` |
| `BG_HIGH` | `260` | 紧急高血糖阈值 |
| `BG_TARGET_TOP` | `180` | 目标范围上限 |
| `BG_TARGET_BOTTOM` | `80` | 目标范围下限 |
| `BG_LOW` | `55` | 紧急低血糖阈值 |
| `AR2_CONE_FACTOR` | `2` | AR2 预测锥宽度；`0` 显示单线 |

阈值单位跟随 `DISPLAY_UNITS`。使用 mmol/L 时可以直接填写 mmol/L 数值：

```dotenv
DISPLAY_UNITS=mmol/L
ALARM_TYPES=simple
BG_HIGH=14.4
BG_TARGET_TOP=10
BG_TARGET_BOTTOM=4.4
BG_LOW=3.1
```

NSCF 会按照 Nightscout 规则检查阈值顺序，避免上下限互相重叠。

浏览器告警开关和暂缓选项使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALARM_URGENT_HIGH` | `true` | 是否启用紧急高血糖告警 |
| `ALARM_URGENT_HIGH_MINS` | `30 60 90 120` | 紧急高血糖可选暂缓分钟数 |
| `ALARM_HIGH` | `true` | 是否启用高血糖告警 |
| `ALARM_HIGH_MINS` | `30 60 90 120` | 高血糖可选暂缓分钟数 |
| `ALARM_LOW` | `true` | 是否启用低血糖告警 |
| `ALARM_LOW_MINS` | `15 30 45 60` | 低血糖可选暂缓分钟数 |
| `ALARM_URGENT_LOW` | `true` | 是否启用紧急低血糖告警 |
| `ALARM_URGENT_LOW_MINS` | `15 30 45` | 紧急低血糖可选暂缓分钟数 |
| `ALARM_URGENT_MINS` | `30 60 90 120` | 其他紧急告警的暂缓分钟数 |
| `ALARM_WARN_MINS` | `30 60 90 120` | 其他警告的暂缓分钟数 |

这些变量调整已有告警的开关和暂缓选择，不会提高后台检查频率。是否运行具体后台
告警仍由相应插件的 `*_ENABLE_ALERTS` 控制。

时间过久告警使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ALARM_TIMEAGO_WARN` | `true` | 是否启用数据过旧警告 |
| `ALARM_TIMEAGO_WARN_MINS` | `15` | 警告分钟数 |
| `ALARM_TIMEAGO_URGENT` | `true` | 是否启用数据过旧紧急告警 |
| `ALARM_TIMEAGO_URGENT_MINS` | `30` | 紧急告警分钟数 |
| `TIMEAGO_ENABLE_ALERTS` | `false` | 是否让后台通知引擎产生 Time Ago 提醒 |

## 认证与 API

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUTH_DEFAULT_ROLES` | `readable` | 未登录访问者的默认角色 |
| `AUTH_FAIL_DELAY` | `5000` | 认证失败延迟，单位毫秒；NSCF 限制为 0–60000 |
| `API3_MAX_LIMIT` | `1000` | API v3 单次查询上限；可以调低，不能高于 1000 |
| `UUID_HANDLING` | `true` | 保留 AAPS、Loop、Trio 等客户端的 UUID 标识并用于去重 |
| `PREDICTIONS_MAX_SIZE` | `288` | Device Status 中每类预测数组的最大长度；`0` 表示不裁剪 |

`AUTH_DEFAULT_ROLES` 常用值：

- `readable`：未登录用户可以读取 Nightscout；
- `status-only`：未登录用户只能读取状态接口；
- `denied`：所有数据访问都要求凭据。

在把它改成 `denied` 前，应先确认网页、AAPS、Loop 和其他上传端已经能够使用
`API_SECRET` 或 Access Token 正常连接。

`PREDICTIONS_MAX_SIZE=0` 会保留完整预测数组，但也可能显著增加
Device Status、实时消息和 API 响应体积。

## AAPS / AndroidAPS

AAPS 通过 Nightscout v1 或 v3 API 与 NSCF 通信，不需要 `AAPS_*` 环境变量，也
不需要在 `ENABLE` 中加入 `aaps`。

基本连接信息：

```text
Nightscout URL: https://你的-worker.workers.dev
API secret:     与 NSCF 的 API_SECRET 相同
```

使用 v3 的 AAPS 版本也可以使用 Nightscout Admin 中创建的 Subject、Role 和
Access Token。具体采用 `API_SECRET` 还是 Access Token，取决于客户端版本和
NSClient 设置。

AAPS 3.4 的
[Nightscout 手动配置说明](https://androidaps.readthedocs.io/en/latest/SettingUpAaps/Nightscout.html#manual-nightscout-setup)
为原版 Nightscout 推荐以下配置：

```dotenv
ENABLE=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pushover pump openaps
DEVICESTATUS_ADVANCED=true
SHOW_FORECAST=openaps
PUMP_FIELDS=reservoir battery clock
PUMP_WARN_BATT_P=51
PUMP_URGENT_BATT_P=26
SHOW_PLUGINS=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pushover pump openaps
```

其中你可能记得的“推荐打开的变量”就是：

```dotenv
DEVICESTATUS_ADVANCED=true
```

它让原版 Nightscout 的浏览器保留和合并更完整的 Device Status 数据，供
OpenAPS、Pump 等插件和回顾视图使用。Nightscout 15.0.7 实际已经默认将
`extendedSettings.devicestatus.advanced` 设为 `true`，AAPS 文档仍明确要求配置
这个变量。

NSCF 已经适配 AAPS 使用的 Entries、Treatments、Device Status、Profile、v1/v3
API，以及 OpenAPS/Pump 的存储、实时更新和回顾数据路径。
`DEVICESTATUS_ADVANCED` 已进入 Worker 配置映射，并且与 Nightscout 15.0.7
一样默认为 `true`。它只改变浏览器合并 Device Status 的方式，不会改变上传、
保留时间、后台检查频率或 alarm 数量。

AAPS 官方组合中的 `pushover` 也不应直接放进 NSCF 的可用示例：NSCF 已保留内部
通知和 Pushover 消息协议，但外部 Pushover 发送通道目前没有接通。

当前 NSCF 建议使用：

```dotenv
ENABLE=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pump openaps
DEVICESTATUS_ADVANCED=true
SHOW_FORECAST=openaps
PUMP_FIELDS=reservoir battery clock
PUMP_WARN_BATT_P=51
PUMP_URGENT_BATT_P=26
SHOW_PLUGINS=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pump openaps
```

建议：

1. 保持 `UUID_HANDLING=true`；
2. 第一次连接只开启上传或同步测试；
3. 确认 Entries、Treatments、Device Status 和 Profile 都能写入；
4. 检查单位、时区、趋势和去重结果；
5. 再测试断网恢复和批量补传。

AAPS 负责治疗和闭环逻辑。NSCF 只保存、展示和转发客户端上传的数据，不替 AAPS
计算或推荐胰岛素剂量。

## OpenAPS

OpenAPS 插件展示上传端写入 Device Status 的 OpenAPS 状态、IOB、预测曲线和
循环时间。它不会在 NSCF 中运行 OpenAPS 算法。

基础配置：

```dotenv
ENABLE=openaps
SHOW_PLUGINS=openaps
SHOW_FORECAST=openaps
```

可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAPS_ENABLE_ALERTS` | `false` | OpenAPS 长时间未循环时产生后台告警 |
| `OPENAPS_WARN` | `30` | 未循环警告分钟数 |
| `OPENAPS_URGENT` | `60` | 未循环紧急告警分钟数 |
| `OPENAPS_FIELDS` | `status-symbol status-label iob meal-assist rssi` | 当前视图显示字段 |
| `OPENAPS_RETRO_FIELDS` | 同上 | 回顾视图显示字段 |
| `OPENAPS_PRED_IOB_COLOR` | `#1e88e5` | IOB 预测线颜色 |
| `OPENAPS_PRED_COB_COLOR` | `#FB8C00` | COB 预测线颜色 |
| `OPENAPS_PRED_ACOB_COLOR` | `#FB8C00` | ACOB 预测线颜色 |
| `OPENAPS_PRED_ZT_COLOR` | `#00d2d2` | ZT 预测线颜色 |
| `OPENAPS_PRED_UAM_COLOR` | `#c9bd60` | UAM 预测线颜色 |
| `OPENAPS_COLOR_PREDICTION_LINES` | `true` | 是否分别使用上述颜色 |

`OPENAPS_ENABLE_ALERTS=true` 只启用 NSCF 内部的告警状态和实时 `/alarm`
发布。当前版本没有连接外部 Pushover/IFTTT 发送通道。

## Pump

Pump 插件显示上传端提供的储药量、电池、时钟、状态和设备信息。

```dotenv
ENABLE=pump
SHOW_PLUGINS=pump
```

可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUMP_ENABLE_ALERTS` | `false` | 启用泵状态后台告警 |
| `PUMP_WARN_ON_SUSPEND` | `false` | 泵暂停时是否告警 |
| `PUMP_FIELDS` | `reservoir` | 当前视图显示字段 |
| `PUMP_RETRO_FIELDS` | `reservoir battery` | 回顾视图显示字段 |
| `PUMP_WARN_CLOCK` | `30` | 泵时钟数据过旧警告分钟数 |
| `PUMP_URGENT_CLOCK` | `60` | 泵时钟数据过旧紧急分钟数 |
| `PUMP_WARN_RES` | `10` | 剩余胰岛素警告阈值，单位 U |
| `PUMP_URGENT_RES` | `5` | 剩余胰岛素紧急阈值，单位 U |
| `PUMP_WARN_BATT_P` | `30` | 电池百分比警告阈值 |
| `PUMP_URGENT_BATT_P` | `20` | 电池百分比紧急阈值 |
| `PUMP_WARN_BATT_V` | `1.35` | 电池电压警告阈值 |
| `PUMP_URGENT_BATT_V` | `1.3` | 电池电压紧急阈值 |
| `PUMP_WARN_BATT_QUIET_NIGHT` | `false` | 夜间是否抑制电池警告 |

夜间判断使用 Profile 的时区以及 `DAY_START`、`DAY_END`。Profile 没有有效时区
时，夜间静默不会启用。

## Loop

Loop 插件显示 iOS Loop 上传的循环状态和预测数据：

```dotenv
ENABLE=loop
SHOW_PLUGINS=loop
SHOW_FORECAST=loop
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOOP_ENABLE_ALERTS` | `false` | Loop 长时间未循环时产生后台告警 |
| `LOOP_WARN` | `30` | 未循环警告分钟数 |
| `LOOP_URGENT` | `60` | 未循环紧急告警分钟数 |

### Loop APNs 远程通知

只有需要使用 Nightscout 原版 Loop APNs 远程通知路径时，才添加以下变量：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `LOOP_APNS_KEY` | Secret | Apple APNs `.p8` 私钥的完整 PEM 内容 |
| `LOOP_APNS_KEY_ID` | Text | APNs Key ID |
| `LOOP_DEVELOPER_TEAM_ID` | Text | 10 位 Apple Developer Team ID |
| `LOOP_PUSH_SERVER_ENVIRONMENT` | Text | TestFlight 等生产配置填写 `production`；否则使用沙盒 |

该路径可以传输用户发起的远程 Override、Carbs 和 Bolus 等 Loop 消息。NSCF
不会自动计算剂量，但错误的远程配置仍可能产生实际治疗影响。启用前应在隔离测试
环境验证 Apple Team、Bundle Identifier、设备 Token、权限和消息内容。

## Dexcom Share（Beta）

Dexcom Share Connector 默认关闭，并使用独立 Durable Object 和 alarm 拉取
数据。当前只支持 `dexcomshare`，不支持把原版 Nightscout 文档中的其他
`CONNECT_SOURCE` 直接照搬过来。

配置：

```dotenv
ENABLE=connect
CONNECT_SOURCE=dexcomshare
CONNECT_SHARE_ACCOUNT_NAME=your-account
CONNECT_SHARE_PASSWORD=your-password
CONNECT_SHARE_REGION=us
```

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ENABLE` | Text | 空 | 必须包含 `connect` |
| `CONNECT_SOURCE` | Text | 无 | 必须为 `dexcomshare` |
| `CONNECT_SHARE_ACCOUNT_NAME` | Secret | 无 | Dexcom Share 账号 |
| `CONNECT_SHARE_PASSWORD` | Secret | 无 | Dexcom Share 密码 |
| `CONNECT_SHARE_REGION` | Text | `us` | 美国填 `us`，美国以外通常填 `ous` |

保存并完成部署后，打开首页 `/` 或 `/admin/` 一次以启动 Connector。之后
Connector 会通过独立 alarm 定时运行。

注意：

- 只在默认 tenant 中运行；
- 账号或密码最长 1024 个字符；
- 单次响应和回看时间受到 Workers 安全边界限制；
- 可以通过受 Admin 权限保护的 `/_nscf/connect/status` 查看状态；
- 模拟协议测试已经覆盖，但真实 Dexcom Share 账号仍应自行验收。

## 其他已适配插件变量

### Basal、Bolus 与 Profile 显示

这些变量只控制官方浏览器页面的默认显示：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BASAL_RENDER` | `none` | `none`、`default` 或 `icicle` |
| `BOLUS_RENDER_OVER` | `0` | 超过此剂量时使用普通 Bolus 标签格式 |
| `BOLUS_RENDER_FORMAT` | `default` | `hidden`、`default`、`concise` 或 `minimal` |
| `BOLUS_RENDER_FORMAT_SMALL` | `default` | 小剂量 Bolus 的标签格式 |
| `PROFILE_HISTORY` | `false` | 是否显示实验性的 Profile 历史入口 |
| `PROFILE_MULTIPLE` | `false` | 是否显示多 Profile 处理与切换入口 |

它们不会修改 Profile、Treatment 或胰岛素数据，也不会产生后台任务。

### Uploader Battery

启用插件名：`upbat`（默认启用）。

| 变量 | 默认值 |
| --- | --- |
| `UPBAT_WARN` | `30` |
| `UPBAT_URGENT` | `20` |
| `UPBAT_ENABLE_ALERTS` | `false` |

### xDrip-js

启用插件名：`xdripjs`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XDRIPJS_ENABLE_ALERTS` | `false` | 启用 CGM 状态与电池提醒 |
| `XDRIPJS_WARN_BAT_V` | `300` | 发射器电池电压警告阈值 |
| `XDRIPJS_STATE_NOTIFY_INTRVL` | `0.5` | 相同状态提醒间隔，单位小时 |

### Error Codes

启用插件名：`errorcodes`（默认启用）。

| 变量 | 默认值 |
| --- | --- |
| `ERRORCODES_INFO` | `1 2 3 4 5 6 7 8` |
| `ERRORCODES_WARN` | `off` |
| `ERRORCODES_URGENT` | `9 10` |

这些变量接受空格分隔的错误码；字符串 `off` 表示关闭对应级别。

### IOB、COB 与 Bolus Wizard Preview

`iob` 和 `cob` 依赖有效 Profile 与 Treatment 数据，没有单独的环境变量。

Bolus Wizard Preview 使用：

| 变量 | 默认值 |
| --- | --- |
| `BWP_SNOOZE` | `0.10` |
| `BWP_WARN` | `0.50` |
| `BWP_URGENT` | `1.00` |
| `BWP_SNOOZE_MINS` | `10` |

BWP 只保留 Nightscout 原版的展示、提醒和告警暂缓逻辑。显示内容不能作为胰岛素
剂量建议。

### 耗材与电池年龄

相应插件名为 `cage`、`sage`、`iage` 和 `bage`。

| 插件 | 变量 | 默认值 |
| --- | --- | --- |
| CAGE | `CAGE_INFO` / `CAGE_WARN` / `CAGE_URGENT` | `44` / `48` / `72` 小时 |
| CAGE | `CAGE_DISPLAY` | `hours` |
| CAGE | `CAGE_ENABLE_ALERTS` | `false` |
| SAGE | `SAGE_INFO` / `SAGE_WARN` / `SAGE_URGENT` | `144` / `164` / `166` 小时 |
| SAGE | `SAGE_ENABLE_ALERTS` | `false` |
| IAGE | `IAGE_INFO` / `IAGE_WARN` / `IAGE_URGENT` | `44` / `48` / `72` 小时 |
| IAGE | `IAGE_ENABLE_ALERTS` | `false` |
| BAGE | `BAGE_INFO` / `BAGE_WARN` / `BAGE_URGENT` | `312` / `336` / `360` 小时 |
| BAGE | `BAGE_DISPLAY` | `days` |
| BAGE | `BAGE_ENABLE_ALERTS` | `false` |

### Treatment Notify

启用插件名：`treatmentnotify`。启用 `careportal` 时，Nightscout 会自动加入该
插件。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TREATMENTNOTIFY_SNOOZE_MINS` | `10` | Treatment 后暂缓告警的分钟数 |
| `TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER` | `0` | 只包含达到该剂量的手动 Meal/Correction Bolus |

### Database Size

`dbsize` 默认启用。NSCF 读取的是当前 tenant SQLite 数据和索引占用，不是
MongoDB `db.stats()`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DBSIZE_MAX` | Cloudflare Free 单个对象边界，约 `953.67` MiB | 用于百分比显示 |
| `DBSIZE_WARN_PERCENTAGE` | `60` | 黄色警告百分比 |
| `DBSIZE_URGENT_PERCENTAGE` | `75` | 红色紧急百分比 |
| `DBSIZE_ENABLE_ALERTS` | `false` | 是否产生数据库空间提醒 |
| `DBSIZE_IN_MIB` | `false` | 是否直接显示 MiB |

Cloudflare 配额可能变化，实际限制以
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
为准。

## 更新器变量

这些是 Cloudflare 构建变量，不是 Nightscout 页面设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NSCF_AUTO_UPDATE` | 自动判断 | `1` 强制构建时拉取官方源码；`0` 禁止自动拉取 |
| `NSCF_UPSTREAM_URL` | 官方 NSCF 仓库 | 开发或镜像场景使用的源码地址 |
| `NSCF_UPSTREAM_BRANCH` | `main` | 开发或镜像场景使用的分支 |

`WORKERS_CI`、`WORKERS_CI_BUILD_UUID` 和 `WORKERS_CI_COMMIT_SHA` 由 Cloudflare
Workers Builds 提供，普通用户不要手动设置。

## 当前不要直接照搬的 Nightscout 原版变量

以下变量或类别属于原版 Node.js/MongoDB 部署，或尚未通过 NSCF Worker
配置边界，不应仅因为它们出现在上游 README 中就添加：

- `MONGODB_URI`、`MONGO_*`、`STORAGE_URI`
- `PORT`、`HOSTNAME`、`SSL_KEY`、`SSL_CERT`、`SSL_CA`
- `IMPORT_CONFIG`
- `BRIDGE_*`、`MMCONNECT_*`
- `CONNECT_SOURCE=nightscout`、`glooko`、`linkup`、`minimedcarelink`
- Pushover、Maker/IFTTT 等外部发送凭据
- `DEVICESTATUS_DAYS`，因为扩大 Device Status 窗口可能显著增加响应和实时消息体积
- `DE_NORMALIZE_DATES`、`AUTHENTICATION_PROMPT_ON_LOAD`
- `OBSCURED`、`OBSCURE_DEVICE_PROVENANCE`
- `CORS_ALLOW_ORIGIN`、`INSECURE_USE_HTTP`、`SECURE_CSP*`、`SECURE_HSTS*`
- `BASE_URL`、已弃用的 `TREATMENTS_AUTH`、`ALARM_PUMP_BATTERY_LOW`
- 任意没有列在本文中的通用 `PLUGIN_NAME_*` 扩展变量

部分页面偏好仍可在 Nightscout 浏览器设置界面中保存。要增加新的服务器端变量，
应先在 NSCF 的 request-local Settings/Plugin adapter 中实现并加入测试，而不是
只在 Cloudflare Dashboard 中创建同名变量。

## 配置后如何验证

每次新增或修改变量后：

1. 等待新 Worker 版本部署完成；
2. 打开 `/api/v1/status.json` 检查单位、语言、启用插件与扩展设置；
3. 打开首页确认插件和预测线是否显示；
4. 对上传端执行一条测试写入；
5. 检查刷新页面和实时连接后数据仍然存在；
6. 启用告警前，用测试数据验证阈值和时间；
7. Dexcom Share 可在认证后检查 `/_nscf/connect/status`。

不要只根据变量已经出现在 Cloudflare Dashboard 中就判断配置生效。最终以状态
接口、页面行为、API 读写和持久化结果为准。
