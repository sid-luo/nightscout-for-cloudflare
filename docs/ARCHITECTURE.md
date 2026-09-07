# NSCF architecture

Last baseline audit: 2026-09-07 (15.0.8 testing branch)

Current beta: NSCF 1.3.0-beta.1, upstream 15.0.8 / API3 3.0.5. See
[testing-track changes and limits](testing/NIGHTSCOUT_15_0_8.md) for the current
sanitizer, XML renderer, bounded maintenance actions, framing option and protocol
updates. The historical evidence below is retained with its original versions.

This document distinguishes the adapter that exists today from the target
architecture required for a complete Nightscout v15.0.7 port. The current
system is a compatible subset, not a full server.

The historical acceptance evidence below describes candidate `56353da` and
Cloudflare version `339263b5-c3d5-400a-b3b3-0c6299722d32`. The
candidate's 73-file Workers-runtime suite passes 799/799 plus 23/23 audit tests,
42/42 unchanged direct upstream client tests across eleven files and 143/143 unchanged tests across twenty-one
locked upstream server/data-plugin files.
Wrangler processed 250 Static Assets entries; that historical dry run reported 1319.52 KiB
raw / 242.79 KiB gzip and only the `ENTRY_STORE` Durable Object and `ASSETS`
product bindings. Project release 100 reported a 36 ms startup and passed the
213-assertion credential-free API, EIO3/EIO4 JSONP polling,
real direct-or-upgraded WSS, Pebble and real-browser gates. The authenticated
Profile save/reload/restore and its live-page `dataUpdate`/`retroUpdate`
observation remain release-93 evidence;
the broader Food/Admin/Reports acceptance remains version-80 evidence.
These are release facts for the named subset, not
evidence of a complete port.

Historical private release acceptance 101, before the connector split, did not
change the runtime contract. It pushed
the canonical source to the private `Sid-Law/nightscout-for-cloudflare` GitHub repository and
deployed Git commit `0706d33` to a new Cloudflare account with no pre-existing
`workers.dev` namespace. Wrangler created the account namespace, the declared
Worker, 250 Static Assets and one SQLite Durable Object, producing version
`c64a3ea4-d896-4c37-bad9-7803facd7581` at
<https://nscf-phase1.nscf-sid.workers.dev/>. Startup was 29 ms. The fresh
instance passed the 213-assertion remote protocol smoke, protected Profile
create/save/current, the official first-run Profile Save and remembered Admin
workflow, then rendered injected test glucose and two SVG charts. This is
fresh-platform evidence, not a claim that Cloudflare's public repository
button has run while the source remains private.

The project package version is `1.1.1-beta`, displayed to users as
`Nightscout for Cloudflare 1.1.1-beta`; the upstream application and all public
Nightscout version responses remain `15.0.7`. The Settings/About panel preserves
the upstream Nightscout attribution and links, then identifies Nightscout for
Cloudflare separately with its downstream version, project-home link and issue
link. A clean Git export has independently rebuilt byte-identical assets,
passed the complete local gate and started with an empty SQLite Durable Object.
On first visit the official client redirects an instance with no Profile from
`/` to `/profile`. Authorization is page-client state: read-default users see
the editor, but only an authenticated client can save. Selecting the upstream
**Remember this device** option carries that authorization to Food/Admin pages;
NSCF adds no onboarding UI or custom Profile defaults.

The current Wrangler configuration declares `ASSETS`, `ENTRY_STORE` and
`DEXCOM_SHARE_CONNECTOR`. The two SQLite Durable Object classes use independent
alarms: `EntryStore` owns realtime, authorization and local task deadlines;
`DexcomShareConnector` owns the optional Dexcom Share schedule and is off by
default.

The deployed platform configuration sets Wrangler `keep_vars: true` so a
dashboard-managed lab variable survives later code deployments. A Node audit locks that behavior while
rejecting checked-in plaintext vars and prohibited product bindings. The
current runtime retains the exact v1/v2 `experiments/test` authorization probe and
retains `src/server-query.ts`, which replaces Mongo ObjectId,
`traverse` and `moment` mechanics while preserving the locked query contract,
and `src/language.ts`, which replaces server `fs` with request-local Static
Assets loading while preserving official translations. It also retains
`src/plugins/registry.ts`, a request-local static replacement for the
Node-only dynamic plugin loader. Its locked client/server catalog membership
and order, enable flags, shown-plugin gates, hook dispatch, error containment,
event aggregation and extended-settings projection are contract-tested. The
implemented v2 property plugins execute through this registry. The current runtime includes
`src/plugins/ar2.ts`, `src/plugins/simplealarms.ts`, `src/plugins/errorcodes.ts`,
`src/plugins/xdripjs.ts`, `src/plugins/age.ts`,
`src/plugins/runtimestate.ts` and `src/notifications.ts` on top of
`src/plugins/basal.ts` and `src/plugins/treatmentnotify.ts`: Basal preserves
the current scheduled/temporary/Combo Bolus contribution, pill, visualization
and assistant behavior; Treatment Notify preserves the locked recent-treatment
filtering, snooze, request classification and synchronous `node:crypto` SHA-1
hash; AR2 preserves the locked autoregressive coefficients, forecast cone,
loss thresholds and notification metadata, while Simple Alarms preserves the
strict threshold cases. The
notification processor preserves priority, snooze and automatic all-clear,
with schema-v13 state and atomic live `/alarm` publication. Schema v14 adds a
generic persisted task scheduler. One `plugin-notifications` task automatically
evaluates Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE, SAGE, IAGE, BAGE,
officially enabled Treatment Notify, opt-in Timeago and opt-in DBSize alerts in
official server order. Error Codes retains the upstream display/sound map,
default and literal-`off` custom level mapping, newest nonfuture SGV selection,
strict ten-minute freshness and exact future activation/expiry. Uploader
Battery preserves `UPBAT_*`, recent-device selection, per-device minimum,
heartbeat, expiry and All Clear; only external delivery remains missing. xDrip-js retains
its newest eligible 24-hour DeviceStatus, exact `sensorState` projection,
transmitter-state/battery alerts and whole-minute repeat rule. Schema v20
persists its last state-notification marker per tenant so isolate eviction does
not restart that cadence. Pump,
OpenAPS and Loop retain their official plugin and alert gates behind the same
registry.
Schema v15 replaces the upstream process-local Admin-notification array with
per-tenant SQLite state. It preserves message aggregation, the public count and
admin-only body split, eight-hour API visibility, twelve-hour transient
retention, readable-site and failed-auth producers, and the official disable
gate across DO eviction.
Schema v16 replaces the upstream process-local Lodash data-update debounce and
mutable concurrency flags with `data_update_debounce`. A leading mutation
schedules the plugin-notification task immediately; additional mutations move
one persisted trailing deadline to one second after the last event, bounded by
five seconds from burst start. DO request serialization prevents overlapping
evaluation, and the existing alarm multiplexer survives isolate eviction.
Root/API realtime publication remains immediate and is not coalesced.
Schema v18 replaces Pushnotify's process-local NodeCache maps with bounded
`push_recent`, `push_receipts` and `push_maker_state` SQLite tables. The
request-local Maker/Pushover/Pushnotify adapters preserve the locked message,
key, priority, retry, hash, receipt and All Clear contracts. The official
v1/v2 receipt callback consumes only a previously stored, unexpired receipt
and then acknowledges the same durable alarm state used by Socket.IO. Live
external send/cancel transport remains disconnected.
Schema v20 adds generic bounded `plugin_runtime_state` JSON rows. Its first
consumer is xDrip-js's last state-notification marker, replacing a Node module
global with tenant-local durable authority without changing the plugin's
public data shape or alert rules.
The legacy document adapter additionally preserves the locked storage-shape
semantics: scalar and array API writes map to explicit batches, Profile/Food/
Activity direct saves create a fresh ObjectId when their internal ID is absent
or invalid, and role/subject replacements remain single-row updates. The
public v1/v2 ObjectId validator still rejects invalid uploader mutations before
the internal save fallback. There is no raw Mongo collection façade.
`src/plugins/iob.ts`, `src/plugins/cob.ts` and
`src/data/treatment-to-curve.ts` use official request-local
formulas and bounded Treatment/Profile inputs, while API v2 ddata and the root
realtime snapshot both apply the official treatment-marker curve placement. It retains the age/timeago,
`src/data-loader.ts` and
`src/plugins/dbsize.ts`, so real SQLite file bytes flow through ddata and the
official database-size calculation. The
eleven complete official client files run 42/42 unchanged only after a byte-equality
gate proves that the NSCF public bundle is the upstream-built bundle. Local
evidence is 71 Workers files / 785 tests, 23/23 audits, eleven direct upstream
client files / 42 tests and twenty-one direct upstream server/data-plugin files / 143 tests; the
pre-connector dry run was 1289.67 KiB raw / 237.03 KiB gzip with 250 assets and
two bindings. The current Wrangler configuration adds the
`DEXCOM_SHARE_CONNECTOR` binding.
Remote API/EIO3-and-EIO4-WebSocket and real-browser gates passed against the same active version.

## Current request and data flow

```text
Official Nightscout v15.0.7 pages and browser bundle / compatible uploader
        |
        | static HTML/CSS/JS and v1/v2 page API
        | official Socket.IO 4.5.4 over EIO4 polling; compatible EIO3 polling;
        | EIO3/EIO4 direct-WebSocket or standard polling-upgrade clients
        v
Cloudflare Worker (nscf-phase1) + Workers Static Assets
  - official upstream pages/assets/Swagger specifications
  - API_SECRET, subject access-token and signed-JWT authorization
  - bounded parsing, upstream query subset and tenant routing
  - request-local locked language selection/placeholder handling with official
    dictionaries loaded from Static Assets rather than server filesystem access
  - v2 ddata/properties/summary stateless response adaptation
  - request-local locked Settings defaults, accessors, feature/alarm resolution
    and secure status filtering
  - request-local locked legacy `/pebble` response adaptation over bounded
    Entries/plugin context
  - inherited v1/v2 notification ACK authorization and HTTP adaptation
  - byte-identical official Socket.IO browser client plus optional test-tenant query adapter
  - strict `/socket.io/` EIO3/EIO4 polling, direct-WebSocket and polling-upgrade adapters
  - SIO4/SIO5 root plus API3 `/storage` and `/alarm` namespace protocol adaptation
        |
        | ENTRY_STORE.getByName(tenant), typed RPC
        v
EntryStore Durable Object (one logical instance per tenant)
        |
        | synchronous SQL API
        v
Embedded SQLite
  - narrow Entries compatibility shadow (fresh-only pre-1.0 reset policy)
  - generic documents table keyed by collection + id, including canonical Entries
  - indexed Entries date/dateString/type fields and upstream-style identity
  - food, profile, treatments, devicestatus, activity, roles and subjects
  - per-collection sort and lookup indexes
  - tenant-local JWT signing material
  - persisted EIO3/EIO4 sessions and bounded outbound packet queues
  - persisted root `dataUpdate` baseline for server-originated deltas
  - persisted `/storage` namespace connections and collection subscriptions
  - persisted `/alarm` connections, shared HTTP/Socket ACK authority and snoozes
  - persisted schema-v14 background tasks and retry state
  - persisted schema-v15 Admin notifications and aggregation state
  - hibernatable WebSocket attachments backed by persisted session authority
  - persisted authorization-failure delays
  - one SQL-derived Durable Object alarm for realtime/auth/task deadlines
  - local schema migration table
```

Optional Dexcom Share path (off by default):

```text
Worker bootstrap on / or /admin/
        |
        v
DexcomShareConnector Durable Object
  - independent alarm and bounded Dexcom HTTPS requests
  - validated Entries committed through typed ENTRY_STORE RPC
```

Workers Static Assets serves EJS-rendered upstream index, Admin Tools, Profile
Editor, Food Editor, Reporting, Split/multiframe and clock views; the official
Webpack bundle, Swagger UIs/specifications, `static/**`, `translations/**`, and
the upstream service worker are copied from the locked release. Dynamic clock
face names are inserted into the upstream clock template at request time. NSCF
contains no alternative page, chart, component, CSS theme, translation or
downstream-invented medical calculation. The request-scoped summary processor
described below is ported from the locked upstream source.

The deployed Admin page keeps all six upstream tools, including Subjects,
Roles and the four data-maintenance plugins. The build step changes only the
four legacy Mongo-oriented panel labels. The official bundle remains
byte-identical, and the label changes do not alter actions, authorization
requirements, API routes or deletion behavior.

The cross-cutting Settings adapter is also request-local. It retains the
official default object, camel/environment accessors, enable/disable and alarm
selection, threshold correction, snooze lookup and recursive secure-key
filtering, then supplies the JSON-visible snapshot used by HTTP and Socket.IO
status. This replaces Node module-global mutation without changing the locked
calculations. The broader `lib/server/env.js` process/filesystem discovery and
extended-settings loader remain separate platform-adaptation work.

Nightscout's Express server supplies UTF-8 in response headers, while the
upstream homepage itself has no `<meta charset>`. Cloudflare Static Assets
normalizes stored HTML and JavaScript media types without that charset. Text
asset paths therefore run through the Worker first; it streams the unchanged
asset response and appends `charset=utf-8` to text, JavaScript, JSON, XML and SVG
media types. Known secondary HTML routes are explicitly marked
`text/html; charset=utf-8`. Cloudflare initially classified the upstream Split
frame as `text/plain`; because Static Assets uses a content-hash ETag, changing
only the Worker MIME could leave an old representation behind a 304. The Split
route therefore removes incoming conditional validators before its internal
asset fetch, returns a 200 HTML representation and marks it `no-store`. Binary
assets continue to use the direct Static Assets path. These are platform
response/cache adaptations; the upstream HTML bytes and UI are unchanged.
The default cache and ETag behavior is documented in Cloudflare's
[Static Assets response headers](https://developers.cloudflare.com/workers/static-assets/headers/).

Cloudflare's public edge can represent a bodyless `DELETE` as a non-null,
zero-byte request stream, while locally constructed Fetch requests usually
expose `request.body === null`. The bounded body reader treats only that
zero-byte DELETE form as an absent authorization payload. POST/PUT and nonempty
malformed bodies remain strict JSON/form parses. This is a platform transport
normalization, not a Nightscout API behavior change; an isolated remote v1
Entries create/bodyless-delete/read contract verifies the public edge path.

The official client expects Socket.IO and consumes a `dataUpdate` runtime shape
rather than loading entries directly. `/socket.io/socket.io.js` is now the
byte-identical Socket.IO 4.5.4 client shipped by locked Nightscout v15.0.7. It
connects the unchanged upstream page/client/chart/plugin code directly to the
tenant-local EIO4 polling root and `/alarm` namespace described below. A
separate `platform/socket-tenant-adapter.js` changes only `io.connect` query
options when the visible URL explicitly selects NSCF's optional test tenant;
ordinary one-instance deployments execute the official client unchanged. The
server preserves the upstream ordering in which the first `dataUpdate` is
available before authorization completes, so profile-dependent plugins can
initialize from that payload.

The same aggregate snapshot feeds the wider v2 REST adapters without introducing a
process-global `ctx.ddata`. `src/realtime/ddata-snapshot.ts` represents the
locked ddata singleton's empty buckets, clone, runtime normalization and
prefer-new merge operations as pure functions; tenant state remains inside the
SQLite Durable Object. `src/plugins/bgnow.ts`, `direction.ts`, `rawbg.ts`,
`upbat.ts`, `loop.ts`, `iob.ts`, `cob.ts`, `dbsize.ts`, `age.ts`,
`timeago.ts`, `ar2.ts` and `simplealarms.ts`, supported by request-safe
`runtime/{times,units,levels}.ts`, are
ports of their locked property modules. They build the same
four five-minute buckets around the last non-future SGV, preserve the
over-nine-minute interpolation rule and mmol rounding, expose the official
direction character/entity only for current data, reproduce raw calibration
and noise behavior, analyze recent per-uploader battery minima/severity, and
interpret uploader-provided Loop status and forecasts without calculating a
dose, and preserve the locked database-size percentages, thresholds, pill,
notification request and assistant response. The age adapter selects the latest
non-future official Site Change, Sensor Start/Change and Insulin Change events,
then preserves the locked CAGE/SAGE/IAGE duration, display, notes, severity and
notification-request calculations. AR2 preserves its six-point forecast,
13-step cone, inclusive loss divisor, predicted alarm labels and exact
notification/assistant output. Timeago preserves the locked freshness
display and warning/urgent requests without process-global hibernation state.
IOB preserves the locked OpenAPS/Loop/pump extraction and precedence,
30-minute recency, Treatment fallback, DIA-scaled decay/activity, rounding,
display and assistant behavior. COB preserves OpenAPS/Loop extraction, the
official carb-absorption calculation, IOB-activity interaction, freshness,
display and assistant behavior. Both describe already-recorded state; neither
recommends a dose.
OpenAPS preserves the six-hour per-device state analysis, both historical
`recieved` and corrected `received` flags, prediction series/colors, mmol
display, Offline marker suppression, stale-loop request shape and assistant
responses. Pump preserves newest pump-clock selection, reservoir/battery
display and warning thresholds, display overrides, profile-timezone quiet
night, Offline suppression and all four assistant intents. Both modules display
uploader-provided closed-loop state and introduce no dosing calculation.
Basal selects the current scheduled Profile rate, adds active Temp Basal and
Combo Bolus treatment components and returns the locked property, pill,
visualization and assistant shape. Treatment Notify examines only the locked
recent ten-minute Treatment/MBG window, distinguishes manual and automatic
records, and returns the official snooze/calibration/treatment/temporary-target/
announcement notification request with a synchronous `node:crypto` SHA-1 hash.
When the official enable gate includes `treatmentnotify`, canonical mutations
and the persisted task evaluate it automatically. `simplealarms.ts` evaluates
the locked nonfuture/recent SGV boundary, strict warning/urgent high/low
thresholds, titles, event names, sounds and exact default message.
`ar2.ts` evaluates before Simple Alarms in locked server order, is exposed by
the v2 property dispatcher and maps `ALARM_TYPES` plus `AR2_CONE_FACTOR` into
the unchanged official client. `timeago.ts` calculates its next transition explicitly; strict upstream `>`
boundaries wake at threshold plus one millisecond, and a future SGV wakes when
it becomes current. Canonical document mutations schedule one schema-v14
`plugin-notifications` task. The originating request evaluates the leading edge
from a bounded 64-SGV, 10-MBG and newest-1,000-Treatment context. Active
requests repeat at the configured heartbeat, while expiry and future
activation deadlines are retained exactly. An ordinary inactive result leaves
no periodic wake. Timeago scheduling additionally requires truthy
`TIMEAGO_ENABLE_ALERTS`; the public upstream-default settings keep it dormant.
`src/plugins/properties.ts` executes them in locked server-plugin order and
respects `settings.enable`: `upbat` is enabled by default and `rawbg` stays
opt-in; `loop` is likewise exposed only when configured in `ENABLE`, while
`dbsize`, Basal and AR2 remain enabled by the locked default feature/alarm set. OpenAPS, Pump, IOB,
COB, CAGE, SAGE and IAGE remain opt-in exactly as upstream; timeago is a
client/notification plugin and is not fabricated as a v2 property.
`/api/v2/properties` applies those values plus the upstream comma
picker and truthy `pretty` serialization.

Property polling uses `getPluginPropertyContextJson()`, a bounded DO projection
of at most 64 SGVs, the newest calibration, recent device status, one small
database-stat object, the latest current Profile, at most one latest row for
each of six age-event types within 62 days, the newest zero-duration Profile
Switch within the upstream one-year window, the latest ten meter-BG Entries in
the existing two-day window and ordinary Treatments inside the upstream
2.5-day window. Profile Switch, Temp Basal and Combo Bolus rows are also
grouped for the Basal calculation. The ordinary set is selected newest-first with a
1,000-row cap, then restored to ascending runtime order. All fields share the
existing 900,000-byte, 8,000-node and 2,000-document transport budget. This
avoids materializing long-range Treatment history or unrelated food while
preserving the normal IOB/COB inputs. Cloudflare
can route a newly deployed Worker to an older still-live DO isolate during a
rolling release. The first plugin deployment exposed this when the old isolate
did not implement the new RPC. `loadPluginPropertyContext()` catches only that
precise missing-method error and temporarily uses the already-deployed
`getDdataSnapshotJson()` RPC; all storage and parse failures still propagate.
Once the DO isolate updates, requests automatically return to the small
projection.

Locked MongoDB exposes separate logical `dataSize` and `indexSize` values.
Cloudflare instead exposes the complete SQLite file through
[`ctx.storage.sql.databaseSize`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
`src/data-loader.ts` places that total in `dataSize` and zero in `indexSize`, so
the unchanged upstream `dbsize` sum remains the real file total rather than
counting indexes twice. Cloudflare's current
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
state that a SQLite object on Workers Free reaches `SQLITE_FULL` at 1 GB.
Because the official plugin configures its maximum in binary MiB, the platform
context exposes 1,000,000,000 bytes as 953.67431640625 MiB (displayed as
953.67). `DBSIZE_MAX`, warning/urgent percentages, alert enablement and MiB
display still use the upstream environment names and normalization. This is a
storage/runtime adapter; the official plugin formulas and UI remain unchanged.

`src/plugins/loop.ts` is a request-local port of the five locked Loop plugin
contracts. It selects six hours of recent DeviceStatus, preserves enacted,
failure and `received=false` display states, emits the official forecast-point
shape, evaluates stale Loop warning/urgent levels and builds the official
notification request and English virtual-assistant responses. Schema v14
persists its exact stale transitions, heartbeat repetition, clear and live
`/alarm` publication under the official opt-in alert gate. No downstream dosing
or recommendation formula is introduced.

`src/loop-push.ts` is the platform adapter for locked
`lib/server/loop.js` and `lib/api2/notifications-v2.js`. It keeps the upstream
credential/Profile validation order, four accepted event types, alert strings,
custom payload keys, Profile `deviceToken`/`bundleIdentifier` lookup and
five-minute expiry. The Node-only `@parse/node-apn` provider is replaced with
an awaited Workers `fetch` to Apple's sandbox or production HTTP/2 endpoint.
Workers Web Crypto imports the Apple `.p8` key as PKCS8 and signs an ES256
provider JWT; a per-isolate credential-fingerprinted promise reuses the token
for fifty minutes, inside Apple's 20-to-60-minute refresh guidance. APNs
responses are streamed into an 8-KiB bound and the request has a ten-second
timeout. The fetch and token provider are injectable in tests, so complete
request/error mapping is exercised without contacting Apple. This forwards
only the official authenticated Loop events; it adds no dosing calculation.
The public lab deliberately has no Apple credentials and therefore cannot be
used as evidence of live APNs delivery. See Apple's
[provider-token](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)
and [notification-request](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
specifications plus Cloudflare's [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
and [fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) APIs.

`src/sandbox.ts` is the request-local port of the public `lib/sandbox.js`
surface used to host those official plugins. Its server and client initializers
retain the safe notification view, translation and level references, immutable
first-writer properties, non-future SGV/history selection, LOW/HIGH sentinels,
unit/display rounding, default message construction and plugin-specific
extended settings. Server initialization substitutes only the existing locked
Profile adapter for Node's dynamic `require`; there is no filesystem access or
cross-request module-global tenant state. This closes the Sandbox foundation,
but it does not itself schedule server evaluation.

`src/plugins/registry.ts` ports the public `lib/plugins/index.js` registry
surface with static build-time catalogs in place of Node dynamic `require`.
Each request gets new plugin objects and enable state. Client/server membership
and order, shown-plugin/type filtering, hook/error behavior, event types and
extended client settings retain the locked v15.0.7 behavior, including its
documented lookup quirk; production enable gating uses exact-name registration.
The current pure property modules are dispatched through that registry in
server order. This supplies the registry layer only: descriptors for unported
plugins do not fabricate their calculations, notifications or background
work.

`src/data/treatment-to-curve.ts` is a request-local port of
`lib/data/treatmenttocurve.js`. After ddata is loaded it mutates only the
official Treatment display fields, placing markers between surrounding SGVs,
respecting explicit mg/dL/mmol values and caps, and using the existing locked
raw-BG calculation when enabled. Version 86 invokes it inside the tenant DO's
root snapshot transform as well as the v2 ddata route. The transform runs
before each Treatment is reserved against the shared realtime JSON budget, so
initial root authorization and reconstructed deltas gain the locked marker
fields without creating an unaccounted payload expansion. It does not calculate
insulin or advice.

`src/api2/summary.ts` is a direct stateless port
of the locked SGV/treatment/profile and basal-data processors. It receives one
bounded snapshot and a request clock, so it neither shares request state nor
creates timers. The route now calculates the same enabled request-local
registry properties and supplies official IOB/COB/BWP values to Summary state.
When those plugins are disabled, IOB/COB/BWP remain JSON `null`, matching the
locked mapper. Remaining plugin-derived/persisted state is intentionally not
synthesized.

Exact `/socket.io` and `/socket.io/` requests reach real tenant-local EIO3 and
EIO4 polling/direct-WebSocket endpoints. EIO4 polling implements
the official open shape with `upgrades:["websocket"]`, 25-second server ping / 20-second
client-pong heartbeat, RS payload framing, SIO5 root CONNECT, `clients`, permission-derived
`authorize`, initial and subsequent server-originated `dataUpdate`, and
`loadRetro`. EIO3 polling uses the same 25/20-second advertised values but
retains its client-ping/server-pong heartbeat, length-prefixed payloads, SIO4
packet forms and locked two-stage open-then-root-CONNECT/`clients` ordering.
Schema v19 stores protocol authority per session, so mixed EIO3/EIO4 ACKs and
broadcasts are framed for each recipient. Sessions, root authorization
and ordered outbound frames are stored in the existing tenant `EntryStore`
SQLite database, while only an in-flight long-poll waiter is ephemeral. DO
eviction therefore does not lose protocol authority or queued packets. This
is the endpoint loaded by the official homepage; local and remote tests use the
same upstream Socket.IO client and a clean browser verifies the root and
`/alarm` workflows.
Schema v21 adds the optional normalized JSONP callback index to that same
session row. An initial single `j` selects JSONP; later polls and URL-encoded
`d=` POSTs use the stored mode across eviction, so an omitted or changed query
value cannot switch framing mid-session. Repeated initial `j` values retain
XHR mode, matching the locked Node query parser/Engine.IO boundary.
Direct WebSocket opens with either `EIO=3` or `EIO=4`, is accepted by the DO
through WebSocket Hibernation, and restores its tenant/SID/protocol authority
from a validated attachment plus SQLite state after eviction. A live polling
SID of either protocol can also open a candidate WebSocket, complete its locked
probe/noop/upgrade sequence and atomically replace the persisted transport.
Candidate phase and deadline live in a validated attachment plus SQLite closure
row; abort, bad frames, cross-protocol admission, duplicate admission and the
ten-second alarm timeout preserve the original polling session.

`src/realtime/calcdelta.ts` ports the locked `lib/data/calcdelta.js` comparison
semantics without keeping Node process state. Schema v11 stores one complete
tenant baseline in `realtime_root_state`. After successful implemented v1/v2
or HTTP API3 changes, the DO loads the current database snapshot, calculates
SGV/MBG/calibration/device-status replacement fields, treatment
add/update/remove actions and profile replacement, advances the baseline and
queues a non-empty root `dataUpdate` only for connected, authorized,
read-allowed live sessions. API3 queues its root frame and `/storage` frames in
the document mutation transaction; legacy paths publish in a follow-up DO
transaction. Existing polling and Hibernatable-WebSocket flush paths deliver
the same durable queue. Food and activity still advance the baseline but emit
no delta because the locked calculator exposes neither field. Upstream
profile-switch status injection is persisted in the same root baseline. The
shared BWP request/task path also preprocesses bounded Profile Switch, Temp
Basal and Combo Bolus input; remaining server-plugin preprocessing before the
comparison remains partial.

Schema v12 extends each persisted root session with `write_allowed` and
`treatment_write_allowed`. A successful `authorize` therefore retains all
three upstream authority branches across Durable Object reconstruction and
Hibernatable-WebSocket eviction. The main namespace accepts the locked
`dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove` events for treatments,
entries, device status, profile, food and activity. Collection validation and
permission checks retain upstream error order; the acknowledged mutation runs
through the shared repository, and a changed snapshot queues the later root
`dataUpdate` only after the ACK packet. Treatment exact/plus-or-minus-two-second
dedupe, device-status dedupe, AAPS Profile replacement, custom string `_id`,
dotted set/unset and prototype-safe field traversal are named contracts. A
100-document event cap, document-depth/size limits and string-ID bounds are
Free-plan controls; unrestricted Mongo/BSON numeric, object and mixed-type ID
semantics remain outside this slice.

The same transports expose the API v3 `/storage` namespace independently of
the root namespace. A `subscribe` event resolves only the subject access token,
checks the locked collection read permission (Settings requires admin), and
stores granted rooms in SQLite. Successful HTTP API3 and legacy v1/v2
creates, updates and deletes enqueue the official SIO5 `create`, `update` or
`delete` frame for each current subscriber. Legacy documents are materialized
into the API3 shape before publication, allowing NSClientV3 to resume after
ordinary chronological xDrip or other legacy-uploader writes. A failed or
saturated subscriber is removed without rolling back the document.
The transports also expose `/alarm` independently. A truthy native
`accessToken` branch has priority and accepts a valid subject without requiring
notification roles, matching the locked listener behavior. The web branch
accepts the API secret, JWT or current anonymous default and returns separate
read/ACK authority. Connection and accumulated ACK authority persist in SQLite.
A trusted internal RPC accepts only an already-computed notification object,
classifies it as `clear_alarm`, `alarm`, `urgent_alarm`, `announcement` or
`notification`, and broadcasts it live to every current tenant-local `/alarm`
connection; no disconnected replay is stored. `src/notifications.ts` ports the
request reset, first-urgent-then-warning selection, information/announcement
handling, longest eligible snooze and automatic all-clear rules from
`lib/notifications.js`. A bounded internal DO RPC accepts at most 128
notification requests plus 128 snoozes in at most one MiB, runs that processor
against SQLite state, records `last_emit_at` and queues the selected `/alarm`
object in the same transaction. It is intentionally not exposed as a public
HTTP API. Authorized `ack` events persist
the group/level snooze, mirror Urgent to Warning and broadcast the exact
all-clear object. The official v1 `/notifications/ack` route and its inherited
v2 mount use the same SQLite transaction and live broadcast path, require
`notifications:*:ack`, and return Express's exact `200 OK` text body. The
adapter bounds state to 256 distinct group names of at most 256 characters.
Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE,
SAGE, IAGE, BAGE, Treatment
Notify, Timeago and DBSize now run through the persisted scheduler under their
official gates; all sixteen official server notification producers are automatic.
Server ping, pong timeout, session expiry and abandoned poll/POST lease
deadlines, bounded WebSocket close retries and stale authorization-failure
cleanup plus background-task deadlines are multiplexed through the DO's single
persistent alarm. The handler
is transactional and idempotent under at-least-once delivery. A still-future
earlier prompt is retained, while a stale past platform alarm is replaced so
queued delivery cannot clear the only remaining SQL wakeup;
process-lifetime timers are not authoritative.

The official v15.0.7 service worker uses a cache-first list that includes
`/socket.io/socket.io.js`. A cache key derived only from the upstream release
would therefore retain an earlier Cloudflare adapter even after the adapter
changed. The build layer hashes the adapter bytes, adds that hash to the
generated script URL and service-worker registration URL, disables HTTP-cache
reuse for service-worker updates, and removes the unversioned adapter from the
precache list. This is transport/cache adaptation only; upstream UI and medical
logic remain unchanged. The content-addressed script URL also bypasses an
already-active old worker on the first refreshed page, without asking the user
to clear browser storage.

Before an API-secret write can reach storage, the Worker requires `API_SECRET`
to be present as a Cloudflare environment binding and at least 12 characters
long. It hashes the configured raw passphrase with SHA-1 and SHA-512 through
Web Crypto and compares the supplied `api-secret` header (or `secret` query
parameter) with the hexadecimal digests. Each comparison first hashes both
inputs to a fixed 32-byte value; it uses the runtime's native
`timingSafeEqual` for the comparison.
Raw passphrases on the request wire are rejected. Missing configuration fails
closed. Admin-created subjects, roles, permissions and derived access-token
metadata are stored in the same tenant's SQLite documents table; authorized
subject tokens may be used according to their persisted permissions.

`/api/v2/authorization/request/<accessToken>` now signs an upstream-shaped
HS256 JWT whose payload contains `accessToken`, `iat` and `exp`, with the
official eight-hour default lifetime. A random 256-bit signing key is stored in
the tenant's private `tenant_secrets` SQLite table, so signatures survive DO
eviction while remaining isolated between tenants. Verification uses Workers
Web Crypto; after signature and expiry validation, every request re-reads the
subject and roles, so deletion or permission changes immediately affect an
existing JWT. Permission checks use the same `shiro-trie` 0.4.10 resolved by
the locked upstream release, including suffix, wildcard and comma semantics.
Token-bearing authorization paths are redacted from unhandled-error logs.

The deployed adapter derives each subject access token from the
API-secret/ObjectId contract, preserves the locked suffix/digest-prefix lookup,
and implements the independent secret/token extraction order across query,
header and the first request-body object. Explicit failures are recorded per
source IP in SQLite, delay subsequent checks, and are cleaned through the same
DO alarm. Locked v15.0.7 sends repeated/bracket `secret` arrays into
`enclave.isApiKey().toLowerCase()`, producing an unhandled asynchronous
rejection rather than a normal response. NSCF deliberately hardens that edge:
an array can never grant admin, its bounded values are tried as ordered subject
credentials, and an invalid/oversized array returns 401 and records the
failure and emits the locked Admin warning without storing the presented
credential. Two differences remain named: the Workers request boundary caps
the actually enforced delay at 60 seconds, and schema v15 bounds transient
Admin messages to 128 per tenant instead of retaining an unbounded process
array. Most current GET routes remain public.
API v3 `/status`, `/lastModified` and all entries, treatments, device-status,
profile, food and settings routes accept only a verified Bearer JWT; API
secrets and query tokens are not API v3 credentials.

The Worker is otherwise stateless. An optional `tenant` query parameter is
validated and passed to `ENTRY_STORE.getByName()`. The default is `demo`. A
deterministic name always routes one tenant to the same strongly
consistent DO; different names route to separate DO instances and separate
SQLite databases. This is isolation by storage shard, not authentication.

`EntryStore` uses RPC rather than an internal HTTP hop. JSON strings cross the
RPC boundary to avoid recursive generic values unsupported by the generated
Cloudflare RPC types. Its constructor uses `blockConcurrencyWhile()` only for
idempotent schema setup. Critical data is written synchronously before
returning. The upstream v15.0.7 rule of one SGV per normalized timestamp/type
is represented by a unique dedupe key; every non-ObjectId uploader `_id` is
preserved as `identifier` when the supplied identifier is falsy, while valid
24-hex IDs may be retained as `_id`. Generic document
records store bounded JSON plus normalized sort/create/update timestamps.

The v1/v2 Status adapter is a deliberately narrow Express-contract boundary.
It handles the locked txt/json/js/png/svg forms, extensionless Accept
negotiation, redirects, v2 inheritance, GET-to-HEAD behavior, method fallthrough
and final 404/406 production shapes before the Worker's general API/CORS path.
The response body's `authorized` field is independently derived only from query
`token` and then query `secret`, including Express-style repeated/bracket array
values; an Authorization header does not populate that field. Local
Workers-runtime tests lock representation bytes and lengths. A real local
Wrangler check confirmed fixed `Content-Length` for the production 406, while
the platform HTTP boundary may still transfer the HTML finalhandler 404 as
chunked; that transport-level P2 remains a post-deploy smoke item.

V1/v2 Entries now has its own bounded Worker boundary. The Worker extracts the
locked lowercase extension forms, negotiates JSON/plain/CSV/TSV, compiles the
supported query fields/operators and request sort, then calls typed `EntryStore`
RPC. Extended URL-encoded bodies use maintained `qs` with the locked
body-parser depth/parameter/array shape; legal queries above SQLite's
binding/statement budget return a controlled client error. SQLite applies the
requested sort and limit first; the response formatter
then reorders only that selected set by `mills`/`date` descending, preserving
the locked upstream quirk. JSON and the three text representations share
result-derived Last-Modified, weak Express-style ETags, IMS/INM freshness and
HEAD metadata. Exact base `/entries` first checks the latest bounded runtime
SGV, matching upstream `ifModifiedSinceCTX`; that time remains the fallback
Last-Modified header when the requested result is empty.
Cloudflare can remove a dynamic response's `Content-Length` at the public HTTP
boundary even though Workers-runtime responses retain it, the same transport
P2 already recorded for Status.

The inherited `/count/:storage/where` utility has a separate execution path.
The Worker parses the bounded find subset, selects entries, treatments or
device status with the locked unknown-storage fallback, then asks the tenant DO
for SQL `COUNT(*)`. Only the integer crosses RPC, so a long indexed range does
not allocate the matching document bodies and is not subject to the ordinary
10,000-row response limit. Zero matches serialize as `[]`; nonzero matches use
Mongo's `[{"_id":null,"count":N}]` group shape. Count/sort result options are
ignored as upstream does, while client-supplied aggregation pipelines are
rejected rather than translated into executable SQL. The bounded Entries-router
`echo` adapter renders the locked Mongo query shape plus input/params/storage
debug envelope without reflecting Cloudflare tenant or credential parameters.
Release 97 selects the exact Entries, Treatments or DeviceStatus query options.
`times/echo`, `times` and `slice` expand the locked numeric-brace fixtures into
at most 256 linear patterns and eight literal prefixes. Entries/dateString
retains its indexed prefix ranges; other supported store/field combinations
translate non-pattern Mongo filters and sort to the generic SQLite repository,
materialize at most 10,000 candidates, and apply the final string pattern/count
in stable storage order. Unknown stores fall back to Entries. Arbitrary
JavaScript regex syntax and non-empty Mongo regex flags remain outside this
slice.

Legacy collection deletion keeps two interfaces deliberately separate. The
locked v15.0.7 server exposes MongoDB 5's modern
`{acknowledged,deletedCount}` result, but the unchanged Admin Entries and
Treatments cleanup plugins still read `retVal.n`. Normal v1/v2 callers retain
the exact modern response. Only a same-origin request whose Referer path is
exactly `/admin/` receives additional `n` and `ok` aliases, allowing the
official page to render its unchanged result text without weakening or
silently changing the public API contract.

Entries upload and preview share one recursive sanitizer before normalization
or persistence. The locked server uses DOMPurify with JSDOM; neither DOM runtime
is available at this Worker boundary. NSCF therefore entity-encodes HTML-like
and entity-bearing nonnumeric Entry strings while preserving existing named/
numeric entities to make read-then-reupload idempotent. Legacy Treatment POST
uses a separate safe-tag serializer: active blocks are removed, reviewed tags
are lowercased and retained, and every attribute is stripped. It matches the
locked malicious IMG fixture but is deliberately stricter than DOMPurify for
otherwise-safe attributes, so general byte-equivalent output remains open.
Persistent batches cross the RPC boundary as validated values. Each item runs
in its own synchronous SQLite transaction that atomically updates the canonical
document, narrow Entries shadow and change snapshot. A conflict rolls back that
item, retains the already committed ordered prefix, and prevents the suffix
from running, matching `bulkWrite({ordered:true})` rather than request-wide
atomicity.

## Target complete-port architecture

```text
Official Nightscout v15.0.7 browser code and compatible clients
        |
        | HTTP / Engine.IO polling / WebSocket
        v
Cloudflare Worker request adapter + Workers Static Assets
  - official immutable pages, bundle, translations and Swagger
  - upstream-compatible routing, content negotiation and errors
  - API_SECRET/JWT verification and tenant resolution
        |
        | typed RPC or WebSocket upgrade
        v
Tenant Durable Object
  - SQLite collection compatibility layer
  - mutation transaction + persisted change event
  - Engine.IO/Socket.IO sessions and namespaces
  - hibernatable WebSockets and polling queues
  - one persisted alarm scheduler for tick/prune/plugin work
        |
        +--> official server data/plugin modules through a platform context
```

The Worker remains stateless. Every Nightscout data request that reads or changes tenant state
is routed with `ENTRY_STORE.getByName(tenant)`. The DO is the coordination atom
for that tenant: it serializes mutations, owns SQLite, accepts hibernatable
WebSockets and multiplexes scheduled tasks through its one alarm.

Optional external connectors use separate Durable Objects and alarms so vendor
I/O cannot block `EntryStore` Engine.IO heartbeats. `DexcomShareConnector`
commits only validated Entries through typed RPC.

This shape follows Cloudflare's current platform model:

- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  provides private, strongly consistent storage per object.
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  lets connections remain attached while the object is evicted; authoritative
  subscription/session data must therefore be reconstructible.
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
  are at-least-once and only one alarm is scheduled per object, so a task table
  must hold every due tick, prune and plugin job.
- [Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/binding/)
  keeps binary assets on the fast path while API and text-header adaptations
  run Worker-first.

## Runtime adapter boundaries

### Node and Express

Workers now supports Node HTTP server APIs and an Express adapter, so Express is
not itself a blocker. The incompatible part of
`vendor/nightscout/lib/server/server.js` is the permanent process lifecycle:
one Mongo connection pool, one in-memory event bus, one timer set and one
Socket.IO server. Reuse decisions are made router-by-router; NSCF will not boot
the whole process and pretend its global state is durable.

The same distinction applies to `node:fs`: Workers' virtual file system can
read bundled files, but runtime host paths and mutable local persistence are not
portable. UI files and translations therefore remain deterministic build
artifacts.

### Mongo collection compatibility

The finished adapter must expose collection behavior rather than merely store
JSON. Required behavior includes:

- ObjectId/UUID identity normalization and immutable identifiers;
- collection-specific unique indexes and fallback dedupe;
- nested queries, type conversion, projections, ordering and limits;
- insert/replace/update/upsert/delete result shapes;
- API v3 `srvCreated`, `srvModified`, tombstones and history;
- atomic mutation plus a persisted real-time change event.

SQLite tables and indexes may differ internally from MongoDB, but observable
Nightscout behavior must be fixed by upstream-derived contract tests.

The runtime adapter represented by candidate
`c07d52fc68db976d20b1ced9d3f9d0088ab1a0a8` implements all six official generic
vertical slices—entries, treatments, device status, profile, food and
settings—in the tenant
`EntryStore` Durable Object. Internal SQL schema version 4 extends `documents`
with `identifier`, `identifier_present`, `srv_created`, `srv_modified`,
`is_valid`, `fallback_key`, `revision` and `srv_metadata_version`; adds
`collection_clocks` and `document_changes`; and adds non-unique lookup/history
indexes. The nullable `srv_*` metadata mirrors fields actually persisted in the
body. It is not an upload-time surrogate for legacy documents.
`identifier_present` preserves the Mongo distinction between a missing field
and an explicitly stored `null` or empty string. API v3 fallback dedupe may
therefore require a genuinely absent identifier without conflating those
three states. `identifier` and each collection's fallback identity are
deliberately **not** unique because the locked Mongo adapter only creates
ordinary indexes and resolves legacy duplicates at lookup time.

Profile uses the locked API v3 `created_at`-only fallback identity. V1 Profile
create/save/delete now pass through the same repository, so API v3 and the
official Profile Editor observe one row identity and one atomic change history.
Activation backfills older Profile rows without rewriting their JSON bodies and
records the migration snapshot once across repeated Durable Object eviction.
The locked `{startDate:-1,_id:-1}` current-Profile order is shared by v1
`/profile/current`, Status settings and the realtime dataloader; the latter
returns one Profile just like upstream `ctx.profile.last()`.

`src/profile-functions.ts` ports the official Profile calculation surface used
by the API v2 Summary path. It retains legacy on-the-fly conversion, store and
historical-record selection, active Profile switches, DIA, carbohydrate
absorption/ratio, insulin sensitivity, low/high targets, basal schedules,
units, IANA-timezone lookup, Circadian Percentage Profile coercion and
temp/combo-basal helpers. Node-specific lodash, memory-cache and
moment-timezone mechanics become native arrays, an instance-local five-second
`Map` cache and `Intl.DateTimeFormat`; keeping the previous-temp-basal pointer
inside the instance prevents cross-tenant isolate state. The complete 24-case
locked `profile.test.js` file is represented by Workers-runtime tests. This
foundation does not imply that every plugin consuming Profile data is ported.

Food uses the locked API v3 `created_at`-only fallback identity. V1 Food create
forces a new server `created_at` like upstream, while save preserves an existing
value or supplies one when absent; both now use the generic repository so v1
and API v3 observe the same `_id`, metadata and change history. Activation
repairs older Food metadata, fallback keys and missing migration snapshots once
without rewriting preserved JSON bodies, and repeated activation/DO eviction is
idempotent.

The v1 collection boundary deliberately translates legacy Mongo/Express
contracts rather than leaking SQLite internals. The shared ID helper accepts
missing, `null` and 24-hex ObjectId values, rejects UUID and numeric values, and
reports the first invalid item with the locked 400 JSON envelope. Activity,
Food, Profile, DeviceStatus and Treatments accept an empty POST array as a
successful empty result; Food also accepts an empty PUT array and creates on a
missing-ID PUT. DeviceStatus converts offset-bearing `created_at` to UTC ISO,
stores `utcOffset`, and combines wildcard deletion with any other supplied
filters. On v1/v2 create, its document adapter clones the request and truncates
only IOB/COB/UAM/ZT arrays beneath `openaps.suggested.predBGs` and
`openaps.enacted.predBGs`: 288 values by default, a configured positive
`PREDICTIONS_MAX_SIZE`, or no prediction trimming when the value is `0`.
Existing body/document size caps still apply. Its upstream module has no
generic PUT route, so the adapter no longer exposes one. Activity, Food and
Profile deletes return the locked empty object
instead of a storage-engine mutation count. Named Workers-runtime contracts
cover the complete locked Activity, DeviceStatus, Food, Profile, ID-validation,
ObjectId-validation, cross-collection shape, deduplication, Entries UUID and
partial-failure test files. Entries uniqueness remains `sysTime` plus `type`;
Treatments use `identifier`/`_id` first and then `created_at` plus `eventType`.
The adapter does not turn descriptive fixture fields such as `pump`, `sync` or
generic `id` into unique indexes that upstream never created.

The complete locked `concurrent-writes.test.js` file drives actual `SELF.fetch`
requests through the Worker boundary into one tenant Durable Object. Its 13
cases cover five simultaneous scalar and two-item batch writes for Treatments,
DeviceStatus and Entries, ten staggered Treatment writes in 100 ms, generated
ObjectId uniqueness, response cardinality, concurrent collection batches, 50
AAPS SMB recovery writes, 100 AndroidAPS SGV recovery writes and 30 mixed
collection requests. The passing contract is evidence for this bounded upload
shape, not a claim of unrestricted load capacity or MongoDB-scale throughput.

Treatment identity is controlled by the same locked `UUID_HANDLING` flag as
Nightscout v15.0.7. Missing, non-string and values other than case-insensitive
`on`/`true`/`off`/`false` use the upstream default `true`; whitespace is not
trimmed. When enabled, every non-ObjectId string `_id` is removed from the
replacement and copied to a missing/falsy `identifier`, while GET/DELETE by a
valid UUID searches both `identifier` and a pre-fix raw UUID storage ID. PUT
prefers `identifier`, then the matching raw legacy ID, then
`created_at + eventType`, so issue-6923 rows update in place. When disabled,
the invalid `_id` is still stripped but is not promoted, identifier upserts do
not fall back to raw IDs, and UUID GET/DELETE addresses only a genuinely raw
storage ID. Treatment delete responses use MongoDB 5.9's
`{acknowledged:true,deletedCount:N}` shape rather than the older
`{n:N,ok:1}` result.

The Loop ObjectId cache contract remains client-driven. A successful Treatment
POST returns a server-owned 24-hex `_id` in the same order as the uploaded
batch; later PUT and DELETE use that cached ID. `syncIdentifier` is preserved
byte-for-byte, including hexadecimal pump-event values, but is not promoted to
a database uniqueness key. Re-uploading it with a different `created_at`
therefore creates a second Treatment, matching the locked upstream cache-miss
and app-restart behavior. Loop SGV writes keep direction and device metadata
and use the same locked Entries `sysTime + type` selector. DeviceStatus remains
a general nested JSON document, so Loop IOB/COB, predictions, enacted temp
basals, overrides and pump/Omnipod fields pass through unchanged subject to the
separate official prediction-array limit.

The Worker-to-DO call is versioned for rolling deployment. Default-true
requests may fall back to the previous RPC only when Cloudflare reports the
exact missing-new-method error. Explicit false cannot be represented by the
old method, so it fails closed with a bounded 503 while an old isolate drains
instead of silently executing true semantics. All other RPC/storage errors
remain errors.

Settings deliberately has no legacy fallback identity and does not synthesize a
virtual `created_at` for generic reads. Its collection search and both history
forms use the locked `api:settings:admin` permission, while single-resource read
uses `api:settings:read`. Settings `lastModified` therefore comes only from a
real persisted `srvModified`, matching the upstream no-fallback setup.

The v4 migration runs in `DurableObjectStorage.transactionSync()`. It leaves the
legacy `body` and `_id` untouched, derives indexed metadata and snapshots each
old document once. The migration record, metadata backfill and new tables
commit together. Every activation checks structural completeness even when
marker 4 exists, so an older v4 installation receives `identifier_present`,
nullable change timestamps and the srv-metadata marker safely. Old hidden
upload-time values are rebuilt from the preserved body; a legacy body without
srv fields therefore migrates to SQL `NULL`. Existing clock high-water marks
are retained conservatively, but a legacy-only migration does not invent one.
Complete rows and existing change revisions are not replayed. The regression
fixture reconstructs the exact six-column v3 `documents` DDL with no v4 tables
or indexes, migrates it, then repeats activation to prove idempotence. A
separate older-v4 fixture proves structural repair with marker 4 already
present and recomputes legacy offset-bearing fallback keys without rewriting
their preserved bodies.

Entries adds indexed canonical documents plus a narrow compatibility shadow.
The v6 activation probe is deliberately fresh-only: when it finds an
incompatible pre-1.0 `entries` table, it drops and recreates only that shadow
instead of guessing how to import the earlier simulated schema. It does not
drop canonical documents, profiles or any other collection. Compatible healthy
activation performs a read-only structural/index probe, so ordinary DO
eviction does not repeat schema writes. The public lab was checked before this
deployment and contained zero Entries and one profile; post-deployment reads
confirmed both counts. This specific reset therefore had no old simulated
Entry row to lose and preserved the profile without recording its contents,
but the policy is not a general legacy Nightscout migration guarantee.
Deployment to the existing public Worker activates this schema in place and
retains canonical/profile data. A new family's planned fresh path starts with a
new Worker/SQLite DO namespace or empty tenant; an ordinary code deployment
does not replace or clear an existing namespace. Correct NSCF-internal schema
activation remains mandatory even though external Mongo history import is
deferred.

External Nightscout/MongoDB import and NSCF-internal schema activation are
separate contracts. The former is absent from the first release; the latter
must be forward-compatible and idempotent for every supported prior NSCF
schema. A fresh-family onboarding policy must never justify destructive
activation of an existing supported Durable Object. The only `fresh-only`
repair currently described here is the incompatible pre-1.0 narrow Entries
shadow above, not the database as a whole.

V1 Entries preserves the locked four-day default date window and keeps
`dateString` as a distinct string field rather than folding it into numeric
`date`. Realtime/ddata loading uses a separate two-day canonical-document
window. Indexed date/type searches stay in SQLite. The adapted query surface
accepts equality/comparison over numeric `date`, `sgv`, `filtered`,
`unfiltered`, `rssi`, `noise` and `mbg`, plus bounded string `_id`,
`dateString`, `device`, `direction`, `identifier` and `sysTime` fields; it
supports ordered sorts over those fields and type. Unsupported operators,
nested/array/mixed-type behavior and unsafe fields fail closed rather than
being silently ignored. A `dateString` scan or other unindexed candidate set
that would cross 10,000 rows fails closed with HTTP 413; synchronous delete and
per-document revision cleanup are capped at 128. Bodies are capped at 512 KiB
and upload batches at 100. These are explicit Free-plan controls rather than
claims that SQLite and Mongo have identical unbounded behavior.

Treatments and device status now share an internal SQLite repository and DO RPC
boundary for:

- lookup by server `_id`, client `identifier`, or collection fallback
  (`created_at + eventType` for treatments and `created_at + device` for device
  status);
- v1 treatments upsert selector priority (`identifier`, then `_id`, then
  `created_at + eventType`) after the locked `prepareData` time normalization,
  numeric coercion and cleanup, plus API v3 create dedupe against genuinely
  identifier-absent legacy documents;
- create/upsert, replace, patch, soft delete and permanent delete;
- strictly increasing API v3 server modification-time allocation persisted
  across eviction; v1 writes do not advance that clock. Observable
  last-modified is recalculated from current documents and falls back after
  permanent deletion. The strict monotonic allocator is a platform enhancement
  over locked upstream's direct `Date.now()` assignment, which can collide;
- ascending, field-projected history with tombstones;
- live v1 treatments filtering in SQL before sort/limit rather than loading
  5,000 documents first. Scalar equality/comparison, `$in` and `$exists` are
  pushed down with the locked four-day default window and `created_at` order.
  Regex, nested and unsupported operator forms return a stable HTTP 400 rather
  than being approximated or silently truncated.

PUT/PATCH deliberately use the locked `identifyingFilter()` distinction rather
than the broader READ/DELETE lookup: a 24-hex `_id` fallback may mutate only a
legacy row whose `identifier` field is genuinely absent. A modern API3 row
cannot be updated through its internal storage ID. This differs from READ and
DELETE, whose upstream `filterForOne()` still permits that ObjectId fallback.

Legacy and API v3 policies are separate. API v1 mutations store and return the
locked legacy body (including normalized `created_at`, `utcOffset`, and removed
`eventTime`), accept UUID/identifier/fallback PUT identity, and do not persist
synthetic `srvCreated`/`srvModified`; they also do not hide `isValid:false` or
enforce API v3 read-only rules. API v3 repository methods materialize server
metadata, hide tombstones in ordinary reads, enforce the 11 locked immutable
fields and preserve the identifier-only dedupe and tombstone resurrection
exceptions. API v3 READ and unfiltered SEARCH virtually resolve a legacy
document's missing server timestamps after SQL filtering, exactly as locked
`resolveDates()` does. Raw srv-field SEARCH still requires persisted metadata.
For incremental HISTORY and `lastModified`, however, the same effective cursor
is used consistently: Entries fall back to `date`; the other generic
collections fall back to `created_at`; Settings has no fallback. This prevents
an AAPS NSClientV3 client from seeing a newer `lastModified` value followed by
an empty history page. API v3 materialization also maps a missing/falsy
identifier to the server ID and removes Mongo `_id`. `/api/v2/ddata` consumes
the same legacy treatment shape as v1.

The locked v1 Treatments POST path now implements the complete two-document
`preBolus` create behavior. `prepareData` normalizes the primary treatment and
moves truthy carbs off it. Every truthy normalized `preBolus` creates a second
record at
`created_at + preBolus * 60,000` containing the event type, carbs and optional
notes; when carbs are missing or zero, the child preserves the upstream empty
string initialized by `prepareData`. API v2 inherits that v1 route. Retransmissions use the same
`created_at + eventType` fallback for each record, so both IDs remain stable.
The PUT path intentionally calls the one-record upstream save behavior: it
normalizes and removes the moved carbs but does not fan out a child.

NSCF wraps the two POST upserts in one synchronous SQLite transaction. This is
a named Cloudflare strengthening: if the shifted timestamp or second write is
invalid, neither record persists, instead of exposing a possible half-created
meal across two Mongo writes. It does not change the treatment calculation or
add a dosing algorithm.

Every create, replace, patch and soft delete writes its current document and a
`document_changes` snapshot in one synchronous storage transaction. Generic
API v3 history is a current-collection view: it orders current documents by
their effective modification cursor and includes soft-delete tombstones. API3
documents use persisted numeric `srvModified`; legacy Entries use `date` and
other legacy generic documents use `created_at`. It does not use audit
timestamps. Permanent deletion removes the document and its snapshots
together, matching upstream history behavior for `permanent=true`.
This transaction guarantee is per document except for one official logical
bundle: a Treatments `preBolus` POST commits its primary and carb child
together. V1 Entries deliberately uses one transaction per ordered batch item,
so a later error does not roll back a successful prefix.

### Deployed generic slice: all six official API v3 collections

The deployed adapter exposes exactly the eight locked generic routes for each
of entries, treatments, device status, profile, food and settings: GET/POST on
the collection, GET on both history forms, and GET/PUT/PATCH/DELETE on an
identifier. GET `/api/v3/lastModified` evaluates all six collections
independently when the subject has the required read permission; Settings is
omitted when that permission is absent. Unmatched API v3 routes use the locked
`{status,message}` 404 envelope rather than falling into the older adapter
error shape.

The Worker boundary uses one API-wide CORS policy matching the locked Express
middleware: preflight returns `OK`, advertises
`GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS`, and allows content, authorization,
Nightscout secret and conditional-request headers. Express implicitly serves
HEAD through GET; the adapter therefore evaluates the same API3 route and
authorization path, preserves its status and headers, and strips the response
body. This covers version, status, lastModified and all generic collection,
history and resource routes.

The public request still accepts only one `sort` or `sort$desc` value. Internally
it preserves the locked ordered chain—requested field, `identifier`,
`created_at`, then `date`—instead of collapsing it into an object or SQL
expression. Repeated query values retain Express/JavaScript key coercion, so
two `sort` parameters select the comma-containing field name. Nested and
unknown safe field names are passed to SQLite JSON paths. A final server-ID
tie-break makes otherwise equal SQLite results deterministic; upstream Mongo
does not promise that additional tie-break.

POST dedupe and PUT conditional-upsert choose create versus update permission
inside the same `transactionSync()` that performs candidate lookup and the
write. PATCH permission, existence, tombstone, precondition, immutable/common
validation and actor injection follow the locked order in that transaction.
Soft delete stores `modifiedBy`; permanent delete removes current and change
rows. Mutation and change-row failure rolls back the document, history and
monotonic clock together.

Durable Object RPC methods return application failures as typed results. POST,
PUT and PATCH already used `Api3MutationDecision`; DELETE now follows the same
boundary for known validation/storage failures. In particular, attempting to
delete a read-only document returns the locked HTTP 422 envelope without an
uncaught exception escaping the DO RPC. Unknown failures remain a generic
storage 500 and do not expose internal messages.

The read boundary uses the same locked renderer dependencies as Nightscout:
`accepts@1.3.8`/`negotiator@0.6.3` select JSON, CSV or XML in Express order;
`csv-stringify@5.6.5` and `easyxml@2.0.1` produce the response bytes. JSON keeps
the `{status:200,result}` envelope while CSV/XML return raw bodies and all
negotiated responses set `Vary: Accept`. Serializer failures preserve the
already-selected media type just as Express does. The upstream `mime` 2.6.0
extension middleware is preserved separately: an unknown extension is rejected
after JSON parsing but before routing/authentication, while a known MIME
extension is stripped and may reach a write handler (whose upstream response is
JSON). The resolved MIME type, rather than the literal suffix, drives reads, so
aliases such as `.map` and case variants such as `.JSON` use JSON. A known but
unsupported read format reaches authentication/querying and then returns 406.

Other deliberate or unresolved platform differences are explicit:

- JSON bodies are bounded at 512 KiB rather than upstream's 50 MiB;
- top-level JSON primitives return the stable treatments 400 envelope, while
  locked `body-parser` passes them into the upstream 500 error middleware;
- multiple operators for the same field preserve the locked object-overwrite
  behavior: the later query item replaces the earlier operator object, and the
  server's `isValid != false` condition replaces any caller `isValid` filter;
- a parsed API v3 limit of zero (for example, from `limit=0x10`) is capped at
  1,000 rows; locked Mongo treats `cursor.limit(0)` as unlimited;
- a finite positive `API3_MAX_LIMIT` below 1,000 lowers both search and history
  limits; invalid settings fall back to 1,000 and larger values stay capped at
  1,000 for Workers Free;
- API v3 `$re` accepts only a bounded, case-sensitive, linear subset compiled
  to SQLite `GLOB`; unsupported constructs, patterns above 128 UTF-8 bytes or a
  compiled GLOB above SQLite's 50-byte limit return controlled 400;
- unsafe JSON-path field syntax and queries beyond SQLite binding/statement
  limits return controlled 400 responses;
- non-negative `skip` values through JavaScript's maximum safe integer reach
  SQLite; larger parsed offsets return controlled 400 rather than an unsafe
  integer binding;
- SQLite/Mongo comparison and ordering across mixed JSON types, nested
  projection behavior and array semantics are not yet claimed compatible;
- all six official generic collections are represented by API v3
  `lastModified`, subject to each collection's read permission.

The locked history projection quirk is retained: when `fields` excludes
`srvModified`, the response body excludes it while Last-Modified/ETag still
come from the effective collection cursor. Legacy documents do not match raw
srv filters, but they do participate in HISTORY through the same virtual cursor
used by `lastModified`.
All 16 locked upstream `api3.*` test files are adapted by named
Workers-runtime contracts. Besides the prior basic, generic-workflow, read,
renderer, search and security set, the suite now covers create, update, patch,
patch-operation, delete, shape handling, AAPS patterns, storage socket,
storage find and storage modify. This is complete evidence for the locked API3
test-file set, not a claim that SQLite and MongoDB have unrestricted parity for
behaviors absent from those tests or deliberately bounded by Workers Free.
CSV/XML currently serialize an entire bounded result in memory; large-result
CPU and 128 MB memory adaptation remains open even though byte-level
small/medium contracts are green.

### SQLite limits and change-retention risk

Repository queries enforce the current Durable Objects SQLite limits of 100
bound parameters per query and a 50-byte final `LIKE`/`GLOB` pattern; final SQL
statement size is also checked against exactly 100,000 bytes. These checks use
final binding counts and UTF-8 bytes, including JSON paths, sort expressions,
limit and offset. See [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
These bounds do not prove Mongo-compatible mixed-type comparison or sort
collation; that differential matrix remains open.

The current Free-plan SQLite allowances include 5,000,000 rows read and 100,000
rows written per day, plus 5 GB of SQLite data across the account; exhausted
daily categories fail until their UTC reset. Index maintenance counts toward
row writes, and each `setAlarm()` call is billed as one row written. See
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
The idempotent activation repair and clock seeding still scan current document
metadata, so frequent eviction can consume rows-read allowance even when no
row needs repair and the guarded clock upsert performs no write.

`document_changes` currently retains a complete JSON body for migration,
atomic audit evidence and every create, replace, patch and soft delete. API v3
HISTORY reads current documents rather than this journal, and `/storage` does
not consume it. Full-body snapshots still create unbounded write/storage
amplification proportional to body size times revision count, with additional
index cost. There is no history retention or pruning policy yet; only permanent
deletion removes all snapshots for that document. This slice must therefore not
be described as suitable for indefinite Free-plan retention until a tested
retention policy is defined.

Live delivery instead reuses the bounded `realtime_outbound_packets` queue for
each currently subscribed session. The frame and document mutation share one
SQLite transaction; accepted frames therefore survive Durable Object eviction,
while a broken or over-capacity subscriber is removed without blocking the
write. There is intentionally no disconnected-client replay because upstream's
`/storage` socket is a live notification channel; a reconnecting client must
reload current state over REST. The queue is not a second permanent history
store and does not solve `document_changes` retention. R2 is unnecessary for
either contract and remains outside the fixed deployment footprint.

### Real-time transport

The byte-identical official Socket.IO 4.5.4 client supplies browser-side
`connect`, `authorize`, `subscribe`, `loadRetro` and `dataUpdate` events through
the real server endpoint. Locked `lib/client/index.js` explicitly requests the
polling transport; `platform/socket-tenant-adapter.js` adds only the optional
lab-tenant query. The endpoint implements strict EIO3/EIO4 HTTP polling, direct
Hibernatable WebSocket and standard polling-to-WebSocket upgrade with persisted session/queue state, root
namespace CONNECT, read/write/treatment-write authorization ACKs, initial/retro data and
connection-count broadcasts. It also implements the API v3 `/storage`
namespace, persisted authorized collection rooms and API3-only mutation events,
plus the API v3 `/alarm` namespace's persisted subscription/ACK/snooze slice
and trusted live notification outlet.

The current server boundary is explicit:

- EIO3/EIO4 XHR and JSONP polling, direct WebSocket and polling upgrade; both
  polling handshakes advertise `upgrades:["websocket"]`. JSONP persists the
  normalized initial callback index with the SID across Durable Object
  eviction, retains upstream callback/content-type/form-POST framing and
  ignores later changed or omitted `j` values. Binary packets are rejected; an exact
  `application/octet-stream` POST closes its leased SID and receives a
  controlled 400/code-3 response;
- 256 sessions per tenant, 128 queued packets and a 1,000,000-byte whole
  polling payload per session; incoming POST bodies are counted while streamed;
- 32-session opportunity cleanup on normal requests plus a persistent alarm
  derived from the earliest ping, pong, expiry, poll or POST deadline;
- direct-WebSocket queue delivery peeks a bounded FIFO prefix without deleting
  it, performs every synchronous `server.send()`, then acknowledges that exact
  prefix in one SQLite transaction. A crash before acknowledgement can replay
  a frame, but no longer silently loses the only durable copy before send;
- `/storage` can connect without the root namespace. Its subscription accepts a
  subject access token, defaults to the six official collections in locked
  order, ignores unknown collection names, requires `api:settings:admin` for
  Settings and the collection read permission otherwise, and persists granted
  rooms across eviction;
- `/alarm` can connect without root or `/storage`. A truthy native access token
  takes branch priority; web subscription accepts secret, JWT or the current
  anonymous-readable default and returns separate read/ACK flags. Repeated
  successful subscriptions accumulate ACK authority as upstream's listeners
  do. Authorized ACKs persist one of at most 256 bounded alarm groups, default
  a falsy silence time to 30 minutes, mirror Urgent to Warning, and broadcast
  the exact live `clear_alarm` payload;
- v1 and inherited v2 GET `/notifications/ack` require
  `notifications:*:ack`, return the exact `OK` body, and enqueue the same
  `clear_alarm` frame in the same SQLite transaction as the snooze. Repeated
  ACKs remain no-ops across eviction; malformed authenticated input remains a
  bounded 200 no-op;
- trusted alarm publication broadcasts one of the five locked event names to
  all currently connected tenant-local `/alarm` sockets, subscribed or not.
  Broken/overflow recipients are dropped independently and disconnected
  clients receive no replay. The bounded notification processor can persist and
  publish upstream request arrays through this outlet. A schema-v14 task now
  computes and publishes all sixteen producers in official server order,
  including Uploader Battery, Error Codes, xDrip-js, BWP and BAGE;
- root `subscribe` has no handler or ACK, matching the locked root. The four
  locked client-originated mutation events validate collection, authority,
  required `_id` and bounded payloads in upstream order, then return the exact
  ACK shapes before any resulting root `dataUpdate`. Server-originated
  implemented v1/v2/API3 changes use the same persisted delta baseline;
- HTTP API3 and legacy v1/v2 create/update/delete operations emit the locked
  API3-shaped `/storage` payload only after a successful mutation decision.
  This includes legacy CGM uploads needed by AAPS NSClientV3 incremental
  recovery. `document_changes` is not consumed.

Every realtime, authorization-delay or background-task state transition
recomputes the single persisted alarm from SQL.
The handler cleans all due sessions/leases, enqueues due pings, handles queue
overflow, broadcasts the surviving client count and runs due background work,
then schedules the next derived deadline. Notification state, live `/alarm`
queueing and task completion/reschedule share one synchronous SQLite
transaction. Repeated delivery
does not duplicate pings or deletions because `pong_deadline` and row removal
are durable idempotency state. A stale already-due platform alarm is replaced
with a short prompt rather than being allowed to disappear after the current
RPC; a still-future earlier prompt is preserved to avoid starvation. WebSocket
closure tombstones and authorization failure rows add their own due times to
the same derived minimum. API3 pruning and the remaining non-plugin jobs still
need task adapters in the shared table before using the same one-alarm
slot. API3 pruning, summary/activity persistence and other non-plugin jobs are
the remaining task adapters.

Initial authorization data mirrors `dataWithRecentStatuses()`. `loadRetro`
uses a separate unfiltered device-status view over the same one-day raw SQL
window. Initial filtering then keeps the newest 10 rows per device/type, so a
fixed 100-row cutoff no longer hides a group when budget remains. Snapshot
cursors share a deterministic 900,000-byte, 8,000-node, 2,000-document budget
plus a 24-level per-document depth cap; collection priority is profiles, device
status, SGVs, treatments, then food. Reaching that budget still retains only a
deterministic time-descending cursor prefix and may omit older groups. Websocket
status preserves the locked key set/order, with fixed platform assumptions for
API/careportal/boluscalc enablement. The latest one-year zero-duration Profile
Switch supplies `activeProfile` on initial authorization; changes compare
against the persisted root baseline and attach a fresh status after eviction.
`authorize` and
`loadRetro` require exactly one object payload; this is a resource/safety
tightening over permissive upstream JavaScript call shapes.

EIO3/EIO4 polling, direct Hibernatable WebSocket and polling upgrade are live in
Cloudflare version `1f7badbb-cdab-4031-8f55-f350c5277ae2`. Current
credential-free remote smoke
returned 200 for health, bounded v1 Entries and Treatments reads, exact Food
helper reads and invalid Food/Profile route rejection, matching
v1/v2 Settings snapshots, fresh-tenant Profile/current and v2 Summary, API3
version, real ddata/database-size values, the default-enabled Basal and AR2 properties and the opt-in-disabled
Loop/OpenAPS/Pump/IOB/COB/CAGE/SAGE/IAGE/BAGE property gates, default Runtime
State, null disabled IOB/COB Summary
state, absence of property-only timeago and an EIO4 polling open packet;
API3 Entries without a token returned the
expected 401. Anonymous mutation and experiment probes fail closed with the
configured construction credential. A separate credentialed 25-entry
test Entry batch wrote and read back successfully, after which the
official homepage rendered `101 mg/dL`, its upward trend and a populated chart.
The version-73 browser acceptance additionally rendered 26 AR2 forecast dots.
Version 74 reloaded the connected official homepage, opened the complete
Settings form with Admin authorized/About 15.0.7, and successfully completed
the unchanged Save workflow. Its only console errors were expected browser
autoplay-policy rejections before user interaction. Version 78 replaced the
former shim with the byte-identical official Socket.IO 4.5.4 client. A clean
browser connected and authorized root, received `dataUpdate`, subscribed to
`/alarm`, loaded both content-addressed transport assets and reported zero
console errors or warnings. An independent official-client remote smoke
confirmed the same four states.
Version 79 explicitly enabled the schema-v17 feed only for the public `demo`
tenant. The official homepage rendered its one-hour seed through the existing
Entries/root-delta path; the `01:40` and `01:45` alarm turns appended new rows
and the open page advanced without reload. All other tenants remain disabled
by default. This test feed was retired by schema v22 and is not present in the
current runtime.
Version 80 added `src/pebble.ts`, a request-local adapter for the locked
`lib/server/pebble.js` contract. It preserves count/order, units, trend/delta,
uploader battery, raw/calibration and IOB/COB display shapes while capping a
request at 1,000 Entries. The 77-assertion smoke read the endpoint on a fresh
tenant, and the public `demo` tenant returned the newest two continuing
simulated Entries. The authenticated browser pass saved/reloaded/restored the
current Profile, created/read/deleted one temporary Food row, created/removed
one temporary Admin role and generated the Report output (30 SVGs and eight
canvases). The official homepage then displayed `129 mg/dL`, `+3` and
`FortyFiveUp`; all temporary mutations were restored or removed.
No real CGM or closed-loop traffic was used. Four fresh-tenant Admin-notification probes returned the readable-site
count while hiding the body, and the real browser retained the official Admin,
clock and Settings/About 15.0.7 surfaces. Direct WebSocket now keeps its FIFO
prefix durable until post-send acknowledgement. The official
homepage uses the EIO4 polling server because its locked source requests
polling; independently tested EIO3 and EIO4 WebSocket paths serve compatible
external clients. The protected Profile
save/pushed-page path passed in project release 93. The named
polling HTTP edge difference is admission at the
1,000,000-byte boundary for malformed UTF-8: NSCF counts streamed raw bytes,
while locked Node can count the replacement-decoded text differently.

Project release 96 stops treating root authorization and v2 ddata as aliases.
The `/api/v2/ddata/at` adapter now represents the full enumerable
`ddata.clone()` surface: complete latest Profile store, full bounded one-day
DeviceStatus loader, raw Food, the ordinary 2.5-day Treatment window plus
one-year zero-duration Profile Switch and 62-day age-event markers,
`lastProfileFromSwitch`, Activity and all eight `processTreatments(true)`
arrays. The root `dataWithRecentStatuses()` projection independently removes
`@@@@@` Profile stores, retains ten statuses per device/type and omits Activity
and derived buckets. Current requests additionally read at most 100 Treatments
whose durable `updated_at` is within 15 minutes, reproducing the Node hot-cache
visibility of freshly submitted backdated data across DO eviction. Explicit
historical frames never use this recent-mutation path. Every cursor remains
inside the shared 900-KB/8,000-node/2,000-document payload budget.

Project release 95 separates the two upstream Activity surfaces instead of
inventing one shared payload. `/api/v2/ddata/at` is based on `ddata.clone()`
and now receives a SQLite projection of the locked two-day oldest-first
Activity loader: equal instants collapse, `mills` serializes as normalized ISO,
and explicit historical frames apply the upper bound and expose
`page:{frame:true,after}`. Root Socket.IO authorization remains based on
`dataWithRecentStatuses()` and intentionally has no Activity field. The query
is streamed through the existing 900-KB/8,000-node/2,000-document budget so an
oversized lower-priority Activity set cannot erase the glucose-first snapshot.
This is collection/query compatibility; derived summary/plugin Activity
persistence remains unfinished background behavior.

Project release 94 completes EIO3 direct WebSocket and polling upgrade without
changing the official page transport. The locked Socket.IO 4.5.4
`allowEIO3` server supplied the direct-open and probe/noop/upgrade byte oracle;
persisted EIO3 protocol authority, SIO4 namespace state and client-ping/server-
pong behavior survive DO eviction. The 150-assertion public smoke exercised
real EIO3 direct WSS plus both protocol upgrades after Cloudflare propagation.
JSONP/binary remained explicit in release 94; release 99 later closed the
direct-send dequeue-before-send loss window and release 100 closed JSONP
polling for both protocol generations. Binary packets remain unsupported.

Project release 93 keeps the same Worker runtime contract and adds a
clean-source build/deployment boundary. Root `npm run build` installs the
locked Nightscout build tree, runs its webpack bundle, then generates the
official pages/assets. In a Cloudflare-created `source repo import` copy, that
same command first refreshes official source inside the temporary build
workspace while preserving the Worker name, resource bindings and plain-text
`API_SECRET`. A configuration audit fixes the build/deploy boundary and
continues to reject D1, R2, KV, Queues and routes. The Worker rejects a
too-short value before serving Nightscout. Wrangler 4.113.0 and Workers types
5.20260722.1 are pinned. This makes the repository suitable for a Deploy to
Cloudflare button. A fresh-account deployment from the private source state is
now accepted; only making the GitHub repository public and exercising the
public click-through clone path remain external release prerequisites. The post-deploy browser loaded current
test glucose and the authorized Profile Editor; an authenticated Profile
rename/save was observed as `dataUpdate`/`retroUpdate` in the already-open
official homepage before being restored.

Version 92 adds the separate official Loop remote-notification transport.
Unlike the display/alert plugin above, this is a protected API v2 request that
can forward an official remote override, carb or bolus payload to APNs when a
family intentionally configures the four Loop settings and Profile device
metadata. Nine Workers tests cover ES256 signing, all event/error branches,
bounded transport failures and HTTP permission/form behavior. The public lab
keeps the credentials absent; its 139-assertion smoke proves route admission
and v2-only mounting without sending a real instruction. The unchanged
homepage displayed current `117 mg/dL` test data, and the official Admin
page remained authorized and populated against the same active version.

Version 91 completes the official server `checkNotifications` registry.
`src/plugins/upbat.ts` maps the locked `UPBAT_WARN`, `UPBAT_URGENT` and
`UPBAT_ENABLE_ALERTS` settings, recent-30-minute selection, per-device
ten-minute-lowest battery calculation and multi-device/voltage message. The
schema-v14 task evaluates it before AR2 in official order and preserves future
activation, heartbeat repetition, exact 30-minute-plus-one-millisecond expiry,
All Clear and live `/alarm` publication without adding another Cloudflare
alarm. Alerts remain opt-in while the request-time property remains enabled by
the official default. Four new Workers tests raise the suite to 773; the
134-assertion remote gate and browser confirmed default configuration, empty
property output, current `113 mg/dL` test data, About 15.0.7 and zero
warnings/errors.

Version 90 adds the final two request-time producers missing from the official
server property registry. `src/plugins/runtimestate.ts` receives the status
surface's ordinary steady-state `loaded` value rather than inventing a
process-global boot lifecycle. `src/plugins/age.ts` now ports Battery Age:
bounded plugin context and scheduler projections select the newest nonfuture
`Pump Battery Change` plus earliest future activation, while `BAGE_*` settings
control the locked display and alert thresholds. The existing schema-v14 task
stores exact whole-hour deadlines, the inclusive minute-20 window, minute-21
clear and heartbeat repeats; no new table or process timer is required. BAGE
feeds the already-locked Summary `state.bage` mapper when enabled. This makes
all official server `setProperties` hooks request-time compatible; Uploader
Battery remains the one notification hook not yet connected to the scheduler.
Five pure/source/HTTP cases and one real DO case raise the suite to 769 tests.
The 129-assertion remote gate and browser confirmed default Runtime State,
default-disabled BAGE, `127 mg/dL`, the official chart/About 15.0.7 and zero
warnings/errors.

Version 89 adds `src/plugins/xdripjs.ts` to the request-local property and
persisted plugin boundaries. The official Node plugin keeps its notification
cadence in a module global; schema v20 replaces that process-lifetime state
with `plugin_runtime_state(plugin, body, updated_at)` inside the tenant SQLite
DO. The stored body is bounded and validated, and its update commits with
notification selection, live queueing and the next task deadline. This retains
the upstream unchanged-state minute-31 repeat after DO eviction while state
changes remain immediate. Battery warnings deliberately repeat at the normal
heartbeat, matching upstream reevaluation. Eleven pure/HTTP/property tests and
three real DO cases cover projection, persistence, future activation, exact
24-hour expiry and clear. The 125-assertion remote and real-browser gate
confirmed the default-disabled property, current `114 mg/dL` test reading, About
15.0.7 and zero console warnings/errors.

Version 88 adds `src/plugins/errorcodes.ts` to that same request-local and
persisted plugin boundary. The 121-assertion remote gate confirms the official
default enable flag without inserting an artificial CGM error into the public
tenant. Ten pure contracts and three real SQLite DO scheduler contracts prove
the complete mapping, information/urgent delivery, exact future activation and
ten-minute clear. A fresh browser rendered `122 mg/dL`, `+4`, the official
chart and About 15.0.7 with no dialog or console warning/error.

The current API3 `/storage` adapter persists each accepted subscriber frame in
the same SQLite transaction as its mutation, then wakes polling waiters or
hibernated WebSockets after commit. Hibernated sessions restore tenant and SID
authority from WebSocket attachments plus SQLite; namespace connection and room
subscriptions come from SQLite schema v9. `/alarm` connection/subscription
authority and silence rows come from idempotently repaired schema v10. Root
delta baseline and the last full comparison snapshot come from schema v11;
root write and treatment-write authority come from idempotently repaired schema
v12. Pre-v12 live sessions default those new flags to false and must
re-authorize after rollout, while their rows and data remain intact.
Schema v13 adds nullable `last_emit_at` to the existing alarm-silence rows;
activation repairs a v12 database idempotently without changing its groups,
levels or snooze times.
Schema v14 adds `background_tasks(kind, due_at, attempt_count, updated_at)` and
an ordered due-time index. Partial activation repair preserves an existing task
row while adding missing retry metadata. The one platform alarm is the minimum
of realtime, failed-authorization cleanup and task deadlines. Early
at-least-once delivery is a no-op; caught task failures persist a retry starting
at two seconds with exponential backoff capped at five minutes, so exhausting
Cloudflare's finite automatic retries does not silently discard the logical
task. `HEARTBEAT` is accepted only inside the platform-bounded 15-second to
24-hour interval.
Schema v15 adds `admin_notifies(message, body, count, last_recorded,
persistent)`. The exact upstream eight-hour API and twelve-hour cleanup windows
are evaluated from persisted timestamps; persistent warnings survive, while an
explicitly disabled Admin-notification setting clears the tenant drawer.
Schema v16 adds `data_update_debounce(kind, burst_started_at, last_event_at,
due_at, pending)` plus a pending/deadline index. A lone event keeps only a
leading-edge cooldown row and consumes no platform alarm; a second event marks
one durable trailing run. Due rows are claimed and deleted synchronously before
the corresponding background task is promoted, so repeated alarms cannot run
the same trailing evaluation twice.
Schema v22 removes the retired simulated CGM rows and table. Schema v24 removes
the old embedded `connect-dexcomshare` task and plugin state. Activation seal 28
locks the current `EntryStore` migration set.
The task projection is bounded to 64 SGVs, ten MBGs, up to 1,000 matching
current DeviceStatus rows plus the earliest future matching DeviceStatus, the
latest Profile and the newest 1,000 Treatments in the existing window and
shared 900-KB/8,000-node/2,000-document budget. It retains exact strict warn/
urgent threshold-plus-one-millisecond deadlines, source expiry, future status
activation, OpenAPS Offline start and inclusive-end-plus-one suppression, and
the next Pump quiet-night Profile-timezone boundary without minute polling.
Locked upstream root `dataUpdate` sends `dataWithRecentStatuses()` directly;
server plugin `setProperties` and notification evaluation run separately in
the Sandbox and are not an extra root-payload preprocessing stage. The
remaining transport work is Engine.IO/Socket.IO binary packets. The post-send boundary is deliberately at-least-once:
a crash may replay a frame because Cloudflare cannot atomically commit SQLite
and a network send, but it no longer loses an unsent durable frame.
Uploader Battery, BWP, CAGE/SAGE/IAGE/BAGE and DBSize are complete producers.

### Background work and server plugins

The upstream heartbeat (`lib/bus.js`) and plugin engines use process timers.
The deployed schema-v14 adapter replaces that lifecycle assumption with a
generic SQLite task table containing `kind`, `due_at`, `attempt_count` and
`updated_at`. The DO loads a bounded batch of due jobs, completes or reschedules
them transactionally and derives the next wake from storage. This follows
Cloudflare's one-alarm-per-object model: `EntryStore` stores multiple logical
events and multiplexes them through its alarm, while `DexcomShareConnector`
owns a second, independent alarm. The generic substrate is
deployed; one unified notification task connects Uploader Battery, AR2, Simple Alarms, Error
Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE, SAGE, IAGE, BAGE, Treatment Notify,
Timeago and DBSize with
their official enable gates today.

Official plugin formulas and medical calculations are not rewritten. The
build-time registry lists the locked server plugins so bundling is deterministic;
platform code supplies storage, time, settings, notifications and logging.
External push-provider delivery remains disconnected. The inbound Dexcom Share
Beta connector is implemented in its separate Durable Object, defaults off and
has simulated-service contract coverage pending real-account acceptance.

The deployed summary basal processor and pure
`bgnow`/`direction`/`rawbg`/`upbat`/`basal`/`ar2`/`simplealarms`/`errorcodes`/`xdripjs`/`loop`/`openaps`/`pump`/`iob`/`cob`/`bwp`/`cage`/`sage`/`iage`/`bage`/`runtimestate`
and `treatmentnotify` adapters plus the core notification processor,
together with the request-local Sandbox, are reusable server
calculation/property slices dispatched by the registry rather than a background
plugin engine. Basal exposes official recorded Profile/Treatment state and
Treatment Notify produces locked request objects from the persisted task
context when officially enabled. OpenAPS/Pump expose locked uploader state at
request time and their existing request objects now also execute automatically
when the official alert gates enable them;
IOB/COB/BWP use the locked official formulas and can populate request-time
Summary state when enabled; BWP computes a preview but does not execute a
Treatment or add a dosing formula.
Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE,
SAGE, IAGE, BAGE, Treatment
Notify, Timeago and DBSize request objects are arbitrated, persisted and delivered to
live `/alarm` clients by the same
internal engine. Mutations evaluate the leading edge and the schema-v14
scheduler retains only the earliest logical activation, strict threshold-plus-
one-millisecond transition, source expiry, quiet-night boundary or heartbeat.
All sixteen official notification-producing server plugins are connected; no
downstream medical formula was invented. The age producers use bounded latest
current/earliest-future Treatment rows, exact whole-hour thresholds, the locked
inclusive 20-minute window and automatic clear. DBSize uses the actual SQLite
file byte count and remains opt-in.

## Why no D1 or R2

D1 would centralize cross-tenant relational queries, but NSCF needs the
opposite property: strongly consistent per-tenant state with the smallest
possible operational footprint. Each DO already contains SQLite, so D1 would
duplicate storage and add an unnecessary resource.

R2 is intended for objects and large blobs. SGV records are small structured
rows and need range ordering and uniqueness. Official browser files are served
by Workers Static Assets, so R2 is also unnecessary for the UI.

Queues, KV and custom domains are intentionally absent from `wrangler.jsonc`.
The same file sets `keep_vars: true`: Cloudflare dashboard text variables are
otherwise overwritten by Wrangler deploys. This is operational preservation,
not credential storage in Git. Encrypted Secrets remain the required
production mechanism, and the configuration audit rejects a checked-in `vars`
object as well as every out-of-scope product binding.

## Runtime and safety boundaries

- Maximum request body: 512 KiB; maximum POST batch: 100 records.
- EIO4 polling/direct-WebSocket payload controls: 1,000,000-byte advertised
  polling maximum, 128 queued packets and 256 persisted sessions per tenant.
- `/alarm` silence state is bounded to 256 distinct group names, each at most
  256 characters; it is durable ACK/emission state, not a notification history
  queue. One internal processing call is bounded to one MiB, 128 notification
  requests and 128 snooze objects.
- The narrow realtime shadow stores numeric SGV/MBG only in its historical
  20–600 columns; the canonical v1 document no longer rejects an upstream
  uploader value solely for falling outside that range.
- Ordinary Entries detail count defaults to 10 and is capped at 10,000. The
  separate aggregate count returns one SQL-derived result and is not subject
  to that result cap; long detail exports still require date partitioning.
- Entries unindexed/dateString candidates are capped at 10,000 with controlled
  HTTP 413; synchronous deletion and stored-revision cleanup are capped at 128.
- Legacy Entries pattern utilities accept at most eight expanded prefixes, 256
  numeric-brace expansions and 10,000 candidates. Release 97 keeps the indexed
  `entries/dateString` path and adds the locked selectable Treatments and
  DeviceStatus stores plus arbitrary bounded string fields; an unknown store
  falls back to Entries as upstream `prep_storage` does. Mongo query shapes are
  converted to the shared SQLite document filter before the bounded final
  pattern pass. Only the reviewed linear regex subset is executed; non-empty
  Mongo regex flags return a controlled unsupported-query response.
- A selected Entries set is currently materialized across DO RPC, final sort,
  representation and ETag hashing. Compact SGV records at ordinary client
  counts are the supported path; thousands of abnormally large custom
  documents can approach Workers Free CPU/memory limits. A total-result budget
  or streaming redesign is deferred rather than hidden.
- Official UI and calculations are not changed; no NSCF dosing logic exists.
- `API_SECRET` is the bootstrap application credential; subject access tokens
  and role documents are tenant-local SQLite records. The value is never
  committed to Wrangler config or repository docs. Cloudflare metadata tooling
  can display a plaintext dashboard variable, so the lab credential must be
  rotated and converted to an encrypted Worker Secret before non-lab use.
- The homepage ships the locked official Socket.IO 4.5.4 client. The adjacent
  adapter only appends an optional test-tenant query and has no medical or
  display logic. EIO4 polling is the current page transport; standard EIO4
  polling upgrade is available for external clients and EIO3 polling/direct/
  upgraded WebSocket is available for legacy clients. EIO3/EIO4 JSONP polling
  is implemented; binary packets remain unimplemented.
- Text asset responses are streamed rather than buffered when UTF-8 headers are
  adapted, keeping the extra Worker CPU and memory work constant.
