# Nightscout for Cloudflare Configuration and Advanced Features

**English** | [简体中文](CONFIGURATION.zh-CN.md)

This guide covers the Worker environment variables currently supported by
Nightscout for Cloudflare (NSCF), including configuration for AAPS, OpenAPS,
Pump, Loop, and Dexcom Share.

NSCF preserves the main pages, plugins, and APIs from Nightscout 15.0.7, but
replaces Node.js, Express, and MongoDB with Cloudflare Workers and SQLite
Durable Objects. Do not copy every environment variable from a standard
Nightscout deployment into NSCF.

This document lists only variables that the current NSCF code reads and
adapts. The authoritative implementation is in
[`src/status.ts`](../src/status.ts), [`src/index.ts`](../src/index.ts),
[`src/dexcom-share.ts`](../src/dexcom-share.ts), and their tests.

## Adding variables in Cloudflare

Open the Cloudflare Dashboard, then:

1. Select **Workers & Pages**.
2. Select your NSCF Worker.
3. Open **Settings**.
4. Open **Variables and Secrets**.
5. Click **Add**.
6. Enter the variable name and value.
7. Click **Deploy**.

Use **Text** for ordinary switches, display preferences, and numeric values.
Use **Secret** for passwords, tokens, and private keys. A Secret cannot be
viewed again in the Dashboard after it is saved, but the Worker reads it in
the same way as a Text variable.

Cloudflare documentation:

- [Environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

> The deploy button currently creates `API_SECRET` as a Text variable. Never
> commit it to a public repository or reuse it across accounts. Dexcom Share
> passwords and APNs private keys added manually should be Secrets.

For local development, use `.dev.vars` in the project root and do not commit
it to Git:

```dotenv
API_SECRET=choose-a-long-unique-password
```

## Minimum configuration

The deploy button requires only one variable:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `API_SECRET` | Yes | None | Password used by the Nightscout UI, upload clients, and administration APIs; must be at least 12 characters |

After deployment, open `/profile/`, authenticate with `API_SECRET`, and save a
Profile. A new instance does not create glucose data by itself when no data
source is connected.

## Default display and basic behavior

| Variable | Default | Accepted value or format | Purpose |
| --- | --- | --- | --- |
| `DISPLAY_UNITS` | Current Profile, or `mg/dl` when no Profile exists | `mg/dl`, `mmol/L`, or `mmol` | Default glucose unit |
| `LANGUAGE` | `en` | For example `zh_cn`, `zh_tw`, or `en` | Default Nightscout UI language |
| `DAY_START` | `7` | `0`–`24` | Start of daytime, used by quiet-hour features |
| `DAY_END` | `21` | `0`–`24` | End of daytime |
| `SHOW_PLUGINS` | Generated from Nightscout defaults | Space-separated plugin names | Plugins shown on the main page |
| `SHOW_FORECAST` | `ar2` | For example `ar2 openaps loop` | Forecast lines shown on the main page |
| `FOCUS_HOURS` | `3` | Number of hours | Default focused time range on the main page |
| `SHOW_CLOCK_DELTA` | `false` | `true`, `false`, `on`, or `off` | Show the glucose delta on the Clock page |
| `SHOW_CLOCK_LAST_TIME` | `false` | `true`, `false`, `on`, or `off` | Show the last reading time on the Clock page |
| `HEARTBEAT` | `60` | Seconds; NSCF limits this to 15 seconds–24 hours | Interval for background plugin checks and repeated notifications |
| `ADMIN_NOTIFIES_ENABLED` | `true` | `true`, `false`, `on`, or `off` | Keep Nightscout Admin notifications enabled |

Use `LANGUAGE=zh_cn` for Simplified Chinese or `LANGUAGE=zh_tw` for
Traditional Chinese. Nightscout falls back to English when the language code
is invalid.

`SHOW_PLUGINS` and `SHOW_FORECAST` control display only. They do not enable a
plugin; the plugin must also be present in `ENABLE` or in Nightscout's default
plugin set.

Example:

```dotenv
DISPLAY_UNITS=mmol/L
LANGUAGE=en
DAY_START=7
DAY_END=23
SHOW_PLUGINS=dbsize openaps pump iob cob
SHOW_FORECAST=openaps
```

### Split View

The `/split` page can display up to eight Nightscout views. Each view uses one
pair of variables:

| Variable | Purpose |
| --- | --- |
| `FRAME_URL_1` … `FRAME_URL_8` | URL loaded by the corresponding view |
| `FRAME_NAME_1` … `FRAME_NAME_8` | Name displayed for the corresponding view |

These variables only provide browser defaults. They do not make the Worker
fetch the URLs in the background and do not create scheduled tasks or
database writes.

### Framing protection (15.0.8)

`ALLOW_UNRESTRICTED_FRAME_EMBEDDING` defaults to `true`, matching upstream
15.0.8. Set `false` or `off` to send `X-Frame-Options: SAMEORIGIN` and the enforced
CSP `frame-ancestors 'self'`. `true`/`on`, missing and invalid values preserve the
compatibility default. This controls who may embed this instance; `FRAME_URL_n`
independently controls what the Split View loads. The broader `SECURE_CSP*`
server settings remain outside this Workers adapter.

## Feature switches

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE` | Empty | Add optional features, separated by spaces |
| `DISABLE` | Empty | Disable default features, separated by spaces |

Nightscout features enabled by default in NSCF include:

```text
bgnow delta direction timeago devicestatus upbat errorcodes profile
bolus dbsize runtimestate basal careportal
```

Prediction alarms use `ar2` by default. Setting any `BG_*` threshold changes
the default to `simplealarms`. You can also select the alarm type explicitly
with `ALARM_TYPES`.

Common optional features:

```text
rawbg iob cob bwp pump openaps loop xdripjs cage sage iage bage
boluscalc connect
```

Example:

```dotenv
ENABLE=openaps pump iob cob
DISABLE=upbat
```

Do not add `aaps` to `ENABLE`. AAPS is a client that connects to the
Nightscout API, not a Nightscout plugin.

## Glucose thresholds and alarm types

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALARM_TYPES` | `predict` without `BG_*`, otherwise `simple` | `predict`, `simple`, or `predict simple` |
| `BG_HIGH` | `260` | Urgent-high threshold |
| `BG_TARGET_TOP` | `180` | Upper target-range threshold |
| `BG_TARGET_BOTTOM` | `80` | Lower target-range threshold |
| `BG_LOW` | `55` | Urgent-low threshold |
| `AR2_CONE_FACTOR` | `2` | AR2 prediction-cone width; `0` displays a single line |

Thresholds use the unit selected by `DISPLAY_UNITS`. With mmol/L, enter mmol/L
values directly:

```dotenv
DISPLAY_UNITS=mmol/L
ALARM_TYPES=simple
BG_HIGH=14.4
BG_TARGET_TOP=10
BG_TARGET_BOTTOM=4.4
BG_LOW=3.1
```

NSCF validates the threshold order using Nightscout's rules so the high and
low ranges cannot overlap.

Browser alarm switches and snooze choices use:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALARM_URGENT_HIGH` | `true` | Enable urgent-high alarms |
| `ALARM_URGENT_HIGH_MINS` | `30 60 90 120` | Urgent-high snooze choices in minutes |
| `ALARM_HIGH` | `true` | Enable high alarms |
| `ALARM_HIGH_MINS` | `30 60 90 120` | High snooze choices in minutes |
| `ALARM_LOW` | `true` | Enable low alarms |
| `ALARM_LOW_MINS` | `15 30 45 60` | Low snooze choices in minutes |
| `ALARM_URGENT_LOW` | `true` | Enable urgent-low alarms |
| `ALARM_URGENT_LOW_MINS` | `15 30 45` | Urgent-low snooze choices in minutes |
| `ALARM_URGENT_MINS` | `30 60 90 120` | Snooze choices for other urgent alarms |
| `ALARM_WARN_MINS` | `30 60 90 120` | Snooze choices for other warnings |

These variables adjust existing alarm switches and snooze choices. They do
not increase the background check frequency. A background plugin alarm still
requires its corresponding `*_ENABLE_ALERTS` switch.

Stale-data alarms use:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALARM_TIMEAGO_WARN` | `true` | Enable stale-data warnings |
| `ALARM_TIMEAGO_WARN_MINS` | `15` | Warning age in minutes |
| `ALARM_TIMEAGO_URGENT` | `true` | Enable urgent stale-data alarms |
| `ALARM_TIMEAGO_URGENT_MINS` | `30` | Urgent age in minutes |
| `TIMEAGO_ENABLE_ALERTS` | `false` | Allow the background notification engine to generate Time Ago alerts |

## Authentication and API

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_DEFAULT_ROLES` | `readable` | Default roles for unauthenticated visitors |
| `AUTH_FAIL_DELAY` | `5000` | Authentication-failure delay in milliseconds; NSCF limits it to 0–60000 |
| `API3_MAX_LIMIT` | `1000` | Maximum API v3 query limit; may be reduced but not raised above 1000 |
| `UUID_HANDLING` | `true` | Preserve UUIDs from AAPS, Loop, Trio, and similar clients and use them for deduplication |
| `PREDICTIONS_MAX_SIZE` | `288` | Maximum length of each prediction array in Device Status; `0` disables trimming |

Common `AUTH_DEFAULT_ROLES` values:

- `readable`: unauthenticated visitors can read Nightscout data.
- `status-only`: unauthenticated visitors can only read status endpoints.
- `denied`: every data request requires credentials.

Before changing the value to `denied`, confirm that the UI, AAPS, Loop, and
other upload clients can connect with `API_SECRET` or an Access Token.

`PREDICTIONS_MAX_SIZE=0` preserves complete prediction arrays but may
substantially increase Device Status records, real-time messages, and API
response sizes.

## AAPS / AndroidAPS

AAPS communicates with NSCF through the Nightscout v1 or v3 API. It does not
need an `AAPS_*` environment variable, and `aaps` must not be added to
`ENABLE`.

Basic connection information:

```text
Nightscout URL: https://your-worker.workers.dev
API secret:     the same value as NSCF's API_SECRET
```

AAPS versions using v3 can also use a Subject, Role, and Access Token created
in Nightscout Admin. Whether to use `API_SECRET` or an Access Token depends on
the AAPS version and NSClient configuration.

The AAPS 3.4
[manual Nightscout setup guide](https://androidaps.readthedocs.io/en/latest/SettingUpAaps/Nightscout.html#manual-nightscout-setup)
recommends the following for standard Nightscout:

```dotenv
ENABLE=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pushover pump openaps
DEVICESTATUS_ADVANCED=true
SHOW_FORECAST=openaps
PUMP_FIELDS=reservoir battery clock
PUMP_WARN_BATT_P=51
PUMP_URGENT_BATT_P=26
SHOW_PLUGINS=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pushover pump openaps
```

The recommended variable you may remember is:

```dotenv
DEVICESTATUS_ADVANCED=true
```

In standard Nightscout, this keeps and merges more complete Device Status data
in the browser for OpenAPS, Pump, and retrospective views. Nightscout 15.0.7
already defaults `extendedSettings.devicestatus.advanced` to `true`, but the
AAPS guide still sets it explicitly.

NSCF supports the Entries, Treatments, Device Status, Profile, v1, and v3 API
paths used by AAPS, as well as OpenAPS/Pump storage, real-time updates, and
retrospective data. `DEVICESTATUS_ADVANCED` is mapped into the Worker settings
and defaults to `true`, matching Nightscout 15.0.7. It only changes how the
browser merges Device Status data; it does not alter uploads, retention,
background check frequency, or the number of alarms.

Do not copy `pushover` from the AAPS example into the NSCF recommendation.
NSCF preserves the internal notification and Pushover message protocol, but
its external Pushover delivery channel is not currently connected.

Recommended NSCF configuration:

```dotenv
ENABLE=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pump openaps
DEVICESTATUS_ADVANCED=true
SHOW_FORECAST=openaps
PUMP_FIELDS=reservoir battery clock
PUMP_WARN_BATT_P=51
PUMP_URGENT_BATT_P=26
SHOW_PLUGINS=careportal boluscalc food bwp cage sage iage iob cob basal dbsize pump openaps
```

Recommended validation:

1. Keep `UUID_HANDLING=true`.
2. Test upload or synchronization alone on the first connection.
3. Confirm that Entries, Treatments, Device Status, and Profile can all be written.
4. Check units, timezone, trends, and deduplication.
5. Then test recovery after an offline period and batched backfill.

AAPS owns treatment and closed-loop logic. NSCF only stores, displays, and
forwards client-uploaded data; it does not calculate or recommend insulin
doses.

## OpenAPS

The OpenAPS plugin displays OpenAPS status, IOB, predictions, and loop time
uploaded through Device Status. It does not run the OpenAPS algorithm inside
NSCF.

Basic configuration:

```dotenv
ENABLE=openaps
SHOW_PLUGINS=openaps
SHOW_FORECAST=openaps
```

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAPS_ENABLE_ALERTS` | `false` | Generate a background alarm when OpenAPS has not looped recently |
| `OPENAPS_WARN` | `30` | Warning age in minutes |
| `OPENAPS_URGENT` | `60` | Urgent age in minutes |
| `OPENAPS_FIELDS` | `status-symbol status-label iob meal-assist rssi` | Fields shown in the current view |
| `OPENAPS_RETRO_FIELDS` | Same as above | Fields shown in retrospective view |
| `OPENAPS_PRED_IOB_COLOR` | `#1e88e5` | IOB prediction-line color |
| `OPENAPS_PRED_COB_COLOR` | `#FB8C00` | COB prediction-line color |
| `OPENAPS_PRED_ACOB_COLOR` | `#FB8C00` | ACOB prediction-line color |
| `OPENAPS_PRED_ZT_COLOR` | `#00d2d2` | ZT prediction-line color |
| `OPENAPS_PRED_UAM_COLOR` | `#c9bd60` | UAM prediction-line color |
| `OPENAPS_COLOR_PREDICTION_LINES` | `true` | Use the individual colors above |

`OPENAPS_ENABLE_ALERTS=true` only enables NSCF's internal alarm state and
real-time `/alarm` publication. The current release does not connect an
external Pushover or IFTTT delivery channel.

## Pump

The Pump plugin displays reservoir, battery, clock, status, and device data
provided by the upload client.

```dotenv
ENABLE=pump
SHOW_PLUGINS=pump
```

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUMP_ENABLE_ALERTS` | `false` | Enable background pump-status alarms |
| `PUMP_WARN_ON_SUSPEND` | `false` | Alarm while the pump is suspended |
| `PUMP_FIELDS` | `reservoir` | Fields shown in the current view |
| `PUMP_RETRO_FIELDS` | `reservoir battery` | Fields shown in retrospective view |
| `PUMP_WARN_CLOCK` | `30` | Stale pump-clock warning age in minutes |
| `PUMP_URGENT_CLOCK` | `60` | Stale pump-clock urgent age in minutes |
| `PUMP_WARN_RES` | `10` | Reservoir warning threshold in U |
| `PUMP_URGENT_RES` | `5` | Reservoir urgent threshold in U |
| `PUMP_WARN_BATT_P` | `30` | Battery-percentage warning threshold |
| `PUMP_URGENT_BATT_P` | `20` | Battery-percentage urgent threshold |
| `PUMP_WARN_BATT_V` | `1.35` | Battery-voltage warning threshold |
| `PUMP_URGENT_BATT_V` | `1.3` | Battery-voltage urgent threshold |
| `PUMP_WARN_BATT_QUIET_NIGHT` | `false` | Suppress battery warnings at night |

Nighttime detection uses the Profile timezone together with `DAY_START` and
`DAY_END`. Quiet-night suppression is not used when the Profile does not have
a valid timezone.

## Loop

The Loop plugin displays loop status and prediction data uploaded by iOS Loop:

```dotenv
ENABLE=loop
SHOW_PLUGINS=loop
SHOW_FORECAST=loop
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOOP_ENABLE_ALERTS` | `false` | Generate a background alarm when Loop has not looped recently |
| `LOOP_WARN` | `30` | Warning age in minutes |
| `LOOP_URGENT` | `60` | Urgent age in minutes |

### Loop APNs remote notifications

Add these variables only when you need the original Nightscout Loop APNs
remote-notification path:

| Variable | Type | Purpose |
| --- | --- | --- |
| `LOOP_APNS_KEY` | Secret | Full PEM contents of the Apple APNs `.p8` private key |
| `LOOP_APNS_KEY_ID` | Text | APNs Key ID |
| `LOOP_DEVELOPER_TEAM_ID` | Text | 10-character Apple Developer Team ID |
| `LOOP_PUSH_SERVER_ENVIRONMENT` | Text | Use `production` for TestFlight and similar production builds; otherwise use the sandbox |

This path can transmit user-initiated Loop messages such as Override, Carbs,
and Bolus. NSCF does not calculate doses automatically, but an incorrect
remote configuration can still affect real treatment. Validate the Apple
Team, Bundle Identifier, device token, permissions, and message contents in
an isolated test environment before enabling it.

## Dexcom Share (Beta)

The Dexcom Share Connector is disabled by default. It uses a separate Durable
Object and alarm to fetch data. The current implementation supports only
`dexcomshare`; do not copy other `CONNECT_SOURCE` values from the standard
Nightscout documentation.

Configuration:

```dotenv
ENABLE=connect
CONNECT_SOURCE=dexcomshare
CONNECT_SHARE_ACCOUNT_NAME=your-account
CONNECT_SHARE_PASSWORD=your-password
CONNECT_SHARE_REGION=us
```

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `ENABLE` | Text | Empty | Must include `connect` |
| `CONNECT_SOURCE` | Text | None | Must be `dexcomshare` |
| `CONNECT_SHARE_ACCOUNT_NAME` | Secret | None | Dexcom Share account |
| `CONNECT_SHARE_PASSWORD` | Secret | None | Dexcom Share password |
| `CONNECT_SHARE_REGION` | Text | `us` | Use `us` in the United States and usually `ous` elsewhere |

After saving and deploying, open `/` or `/admin/` once to start the Connector.
It then runs on its own alarm schedule.

Important details:

- It runs only in the default tenant.
- Account names and passwords are limited to 1024 characters.
- Worker safety limits restrict individual responses and backfill windows.
- Authenticated Admin users can inspect `/_nscf/connect/status`.
- The simulated protocol is covered by tests, but each real Dexcom Share
  account should be validated by its owner.

## Other supported plugin variables

### Basal, Bolus, and Profile display

These variables only control default display in the official browser UI:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASAL_RENDER` | `none` | `none`, `default`, or `icicle` |
| `BOLUS_RENDER_OVER` | `0` | Use the normal Bolus label format above this dose |
| `BOLUS_RENDER_FORMAT` | `default` | `hidden`, `default`, `concise`, or `minimal` |
| `BOLUS_RENDER_FORMAT_SMALL` | `default` | Label format for small Boluses |
| `PROFILE_HISTORY` | `false` | Show the experimental Profile-history entry |
| `PROFILE_MULTIPLE` | `false` | Show multiple-Profile handling and switching |

They do not modify Profile, Treatment, or insulin data and do not create
background tasks.

### Uploader Battery

Plugin name: `upbat` (enabled by default).

| Variable | Default |
| --- | --- |
| `UPBAT_WARN` | `30` |
| `UPBAT_URGENT` | `20` |
| `UPBAT_ENABLE_ALERTS` | `false` |

### xDrip-js

Plugin name: `xdripjs`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `XDRIPJS_ENABLE_ALERTS` | `false` | Enable CGM status and battery alerts |
| `XDRIPJS_WARN_BAT_V` | `300` | Transmitter battery-voltage warning threshold |
| `XDRIPJS_STATE_NOTIFY_INTRVL` | `0.5` | Repeat interval for the same state, in hours |

### Error Codes

Plugin name: `errorcodes` (enabled by default).

| Variable | Default |
| --- | --- |
| `ERRORCODES_INFO` | `1 2 3 4 5 6 7 8` |
| `ERRORCODES_WARN` | `off` |
| `ERRORCODES_URGENT` | `9 10` |

These variables accept space-separated error codes. The string `off` disables
the corresponding level.

### IOB, COB, and Bolus Wizard Preview

`iob` and `cob` require valid Profile and Treatment data and have no separate
environment variables.

Bolus Wizard Preview uses:

| Variable | Default |
| --- | --- |
| `BWP_SNOOZE` | `0.10` |
| `BWP_WARN` | `0.50` |
| `BWP_URGENT` | `1.00` |
| `BWP_SNOOZE_MINS` | `10` |

BWP preserves the standard Nightscout display, notification, and alarm-snooze
behavior only. Its display must not be treated as insulin dosing advice.

### Cannula, sensor, insulin, and battery age

The corresponding plugin names are `cage`, `sage`, `iage`, and `bage`.

| Plugin | Variable | Default |
| --- | --- | --- |
| CAGE | `CAGE_INFO` / `CAGE_WARN` / `CAGE_URGENT` | `44` / `48` / `72` hours |
| CAGE | `CAGE_DISPLAY` | `hours` |
| CAGE | `CAGE_ENABLE_ALERTS` | `false` |
| SAGE | `SAGE_INFO` / `SAGE_WARN` / `SAGE_URGENT` | `144` / `164` / `166` hours |
| SAGE | `SAGE_ENABLE_ALERTS` | `false` |
| IAGE | `IAGE_INFO` / `IAGE_WARN` / `IAGE_URGENT` | `44` / `48` / `72` hours |
| IAGE | `IAGE_ENABLE_ALERTS` | `false` |
| BAGE | `BAGE_INFO` / `BAGE_WARN` / `BAGE_URGENT` | `312` / `336` / `360` hours |
| BAGE | `BAGE_DISPLAY` | `days` |
| BAGE | `BAGE_ENABLE_ALERTS` | `false` |

### Treatment Notify

Plugin name: `treatmentnotify`. Nightscout adds it automatically when
`careportal` is enabled.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TREATMENTNOTIFY_SNOOZE_MINS` | `10` | Alarm snooze time after a Treatment, in minutes |
| `TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER` | `0` | Include manual Meal/Correction Boluses at or above this dose |

### Database Size

`dbsize` is enabled by default. NSCF reads the current tenant's SQLite data
and index usage, not MongoDB `db.stats()`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DBSIZE_MAX` | Approx. `953.67` MiB, the Cloudflare Free per-object boundary | Percentage display |
| `DBSIZE_WARN_PERCENTAGE` | `60` | Yellow warning percentage |
| `DBSIZE_URGENT_PERCENTAGE` | `75` | Red urgent percentage |
| `DBSIZE_ENABLE_ALERTS` | `false` | Generate database-space alerts |
| `DBSIZE_IN_MIB` | `false` | Display MiB directly |

Cloudflare quotas may change. Refer to the current
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Updater variables

These are Cloudflare build variables, not Nightscout UI settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NSCF_AUTO_UPDATE` | Detected automatically | `1` forces an upstream source fetch at build time; `0` disables it |
| `NSCF_UPSTREAM_URL` | Official NSCF repository | Source URL for development or mirror deployments |
| `NSCF_UPSTREAM_BRANCH` | `main` | Source branch for development or mirror deployments |

`WORKERS_CI`, `WORKERS_CI_BUILD_UUID`, and `WORKERS_CI_COMMIT_SHA` are provided
by Cloudflare Workers Builds. Ordinary users should not set them manually.

## Standard Nightscout variables not to copy

The following variables or categories belong to a standard
Node.js/MongoDB deployment or have not crossed the NSCF Worker configuration
boundary. Do not add them only because they appear in the upstream README:

- `MONGODB_URI`, `MONGO_*`, and `STORAGE_URI`
- `PORT`, `HOSTNAME`, `SSL_KEY`, `SSL_CERT`, and `SSL_CA`
- `IMPORT_CONFIG`
- `BRIDGE_*` and `MMCONNECT_*`
- `CONNECT_SOURCE=nightscout`, `glooko`, `linkup`, or `minimedcarelink`
- External Pushover and Maker/IFTTT credentials
- `DEVICESTATUS_DAYS`, because a larger Device Status window may
  substantially increase response and real-time message sizes
- `DE_NORMALIZE_DATES` and `AUTHENTICATION_PROMPT_ON_LOAD`
- `OBSCURED` and `OBSCURE_DEVICE_PROVENANCE`
- `CORS_ALLOW_ORIGIN`, `INSECURE_USE_HTTP`, `SECURE_CSP*`, and `SECURE_HSTS*`
- `BASE_URL`, deprecated `TREATMENTS_AUTH`, and `ALARM_PUMP_BATTERY_LOW`
- Arbitrary `PLUGIN_NAME_*` extension variables not listed in this guide

Some page preferences can still be saved through the Nightscout browser
settings UI. A new server-side variable should first be implemented and
tested in NSCF's request-local Settings/Plugin adapter, rather than merely
being created with the same name in the Cloudflare Dashboard.

## Verifying configuration

After adding or changing variables:

1. Wait for the new Worker version to finish deploying.
2. Open `/api/v1/status.json` and check units, language, enabled plugins, and
   extended settings.
3. Open the main page and confirm the expected plugins and prediction lines.
4. Perform one test write from the upload client.
5. Confirm that the data remains after a refresh and real-time reconnect.
6. Before enabling alarms, validate thresholds and timing with test data.
7. For Dexcom Share, inspect `/_nscf/connect/status` after authenticating.

The presence of a variable in the Cloudflare Dashboard does not prove that
the configuration took effect. Verify the status endpoint, UI behavior, API
reads and writes, and persistence.
