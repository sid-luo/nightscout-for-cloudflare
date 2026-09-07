# Upstream compatibility matrix

Last baseline audit: 2026-09-07 (15.0.8 testing branch)

The current beta changes and controlled limits are recorded in
[the 15.0.8 testing track](testing/NIGHTSCOUT_15_0_8.md). The detailed historical
15.0.7 acceptance evidence below remains historical; it is not a 15.0.8 live
deployment claim. Use the regenerated 157-file test manifest for current mappings.

## Baseline and completion rule

NSCF is an independent, unofficial Cloudflare port of
`nightscout/cgm-remote-monitor`. The locked baseline is official Nightscout
`v15.0.8` at commit
`92d0834219aa771b5837dbcbf1baeb839a200cf6`; provenance and the release archive
SHA-256 are recorded in `upstream/manifest.json`. The 764 files under
`vendor/nightscout` are an unmodified release snapshot.

NSCF is **not a complete Nightscout port yet**. A route returning HTTP 200, an
official page opening, or the official browser bundle loading is not sufficient
evidence. A component is complete only when its upstream request/response,
storage, authorization, real-time, persistence and error contracts are covered
by Workers-runtime tests and post-deploy smoke tests.

The modern `nightscout-connect` Dexcom Share source is currently **Beta** and
disabled by default. Its protocol and simulated-service contracts are covered,
while real-account community acceptance is still pending. This is separate
from the upstream legacy `BRIDGE_*`/`share2nightscout-bridge` plugin, whose
fully mocked test contract remains unresolved.

Deployed runtime candidate `56353da` passes 799/799 tests across 73
Workers-runtime files plus 23/23 audit tests, 42/42 unchanged tests across
eleven complete upstream-client files and 143/143 unchanged tests across twenty-one locked upstream
server/data-plugin files. The suite retains focused EIO4,
API3 `/storage` and `/alarm`, authorization, v1/v2 Status, all 16 locked API3
files and 25 locked v1 client/API files, and now completely maps locked
`ddata.test.js`, `dataloader.test.js`, `dbsize.test.js`, `bgnow.test.js`,
`direction.test.js`, `levels.test.js`, `cannulaage.test.js`,
`sensorage.test.js`, `insulinage.test.js`, `timeago.test.js`, `ar2.test.js`,
`iob.test.js`, `cob.test.js`, `data.treatmenttocurve.test.js`,
`openaps.test.js`, `pump.test.js`, `basalprofileplugin.test.js`,
`treatmentnotify.test.js`, `simplealarms.test.js`, `notifications.test.js`,
the complete locked `boluswizardpreview.test.js` contract,
`pebble.test.js`, `maker.test.js`, `pushover.test.js`, `pushnotify.test.js`,
`adminnotifies.test.js`, `bootevent-debounce.test.js`,
`expressextensions.test.js`,
`rawbg.test.js`, `times.test.js`, `units.test.js`, `upbat.test.js` and
`data.calcdelta.test.js`, `websocket.shape-handling.test.js`,
`api.deduplication.test.js`, `api.entries.uuid.test.js` and
`api.partial-failures.test.js`, plus `uuid-handling.test.js`,
`issue-6923-legacy-uuid.test.js`, `identity-matrix.test.js`,
`gap-treat-012.test.js`, `carb-dose-upload.test.js`,
`objectid-cache.test.js`, `sgv-devicestatus.test.js` and the complete
24-assertion `profile.test.js`, the 13-case `concurrent-writes.test.js`, the
five-case `loop.test.js`, the 13-case `settings.test.js`, the complete
`query.test.js` and `language.test.js`, the five-case `sandbox.test.js` and both
named `plugins.test.js` cases plus the locked API security, API verifyauth,
verifyauth and server API_SECRET files. The complete `pluginbase`, renderer, error-code,
utility, Care Portal, Bolus Wizard Preview and Profile Editor files run
unchanged alongside client Hashauth, Admin Tools, report-settings and Reports
against the byte-identical shipped client bundle. The editor/admin/report
workflows use locked mock transports and do not prove public credentialed
mutation by themselves; version 80's separate authenticated browser pass does
cover the named Profile/Food/Admin/Reports workflows. This is not full-port
evidence.
The historical runtime deployment used Cloudflare version
`339263b5-c3d5-400a-b3b3-0c6299722d32`. The locked upstream has 111
`*.test.js` files and a static declaration audit finds 883 active `it(...)`
cases plus one skipped case. Those sets are not directly comparable.

The historical pre-connector candidate Wrangler dry-run reports 250 Static Assets entries, 1319.52 KiB raw /
242.79 KiB gzip and only `ENTRY_STORE` plus `ASSETS`. Post-deployment API and
browser evidence below is kept distinct from those local gates. The current
Wrangler configuration additionally declares `DEXCOM_SHARE_CONNECTOR`.

Nightscout for Cloudflare package version `1.1.1-beta` is displayed as
`1.1.1-beta`; it does not change the locked or reported Nightscout version
`15.0.7`. The Settings/About panel identifies both projects separately while
preserving upstream attribution. The Admin page changes only the four legacy
Mongo-oriented presentation labels; the original-name comparison remains in
the repository documentation. The underlying actions and compatibility API
routes remain available. A clean Git
export with no dependency/build cache completed `npm ci`, rebuilt the official
bundle byte-for-byte and passed the full local and dry-run gates. An empty local
SQLite DO then passed the official first-run workflow: the no-Profile redirect,
raw-secret authentication, untouched Default/UTC Profile save, homepage
glucose/chart render, remembered authorization, Food create/delete and Admin
load. Private release acceptance 101 subsequently deployed Git commit
`0706d33` to a newly registered Cloudflare account and repeated the
213-assertion remote protocol smoke, protected Profile persistence, first-run
Save, remembered Admin workflow and simulated homepage chart. Stable
Nightscout for Cloudflare `1.0` remains unclaimed until the public Deploy-button
clone path and user-operated Loop/AAPS pass are complete.

The deployed increment connects Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS,
xDrip-js, Loop, BWP,
CAGE, SAGE, IAGE, BAGE, Treatment Notify, Timeago and opt-in DBSize to the core notification
processor through one persisted task. AR2 preserves the official coefficients, six-point projection,
average-loss quirk, threshold notifications and 13-step forecast cone. Simple Alarms
preserves strict recent/nonfuture input and urgent/warning threshold behavior,
messages, event names, titles and sounds. Error Codes preserves the eight named
and fallback display values, three code-specific sounds, default and literal-
`off` custom levels, newest nonfuture selection and strict ten-minute expiry.
The opt-in xDrip-js port exposes the locked `sensorState` property and pill
fields, preserves state/battery alert metadata, newest eligible 24-hour
DeviceStatus selection and the unchanged-state whole-minute repeat quirk, and
stores its small throttle marker in schema v20 so eviction does not restart the
cadence.
Uploader Battery maps the locked `UPBAT_*` settings, selects recent
DeviceStatus per device, preserves the ten-minute-lowest battery calculation
and multi-device/voltage message, and retains future activation, heartbeat,
expiry and All Clear through the same persisted task.
The processor preserves request
reset, urgent/warning priority, information/announcement handling, longest
eligible snooze and automatic all-clear. Schema v13 stores last-emission state;
a bounded internal RPC persists and publishes the selected live `/alarm` object
atomically. Schema v14 adds a generic persisted task table, and canonical data
mutations now evaluate all sixteen producers in official server order on the
leading edge. The task retains the earliest activation, exact age threshold and
minute-21 clear, strict threshold-plus-one-millisecond transition, source
expiry, quiet-night boundary or heartbeat.
This is not an external provider.
Basal preserves the current scheduled/Temp Basal/Combo Bolus rate,
property, pill, visualization and assistant behavior and is enabled by the
official default feature set. Treatment Notify preserves recent-record
selection, manual/automatic filtering, snooze, calibration/treatment/target/
announcement request shapes and the synchronous `node:crypto` SHA-1
notification hash. It runs automatically only when the official enable gate
includes `treatmentnotify`. Timeago's strict `>` stale transitions wake at
threshold plus one millisecond and require truthy `TIMEAGO_ENABLE_ALERTS`.
Both branches remain dormant under the public upstream-default settings. Pump,
OpenAPS and Loop additionally retain their official plugin plus alert gates and
therefore also remain dormant under those defaults. Their automatic adapters
preserve future DeviceStatus activation, source expiration, OpenAPS Offline
start/inclusive-end suppression and Pump quiet-night timezone boundaries.
External delivery is not connected. IOB, COB and
treatment-to-curve ports retain the official
DeviceStatus sources and precedence, Treatment fallback, Profile/DIA/
sensitivity/carb-ratio inputs, recency, formula, display and assistant behavior.
They remain opt-in and now populate v2 Summary state when enabled. BWP reuses
the locked Profile/IOB/SGV/carb formula, exact display flooring, target and Temp
Basal preview, warning/urgent requests and IOB snooze. It feeds v2 Summary and
Pebble when enabled but does not execute a Treatment or add a dosing formula. Ddata retains
official Treatment marker placement, unit caps and raw-BG fallback. The DO
projects the upstream 2.5-day ordinary-Treatment, one-year zero-duration
Profile Switch, current Profile and 62-day age inputs, with a newest-1,000
ordinary-Treatment Free-plan cap under the existing JSON budget. The automatic
notification projection separately caps current matching DeviceStatus at 1,000
while retaining the earliest future matching status, 64 SGVs, ten MBGs and the
latest Profile under the shared 900-KB/8,000-node/2,000-document budget. The prior
dataloader/database-size, age/timeago, Sandbox, Profile, units and times ports
remain formula-compatible. Age and DBSize notifications are now persisted
producers under their official gates. Missing algorithms are not fabricated, and no dosing
recommendation was added. Version 86 now runs this same Treatment-to-curve
preprocessing inside the bounded Durable Object root snapshot, before each
Treatment consumes its JSON budget. Both the initial root `dataUpdate` and a
post-eviction pushed delta therefore carry the locked marker fields; this is no
longer a v2-only adapter.

The platform maps Cloudflare's whole-file
[`databaseSize`](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
to upstream `dataSize` plus zero `indexSize`, and maps the documented Workers
Free [one-GB per-object limit](https://developers.cloudflare.com/durable-objects/platform/limits/)
to 953.67431640625 MiB for the unchanged plugin. It also retains Wrangler `keep_vars: true` to
preserve dashboard-managed text variables across deploys and adds a deployment
configuration audit that rejects checked-in plaintext vars and every
out-of-scope Cloudflare product binding.

The manifest is 16 `pass`, 86 `adapted`, seven `unresolved` and two fixed-scope
exclusions. Version 81 passed remote API/Engine.IO/Pebble, provider-callback
and real-browser test-data gates; the prior version 78
passed the official Socket.IO-client/EIO4 and a
clean-profile real-browser gate. These are historical checks, not acceptance evidence for the latest release.

## Generated route and test inventory

`upstream/contract-manifest.json` is the version-controlled source of truth for
the route/test audit. It is generated from the locked Express/API v1/v2
registration modules, the API v3 registration code, and every
`vendor/nightscout/tests/**/*.test.js` file. The generated
`docs/UPSTREAM_TEST_MANIFEST.md` presents the same 111-file status set in
dependency order for dispatch.

The current manifest contains 161 HTTP registrations: one API version-discovery
route, 45 v1 routes, 62 v2 routes (including the upstream v1 router inherited by
v2), and 53 v3 routes. API v3 accounts for the only reviewed dynamic expansion:
six names read from the locked `enabledCollections` setting multiplied by eight
generic route templates in `lib/api3/generic/collection.js`, plus four specific
API routes and the documentation prefix redirect. The collection/template
expansion and its source files remain explicit in
`upstream/contract-overrides.json`; it is not presented as a fully general
JavaScript static analysis result.

Run the generator after changing the vendor lock or a manual dynamic override,
and run its check in CI and before commits:

```sh
npm run upstream:audit
npm run upstream:audit:check
npm run test:upstream-audit
```

The checker enforces stable ordering, unique API-version/method/path keys,
locked registration-source hashes, exact static/dynamic overlay agreement with
the locked registrations, exact auth/condition override targets, re-derived
syntactic `mount_chain` entries, exact registration/handler source anchors,
exactly 111 upstream test files, known status values, non-empty reasons, and
byte-for-byte freshness of both generated outputs. A mount chain is not a full
runtime provenance or call-graph proof: it does not prove reachability,
middleware order, handler execution, or test coverage, and API v3 dynamic
chains intentionally stop at the locked `genericSetup` call. The
default test-file status is `unresolved`. At this audit point, eight files are
`unresolved`, one integration is `excluded-fixed-scope`, 86 files are
`adapted`, and sixteen complete files are unchanged `pass` entries.
The exact file-by-file reasons are generated in
`docs/UPSTREAM_TEST_MANIFEST.md`; this prose does not maintain a second,
potentially stale inventory.

Route/test associations remain dispatch heuristics. Direct literal HTTP calls
are filtered by their path-local method when that method can be statically
seen; dynamic paths, plain-text references, prefix ambiguity, and API v3
operation-filename hints still require manual confirmation and are not coverage
evidence. The locked API v3 settings search and both settings-history forms are
recorded as the explicit `api:settings:admin` exception shown by
`lib/api3/generic/search/operation.js:20-24` and
`lib/api3/generic/history/operation.js:131-135`. Ordinary collection
search/history (including tombstones; history fixes `onlyValid = false` at line
24) remains read-protected, as does the single-record settings read route.

The only fixed-scope exclusion is the MiniMed CareLink integration
(`mmconnect`). The legacy Dexcom `bridge` contract remains unresolved rather
than being treated as live-credential-only. The `maker`, `pushnotify`, and `pushover` tests replace their
external requests and exercise internal mapping, validation, deduplication,
all-clear/cancel, and multi-key behavior, so they remain `unresolved`. Storage,
simulated entry ingestion, notification state, authorization, API behavior,
server calculations, real-time transport, and browser workflows also remain
required and unresolved.

## What cannot run unchanged, and what only needs adaptation

| Upstream dependency | Evidence in v15.0.7 | Classification | Cloudflare path |
| --- | --- | --- | --- |
| Node HTTP server and Express | `lib/server/server.js:41-75` creates a Node server, calls `listen()`, attaches Socket.IO and starts a process-lifetime timer. | **Partly reusable, not an absolute blocker.** Current Workers support Node HTTP servers and an Express adapter, but this exact process bootstrap still assumes one permanent process. | Reuse upstream Express routers where they do not depend on process-global state; expose them through a Worker request handler or reproduce only their platform boundary. [Cloudflare Node HTTP](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) and [Express tutorial](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/). |
| File system and localization/assets | `lib/server/server.js:29-34`, `lib/language.js:149`, and `lib/server/app.js:129,254-255` read bundled files. | **Adaptable.** `node:fs` is now available through Workers' virtual file system. Runtime mutation and arbitrary host paths remain unsuitable. | Prefer build-time asset discovery and Static Assets; use bundled virtual files only where it reduces divergence. [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/). |
| MongoDB connection and collections | `lib/storage/mongo-storage.js:105-221` creates a connection pool, retries forever, exposes `db.collection()` and creates indexes. | **Cannot run unchanged within the fixed platform scope.** This project deliberately has no Mongo service and must use SQLite Durable Objects. | Implement a Mongo-compatible repository contract over DO SQLite, including query conversion, indexes, collection behavior and migration tests. [SQLite-backed DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). |
| Mongo ObjectId and query semantics | `lib/server/query.js:28-175`, `lib/server/entries.js`, `lib/server/treatments.js` and `lib/authorization/storage.js` depend on ObjectId, nested Mongo operators, sort, projection and upsert behavior. | **Engineering adaptation.** ObjectId formatting is easy; behavioral parity is not. | Preserve 24-hex identity and UUID fallback rules, then port operators and collection-specific dedupe as contract-tested SQL/JSON operations. |
| Process-global bus and mutable caches | `lib/bus.js:4-36`, `lib/server/bootevent.js:271-330`, `lib/notifications.js`, `lib/adminnotifies.js` and `lib/plugins/xdripjs.js` keep timers, listeners, alarm state and notification-throttle markers in memory. | **Runtime lifecycle conflict with a platform adaptation.** Workers and DOs may be evicted and reconstructed. Notification snooze/emission state, realtime and authorization deadlines, schema-v14 task/retry state, schema-v15 Admin notices, schema-v16 data-update debounce and schema-v20 xDrip-js throttle state are authoritative in SQLite. The complete nine-case `bootevent-debounce.test.js` contract is adapted with leading/trailing/max-wait behavior and DO serialization; all sixteen alert producers run automatically. | Retain the idempotent producer task and add remaining non-plugin task kinds; never make isolate memory authoritative. |
| Socket.IO / Engine.IO | `lib/server/websocket.js:87-164` attaches Socket.IO with polling and WebSocket transports. Locked `lib/client/index.js` explicitly requests polling for the official 4.5.4 browser bundle; `allowEIO3` retains EIO3/SIO4 legacy clients. Later handlers implement authorization and database mutations. | **Partial platform adaptation; EIO3/EIO4 XHR/JSONP polling, direct WebSocket and polling upgrade deployed.** Persisted transport authority runs on the tenant DO. EIO4 follows the upstream `2probe`/`3probe`, polling-noop and `5` upgrade order; EIO3 follows its length-prefixed noop, client-ping/server-pong, SIO4 framing and two-stage root CONNECT/`clients` order. Both preserve polling on cross-protocol, duplicate, malformed, abandoned or alarm-timed-out candidates, and both retain protocol/namespace state across DO eviction. Schema v21 retains the initial JSONP callback index and form-POST framing across reconstruction. The byte-identical official client remains polling-only by upstream choice; only an optional test-tenant query is adapted. Root plus API3 `/storage` and `/alarm`, root writes, Treatment-to-curve preprocessing, core notifications and all sixteen automatic producers are named compatible subsets. Release 99 retains a direct-WebSocket FIFO prefix until post-send SQLite acknowledgement, eliminating silent pre-send loss; the unavoidable non-atomic boundary may replay a frame after a crash. Binary packets remain incomplete. | Keep official-client polling and both protocol-generation WebSocket gates green; add binary packets only if ordinary client evidence requires them. [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). |
| `setInterval` and periodic work | `lib/bus.js:35`, `lib/plugins/bridge.js:116` and `lib/plugins/mmconnect.js:25` assume a permanent event loop. | **Runtime conflict with a deployed scheduling substrate.** Intervals cannot be authoritative. `EntryStore` persists realtime, authorization and local task deadlines and multiplexes them through its alarm. The optional `DexcomShareConnector` uses a separate alarm, performs bounded vendor HTTPS outside `EntryStore` and writes validated Entries through typed RPC. The former schema-v17 simulated CGM was retired by v22; v24 removes its old embedded connector task/state and activation seal 28 locks the current `EntryStore` set. | Add remaining bounded, retry-idempotent non-plugin task kinds. Alarms are at-least-once and Cloudflare documents one scheduled alarm per DO. [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/). |
| Server plugin registration | `lib/plugins/index.js:25-80` statically requires the official plugin set; `lib/server/bootevent.js:209-246` creates server plugins from runtime settings. | **Mostly build/runtime adaptation.** Static requires can bundle; process-global contexts and plugin state cannot be trusted. | Generate a build-time registry from the locked tree and give each server plugin a persisted, tenant-scoped execution context. Do not rewrite official calculations. |

Cloudflare therefore does not make a full port impossible. The earlier scope
was conservative: it stopped after official page assets and page-used APIs.
The remaining work is substantial platform adaptation, not a fundamental
platform prohibition.

## Module-by-module status

Legend: **Compatible** means the claimed contract has tests; **Partial** means
only a named subset exists; **Missing** means no runtime implementation exists.

| Area | Upstream source of truth | Current status | Required acceptance evidence |
| --- | --- | --- | --- |
| Upstream identity and UI bytes | `package.json`, `webpack/webpack.config.js`, `views/**`, `static/**`, `translations/**` | **Compatible for built assets.** v15.0.7 is pinned; official pages and bundle are served without a replacement UI. | Rebuild from clean vendor snapshot; byte/provenance assertions; browser rendering on every deploy. |
| Express boot model | `lib/server/server.js`, `lib/server/app.js`, `lib/server/bootevent.js` | **Partial.** Routes are currently hand-dispatched by `src/index.ts`; upstream Express boot is not running. | Decide router-by-router reuse versus adapter; contract-test middleware order, content negotiation and error handling. |
| Collections and indexes | `lib/storage/mongo-storage.js`, server storage modules | **Partial platform surface; complete locked storage-shape file adapted.** SQLite generic documents cover all six official collections with indexed metadata, an API3 allocation clock and atomic change snapshots. The 26-case storage-shape adapter locks Treatment/DeviceStatus scalar/one/many/20-document writes, Entry arrays, Profile/Food/Activity create/save/created-at behavior, fresh ObjectId fallback for missing or invalid direct-storage save IDs, authorization replacement without duplicates and explicit one/many SQLite batch cardinality. Public v1/v2 invalid-ID checks still run before that internal fallback. Raw Mongo `insertOne` is a runtime-only driver observation and is not exposed as a fake collection façade. The complete concurrent-write file additionally proves simultaneous writes, unique IDs and bounded AAPS/AndroidAPS recovery through one tenant DO. Older Profile/Food rows receive idempotent metadata/fallback repair. Settings preserves the upstream no-fallback rule. Entries has date/dateString/type indexes plus a narrow compatibility shadow. Its v6 probe resets only an incompatible pre-1.0 shadow and preserves canonical documents/profile; it is deliberately not a legacy importer. Healthy activation is a read-only probe. This does not import an external Nightscout/MongoDB database. | Prove in-place activation from every supported NSCF schema while preserving canonical data, and complete mixed-type/index/query differential behavior. Keep external Nightscout/MongoDB history import as separately scoped future work; make no first-release import claim. |
| ObjectId, UUID and dedupe | `lib/server/query.js`, `lib/server/treatments.js`, `lib/api3/storage/mongoCollection/utils.js` | **Locked Query, validation, UUID, issue-6923, identity-matrix, GAP-TREAT-012, ObjectIdCache, deduplication and partial-failure files adapted; broader BSON behavior partial.** `src/server-query.ts` replaces Mongo's ObjectId class with a Worker-safe 24-hex value object at the adapter boundary while preserving the locked `toString()` result, non-ObjectId strings and current UUID identifier fallback. Generated IDs remain random 24-hex strings. Treatments match exact true-by-default `UUID_HANDLING` parsing and legacy repair. Identifier-first upsert, AAPS/Loop/xDrip field isolation, repeated-identifier dedupe and MongoDB 5 `{acknowledged,deletedCount}` deletes are locked. Entries use `sysTime + type`; Treatments prefer `identifier`/`_id`, then `created_at + eventType`. Descriptive `pump`, `sync` and generic `id` fields do not become invented unique indexes. Profile/Food and API3 retain their tested selectors; Settings has no fallback. | Extend mixed BSON/type and remaining collection fixtures. The 4,096-character identity and 1,000-item v1 batch caps are Free-plan controls; the latter remains above xDrip's 300-item recovery queue. |
| Mongo query behavior | `lib/server/query.js`, `lib/api3/storage/mongoCollection/**` | **Complete locked `query.test.js`; wider Mongo surface partial.** A request-local adapter preserves the four-day default, configurable date field/window, ID date-filter bypass, non-ObjectId strings and ObjectId-shaped normalization without `mongodb`, `traverse` or `moment`; live Entries parsing reuses its default and ID normalization. V1 Entries supports equality/comparison for numeric and bounded string fields, supported-field sort-before-limit and final time ordering. Legal shapes above SQLite limits fail as controlled 400. API3 supports locked scalar operators, safe nested/unknown fields, projection/paging, ordered sort chains and a bounded case-sensitive `$re` subset compiled to GLOB. Mixed types, arrays, projections and collation remain incomplete. | Add `$in`/`$nin`/regex/exists and nested/array/mixed-type differential coverage before widening the v1 allowlist or calling generic search compatible. Other v1 collections still use limited filtering. |
| API v1 entries | `lib/api/entries/index.js`, `lib/server/{entries,treatments,devicestatus}.js` | **Complete locked Entries, Entries UUID, deduplication and partial-failure mappings; broader route semantics partial.** Create/list/current/model/ID/delete include single/array/extended-urlencoded uploads, preview, uploader identity, ordered-prefix failures, collection-specific dedupe, bounded query/sort, four-day reads, JSON/plain/CSV/TSV, validators and HEAD. Exact numeric-date, exact `dateString` and open dateString-range deletion are implemented. Cloudflare zero-byte DELETE streams normalize to the same absent body as upstream/local requests, with a public-edge create/delete/read contract. V1 and inherited v2 `echo` apply the locked Entries, Treatments and DeviceStatus query options; SQL count and `slice` select those same stores, with unknown names falling back to Entries. The locked numeric-brace `times/echo`, `times` and arbitrary bounded string-field `slice` fixtures run through at most eight prefixes, 256 expansions and 10,000 candidates. Arbitrary aggregation, unrestricted regex/large-detail materialization and wider Mongo/document semantics remain incomplete. | Port the remaining related route/error surface while retaining explicit Free-plan pattern/query bounds and the fresh-only pre-1.0 reset. |
| API v1 document CRUD | food/profile/treatments/devicestatus modules | **Food/Profile/DeviceStatus and the named Treatment/Loop uploader files adapted.** Food and Profile cover their complete named upstream files. Food root/regular reads ignore unused query options, while quickpicks applies exact `type:quickpick` plus string `hidden:false` matching and Mongo-like position order. Profile preserves the distinct singular count-only, plural query/read-only and current routes; invalid children return 404. Non-Treatment reads preserve stored fields instead of receiving the Treatment numeric mapper. DeviceStatus covers both its base and Loop SGV/DeviceStatus files plus the locked prediction policy. Treatments maps XSS/time/numeric/upload/query behavior plus complete `api.treatments`, UUID-handling, issue-6923, identity-matrix, GAP-TREAT-012, carb/dose and ObjectIdCache contracts, including exact flag parsing, UUID repair, ordered server-ID responses, cached-ID mutations and MongoDB 5 delete results. Its Worker sanitizer retains reviewed safe tags but strips all attributes, deliberately stricter than DOMPurify beyond the locked malicious fixture. `api.shape-handling.test.js` locks cross-collection scalar/array and NightscoutKit shapes. Version 93 adds protected Profile save/reload/restore and pushed-page evidence. | Keep bounded count limits and safe-attribute DOMPurify byte parity as documented platform differences; add broader collection/page workflows incrementally. |
| API v1 activity | `lib/api/activity/index.js`, `lib/server/activity.js`, `tests/api.activity.test.js` | **Locked upstream file adapted.** Create/list/filter/conditional GET/update/delete, empty-array create, ID validation and the official `{}` delete response follow the complete named upstream file. | Add credentialed remote CRUD evidence when a test credential is explicitly supplied; retain the current bounded platform controls. |
| Remaining API v1 | notifications, Alexa, Google Home and remaining utilities | **Partial.** Inherited GET `/notifications/ack` is adapted on v1 and v2 with durable repeat suppression, Urgent-to-Warning silence and live `clear_alarm` delivery. Admin notices preserve the public count/admin-body split and persisted readable-site/failed-auth producers. The locked Alexa test file is adapted as a local en-US REST/Speechlet envelope for LaunchRequest, unknown intent and SessionEndedRequest; it performs no Amazon call. Pushover/Google Home/external Alexa connectivity remain disabled. | Port remaining scope-allowed routes from the generated inventory. Keep external integrations disabled in the simulated-data deployment, but retain mocked internal contracts. |
| API v2 properties and ddata | `lib/api2/index.js`, `lib/data/{ddata,endpoints,dataloader,treatmenttocurve}.js`, `lib/api2/properties.js`, `lib/{times,units,levels}.js`, `lib/plugins/{bgnow,direction,rawbg,upbat,basalprofile,loop,openaps,pump,iob,cob,dbsize,cannulaage,sensorage,insulinage,batteryage,timeago,ar2,runtimestate}.js` | **Every official server `setProperties` producer and twenty-four named/source contracts adapted; full ddata and root projections are distinct.** `/ddata/at` selects live versus explicit frames with bounded two-day SGV and Activity windows, publishes the real tenant SQLite file total and applies official Treatment-to-curve marker fields. Release 96 gives it the full enumerable `ddata.clone()` shape: complete latest Profile store, full bounded one-day DeviceStatus loader, raw Food, ordinary/Profile-Switch/age-event Treatment loaders, `lastProfileFromSwitch`, Activity and all eight `processTreatments(true)` arrays. Root authorization remains the separate `dataWithRecentStatuses()` shape with `@@@@@` Profile history removed, ten statuses per device/type and no Activity/derived buckets. Current snapshots additionally include at most 100 Treatments mutated within 15 minutes as a durable equivalent of the upstream hot cache; explicit frames do not. The prior complete data/property files plus Basal, all ten AR2, all six OpenAPS, ten Pump, 14 IOB, nine COB, BAGE, Runtime State and one treatment-to-curve case set are represented. `/properties`, wildcard/comma selection and truthy `pretty` are deployed; default Runtime State/Basal/uploader/database-size and opt-in Loop/OpenAPS/Pump/IOB/COB/CAGE/SAGE/IAGE/BAGE execute through the registry, while AR2 follows the official `ALARM_TYPES=predict` gate. The property projection includes 64 SGVs, latest calibration, ten recent MBGs, recent DeviceStatus/stats/current Profile, one latest 62-day age event per type, one-year zero-duration Profile Switch and the newest 1,000 ordinary Treatments from the upstream 2.5-day window, with Profile Switch/Temp Basal/Combo Bolus groupings. Timeago is correctly not fabricated as a property. Basal describes recorded Profile/Treatment state; AR2 derives only the official display/forecast/notification values from SGVs; OpenAPS/Pump display uploader-provided state; IOB/COB preserve official formulas; none recommends a dose. The rolling-deploy adapter falls back only when an old live DO lacks the property-context RPC. | Extend endpoint/error/retro and multi-device differential fixtures beyond the complete named/source files. Keep the 1,000-Treatment Free-plan cap explicit. |
| API v1/v2 Status | `lib/api/status.js`, v1/v2 router mounting and final error chain | **Strict named surface deployed, with one transport P2.** Locked extension/Accept negotiation, txt/json/js/png/svg paths, redirects, uppercase/trailing-path bugs, GET/HEAD representation lengths, method finalhandler behavior, query-only `authorized` derivation and production 406/404 bodies are contract-tested. Remote text/Accept forms returned 200 and an unknown extension returned 404. Cloudflare strips `Content-Length` from dynamic responses, including HEAD; status code, `Content-Type`, `Vary` and empty-body semantics are correct. | Preserve this P2 as an explicit platform difference and expand public smoke to every locked representation; do not infer other v1/v2 route compatibility. |
| API v2 authorization | `lib/authorization/**`, `lib/api/verifyauth.js`, `lib/api/experiments/index.js` | **Four named server auth files plus Admin notices adapted with documented hardening.** Role/subject CRUD, per-tenant signing keys, eight-hour HS256 issuance/refresh, derived access tokens and prefix matching, body/query/header precedence, signature/expiry verification, live role lookup, persisted per-IP failure delay, Shiro 0.4.10 and `verifyauth` are implemented. The exact `authorization:debug:test` probe is inherited through v1/v2. Complete Workers mappings cover `api.security`, `api.verifyauth`, `verifyauth` and all three active `security.test.js` cases; client `hashauth.test.js` and server `adminnotifies.test.js` run unchanged. Failed attempts emit the upstream warning without retaining credentials. Enforced delay is capped at 60 seconds, transient Admin messages at 128 per tenant, and repeated/bracket `secret` arrays are safely resolved or rejected instead of reproducing the locked unhandled rejection. | Set a valid deployment API secret before final credentialed smoke; preserve the named platform caps and array hardening as explicit differences. |
| Settings, language and status configuration | `lib/settings.js`, `lib/language.js`, `lib/server/env.js`, v1/v2 Status and Socket authorize | **Complete Settings and Language test-file adapters; process configuration partial.** Fresh request-local objects preserve locked defaults, environment accessors, feature/alarm rules, recursive secure filtering, English identity, positional/object placeholders, supported language metadata, case-sensitive/insensitive lookup and filename fallback. Static Assets replaces server `fs`; all 33 deployed translation JSON files are valid and byte-identical to v15.0.7. `LANGUAGE` reaches HTTP/Socket settings so the unchanged browser loader selects the official dictionary. The broader Node process/filesystem discovery and generic extended-settings loader are not ported. | Map remaining supported Worker variables through a deterministic tenant context, use the same request-local translator in every remaining server plugin/notification path, and keep secret fields out of status/logs. |
| API v2 summary/notifications | `lib/api2/summary/**`, `lib/profilefunctions.js`, `lib/plugins/{iob,cob,boluswizardpreview,batteryage}.js`, `lib/api2/notifications-v2.js`, `lib/server/loop.js` | **Core summary, inherited ACK and the Loop remote-push protocol/transport adapted; persistence still partial.** `/summary/` ports the locked hour filter, SGV/noise mapping, carb/insulin events, temporary targets, temp-basal/profile schedule processor and recursive `timeAsSeconds` removal. Its current-profile path uses the 24-assertion Profile adapter and the request-time registry supplies enabled official IOB/COB/BWP/BAGE state. `/notifications/loop` preserves the exact `notifications:loop:push` permission, JSON/form bodies, credential/Profile validation order, four official event types, alert/custom payload fields and upstream callback errors. Workers Web Crypto signs the Apple ES256 provider JWT; bounded awaited `fetch` replaces `@parse/node-apn`, selects sandbox/production and maps APNs failures. Nine local contracts inject the network and verify the signature/request without contacting Apple. The public lab has no `LOOP_APNS_*` credentials, sends no real override/carb/bolus instruction and therefore does not prove live Apple delivery. | Add remaining summary/activity persistence without rewriting formulas; run a separately authorized credentialed APNs acceptance only when a non-medical test device/key is available. |
| Legacy Pebble endpoint | `lib/server/pebble.js`, `tests/pebble.test.js` | **Complete locked endpoint contract adapted with bounded platform context.** `/pebble` and `/pebble/` preserve newest-first count selection, mg/dL/mmol formatting, direction/trend, delta, uploader battery, raw filtered/unfiltered/noise/calibration fields and official IOB/COB/BWP display mapping. The live route applies `api:pebble,entries:read`, tenant routing and HEAD behavior. Cloudflare bounds `count` to 1,000 and replaces process-global `ddata`/dynamic plugin access with request-local DO context. | Keep the locked contract and remote smoke green; BWP remains opt-in and is omitted under public defaults. |
| API v3 version/status/security | `lib/api3/specific/version.js`, `specific/status.js`, `security.js`, `tests/api3.{basic,security}.test.js` | **Two adapted whole-file contracts.** `/version` is public; `/status` requires a valid tenant JWT and returns the locked v15.0.7 error/envelope shapes. Its permission-loop bug is preserved: every collection is evaluated against `api:undefined:<action>`, so a readable JWT reports `r` for all six registry keys. Missing and invalid Bearer errors, denied/allowed permissions, API OPTIONS and implicit HEAD are locked. | Named Workers-runtime coverage adapts the complete locked `api3.basic.test.js` and `api3.security.test.js`; the security fixture uses its exact empty default-role setting. Current-version remote GET/HEAD/OPTIONS and missing-token smoke confirm the public boundary. |
| API v3 generic collections/lastModified/history/rendering | `lib/api3/generic/**`, `specific/lastModified.js`, `shared/renderer.js`, `tests/api3.*.test.js` | **Locked 16-file API3 test set adapted; bounded platform parity.** All eight generic routes are wired for entries, treatments, device status, profile, food and settings, and all six participate independently in `/lastModified`. JWT auth, validation/permission order, shape handling, UUID/ObjectId/fallback identity, dedupe/resurrection, conditional/projection reads, complete CRUD/history/tombstone/permanent-delete workflow, v1-created reads, AAPS patterns, ordered search, storage paging/mutation metadata and locked JSON/CSV/XML negotiation are represented. Settings retains its admin/read exception. Search/history share the configured lower `API3_MAX_LIMIT` under a hard 1,000-row Workers ceiling. | All 16 locked `api3.*` files have complete named Workers-runtime contract mappings. Keep large-result CPU/memory controls and broader Mongo mixed-type/nested/array/regex differential behavior documented as controlled platform work; do not infer unrestricted behavior beyond the locked suite. |
| Main Socket.IO namespace | `lib/server/websocket.js`, `lib/data/{calcdelta,treatmenttocurve}.js` | **Partial server surface with EIO3/EIO4 XHR/JSONP polling, direct/upgrade WebSocket, official polling client, root writes, Profile Switch status and Treatment marker preprocessing adapted.** Exact `/socket.io` and `/socket.io/` requests route to tenant DOs. Persisted sessions/queues, protocol-aware heartbeat/framing, SIO4/SIO5 root CONNECT, `clients`, read/write/treatment-write authorize/ACK, initial/retro data and subsequent locked `dataUpdate` deltas are tested across polling, direct WebSocket, polling upgrade, reconstruction, mixed-protocol broadcast and tenant/authorization boundaries. Both protocols advertise `websocket`; exact probe/noop/upgrade, abort, cross-protocol, duplicate and alarm-timeout paths are tested through DO eviction. JSONP keeps its initial normalized callback index and URL-encoded `d=` behavior through schema-v21 reconstruction. Initial and reconstructed delta snapshots run the locked Treatment-to-curve marker placement with profile units/raw-BG gating before the shared JSON budget reserves each item. Initial `status:true` authorization includes the latest one-year zero-duration Profile Switch as `status.activeProfile`; later switches compare against the persisted SQLite root baseline and publish fresh status after eviction. The byte-identical official Socket.IO 4.5.4 page client connects root and `/alarm` over polling by its own locked option. The write-shape contract covers all four events across six collections and ACK-before-delta delivery. A SQL-derived alarm persists transport deadlines. Release 99 peeks a bounded FIFO batch, sends it, then validates/deletes the exact prefix transactionally; reconstruction before acknowledgement returns the same prefix. Binary packets remain missing. Version 93 adds protected Profile save/pushed-page evidence, release 94 adds EIO3 WSS evidence and release 100 adds JSONP evidence. | Extend Mongo/BSON differential coverage without removing Free-plan bounds; add binary transport only when an ordinary-client contract requires it. |
| API v3 storage/alarm namespaces | `lib/api3/storageSocket.js`, `lib/api3/alarmSocket.js` | **Named `/storage` and `/alarm` protocol-aware polling and WebSocket slices plus core notification processing implemented.** EIO3/SIO4 and EIO4/SIO5 polling, direct WebSocket and polling upgrade can connect either namespace independently. `/storage` locks subject access-token authorization, official default collection order, unknown-name filtering, duplicate response behavior, per-room read checks, the Settings-admin exception, persisted rooms and API3-shaped create/update/delete events from both API3 and legacy v1/v2 mutations. `/alarm` locks native-access-token priority, web secret/JWT/anonymous branches, exact subscription responses, accumulated ACK authority, all five event classifications, broadcast to every current namespace connection, live-only tenant isolation, persisted snooze/all-clear behavior and eviction/Hibernation repair. Socket ACK and v1/v2 HTTP ACK share SQLite state. The bounded internal processor consumes upstream request/snooze arrays, persists its selection and publishes atomically. One schema-v14 task publishes all sixteen named producers through this outlet. | Add credentialed remote delivery/ACK evidence. Preserve live-only/no-disconnected-replay behavior and bounded broken-recipient isolation. |
| Real-time database updates | `lib/server/bootevent.js:271-330`, `lib/data/{calcdelta,treatmenttocurve}.js`, websocket and API3 storage socket | **Partial: API3 storage, root deltas, Treatment marker preprocessing, locked client root writes and Profile Switch status implemented.** Each implemented document mutation persists `document_changes` atomically with its current document. Successful HTTP API3 mutations enqueue bounded `/storage` frames and a root delta in the transaction; implemented legacy v1/v2 mutations publish API3-shaped `/storage` frames and advance/publish the root baseline through the DO. Legacy entries use `date`, while other legacy generic documents use `created_at`, as a consistent virtual HISTORY/`lastModified` cursor so AAPS NSClientV3 can recover ordinary chronological uploads after a disconnect. Schema v11 delta state and schema v12 write authority survive reconstruction; unauthorized/read-only sessions cannot mutate, and successful client ACKs precede their delta. The official homepage receives its initial root update through EIO4 polling. Initial and post-eviction delta Treatments receive upstream marker fields before payload budgeting; Profile Switch writes publish the locked active-profile status after SQLite DO reconstruction. Version 93 observed an authenticated Profile save as live `dataUpdate` and `retroUpdate` events in the open official homepage. Locked upstream root updates send `dataWithRecentStatuses()`; Sandbox property/notification evaluation is separate and must not be injected into the root payload. | Define retention/pruning for the unbounded `document_changes` journal separately; it is not the live transport queue and upstream `/storage` provides no disconnected replay. |
| Background tick and pruning | `lib/bus.js`, `lib/api3/generic/collection.js:127-163` | **Generic scheduler and a unified automatic notification task implemented; remaining jobs partial.** Schema v14 stores task kind, due time, attempt count and update time. Schema v16 persists the upstream one-second trailing/five-second max-wait data-update burst. `EntryStore` derives one alarm from transport/session/lease/closure, authorization-cleanup, debounce and local task deadlines; the optional Dexcom connector owns a separate alarm. Early at-least-once delivery is a no-op; failures persist bounded retries. Schema v22 retired the lab feed, v24 removed old embedded connector state and activation seal 28 locks the current set. All sixteen official producers run automatically; API3 pruning is not scheduled. | Add summary/activity persistence and future maintenance/pruning; retain idempotent repair and Free-plan alarm tests. |
| Server plugins and calculations | `lib/plugins/index.js`, `lib/sandbox.js`, `lib/data/{dataloader,treatmenttocurve}.js`, `lib/profilefunctions.js` | **Complete request-time property and notification producer registries; broader background execution partial.** Pure ports of official `bgnow`, `direction`, `rawbg`, `upbat`, `ar2`, `basal`, `treatmentnotify`, `simplealarms`, `errorcodes`, `xdripjs`, `loop`, `openaps`, `pump`, `iob`, `cob`, `bwp`, `dbsize`, age/timeago/BAGE, Runtime State, treatment-to-curve, shared runtime helpers and Profile calculations support v2 without rewriting formulas. BWP additionally maps its missing-data, unit, target, Temp Basal, notification and snooze paths and exposes Pebble fields. AR2 maps all ten named cases; Simple Alarms maps all five; Error Codes maps all eight unchanged upstream cases plus ten pure and three real-DO cases; xDrip-js has eleven pure/HTTP/property and three real-DO cases; BAGE adds five source/HTTP/property cases plus a real scheduler case; Uploader Battery adds source/HTTP/property coverage plus a real scheduler case. Basal maps two and Treatment Notify six; OpenAPS/Pump map all 16 and IOB/COB/treatment-to-curve all 24 named cases plus DO/HTTP integration. The request-local Sandbox and static registry retain their complete contracts. Eleven complete client files run 42/42 unchanged, and twenty-one server/data-plugin files run 143/143 unchanged, against the locked upstream. Uploader Battery, AR2, Simple Alarms, Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE, SAGE, IAGE, BAGE, enabled Treatment Notify, opt-in Timeago and opt-in DBSize alerts share the persisted scheduler. | Keep all sixteen producers green without inventing algorithms; add only remaining non-plugin jobs. |
| Notifications/admin state | `lib/notifications.js`, `lib/api/notifications-api.js`, `lib/adminnotifies.js`, `lib/server/pushnotify.js`, `lib/plugins/{maker,pushover,xdripjs,batteryage,upbat}.js` | **Core notification processor, ACK/outlet persistence, all sixteen automatic producers, Admin notices and provider protocol state adapted.** Schema v13 preserves last-emission state, v14 evaluates all sixteen producers including default Error Codes plus opt-in Uploader Battery, xDrip-js, BWP and BAGE, v15 persists Admin notices, v18 persists Pushnotify dedupe/receipts plus Maker All Clear state, and v20 persists xDrip-js's notification-throttle marker. All 15 locked Maker/Pushover/Pushnotify cases are represented, and the v1/v2 receipt callback consumes only a stored unexpired receipt. Activity/summary persistence and live external send/cancel remain missing. | Add activity/summary persistence; connect external delivery only after explicit destination authorization and a persisted outbox. |
| Official page workflows | `views/**`, browser client/admin/report modules | **Named daily workflows and protected Profile push accepted; broader plugin workflows partial.** Versions 72–80 established the official homepage/chart, dbsize, Settings/About 15.0.7, Admin/clock, AR2, unchanged Save workflows, Profile/Food/Admin mutations and Reports (30 SVGs/eight canvases). The platform presentation layer now adds the separate Nightscout for Cloudflare `1.1.1-beta` identity and project links to About, plus four display-only Admin label changes; the official bundle, actions and routes remain unchanged. Version 93 repeated Profile rename/save/reload/restore and observed `dataUpdate`/`retroUpdate` in an already-open official homepage; all temporary values were restored. | Keep these gates green and add other plugin-specific workflows; keep real CGM/closed-loop traffic out of the simulated lab. |
| Upstream test tracking | `tests/**`, `upstream/contract-manifest.json`, `scripts/audit-upstream-contracts.mjs` | **Inventory complete; sixteen direct passes and 86 adapted files.** All 111 files are tracked with strict status/reason and heuristic route candidates: eleven complete client files run 42/42 unchanged, while all 16 API3 files, Pebble, Maker, Pushover, Pushnotify, the complete storage-shape and bootevent-debounce files and the named plugin/API/realtime foundations are adapted; eight remain unresolved and MiniMed CareLink is the only fixed-scope exclusion. The fully mocked legacy Dexcom `BRIDGE_*` contract is unresolved; the modern `nightscout-connect` Dexcom source is a separate Beta adapter. Twenty-one locked server/data-plugin files run unchanged as a separate 143/143-test gate. The newest direct file proves the eight official Node/Mongo pool-option parsing cases; because SQLite Durable Objects have no Mongo connection pool, this evidence does not expose `MONGO_POOL_SIZE` as a Worker setting. | Manually confirm route links. Update status only with whole-file upstream execution (`pass`) or complete named Workers-runtime contract coverage (`adapted`); keep generator/check green. Do not spend ordinary-user delivery time porting Mocha flakiness/self-tests or Mongo test-database cleanup as runtime features. |

## Locked-upstream discrepancy decisions

Nightscout v15.0.7 `lib/api3/specific/status.js:43-46` iterates the collection
registry with `for...in` but passes the string property name to a helper that
expects a collection descriptor with `colName`. The permission checked for
every collection is consequently `api:undefined:<action>`. With the official
read role, the wildcard permission matches `read`, so all six registry keys
report `r`; a collection-specific create role does not add `c`. Swagger and
the tutorial show the intended per-collection `crud` matrix. NSCF preserves
the locked release's actual check and records the contradiction; it does not
silently repair upstream behavior and then claim byte-for-byte compatibility.

The same evidence rule applies to future contradictions: actual locked source
and tests take priority unless a deliberate compatibility fix is named,
documented and contract-tested.

### API v1 Entries adapted differences

The implemented Entries slice is contract-tested but not whole-router
compatibility. Its controlled differences and remaining gaps are:

- request bodies are capped at 512 KiB and Entries batches at 1,000 items;
  locked `body-parser` permits 50 MiB and the Mongo adapter has no equivalent
  item cap;
- repeated query parameters, unsupported fields/operators and counts outside
  1–10,000 fail closed. Locked Express/Mongo accepts a wider and sometimes
  ambiguous surface;
- URL-encoded bodies use the maintained `qs 6.15.3` parser with the locked
  body-parser extended shape, depth 32 and 50,000-parameter contract. The fixed
  dependency is newer than upstream's vulnerable transitive version but keeps
  the tested parse behavior;
- non-ObjectId string `_id` values now follow the executable locked predicate
  rather than its misleading UUID-only comment; missing/null/empty
  `identifier` is replaced, while a non-empty identifier is preserved. NSCF
  adds a 4,096-character identity bound;
- missing array dates and numeric-string/urlencoded dates are normalized into
  an indexed numeric `date` for SQLite. The locked code can leave the public
  date missing/string while using a separate current-time or invalid `sysTime`;
- canonical records still receive compatibility defaults for missing `type`,
  `direction` and `device`; this makes fresh-family data queryable but is not
  the locked response shape and can affect identity for malformed multi-item
  batches;
- the locked recursive purifier is DOMPurify 2.5.8 over JSDOM 11.11.0. Workers
  has no DOM at this boundary, so NSCF recursively entity-encodes HTML-like or
  entity-bearing nonnumeric strings before preview/persistence. Existing
  entities are preserved so read-then-reupload is idempotent. Active markup is
  not stored, but safe markup upstream would retain is returned as text;
- Mongo ordered bulk failure preserves the successful prefix. SQLite matches
  that boundary with one `transactionSync()` per item, then exposes the stable
  500 `{status,message,description:{}}` envelope rather than serializing
  driver-specific enumerable error properties;
- the locked source's `format_post_response` returns preview success with the
  default HTTP 200, while `tests/api.unauthorized.test.js` contains a stale 201
  assertion. NSCF follows the executable locked source and records the
  contradiction instead of changing the route to satisfy that assertion;
- Entries, Treatments and DeviceStatus `echo` return the locked `query`,
  `input`, `params` and `storage` envelope and apply each module's exact numeric
  or regex walkers, date field/default and UUID option. Tenant and credential
  transport parameters are removed from reflected input. Storage modules not
  selectable by the locked Entries router return a controlled 400.
- `count/:storage/where` performs direct SQL `COUNT(*)` aggregation for entries,
  treatments and device status. Like the locked `$match` plus `$group` utility,
  result `count` and `sort[...]` options do not affect the aggregate; zero rows
  return `[]`, and a nonzero total returns `[{"_id":null,"count":N}]`. Unknown
  storage names inherit the locked entries fallback. The adapter accepts only
  the bounded filter subset and rejects client-supplied aggregation pipelines
  with controlled 400 instead of executing arbitrary stages.
- Aggregate count does not materialize matching documents and is not capped by
  the ordinary 10,000-row response limit. This does not remove the limit from
  detailed Entries reads or exports: long histories still require date-bounded
  partitions.
- `times/echo`, `times` and `slice` compile the locked numeric-brace fixtures
  through a bounded protocol adapter: no more than eight literal prefixes, 256
  expansions and 10,000 candidates. The indexed Entries/dateString route keeps
  its range plan; release 97 additionally selects Treatments/DeviceStatus,
  arbitrary bounded string fields and the upstream unknown-storage Entries
  fallback. Pattern execution accepts only the reviewed linear regex subset;
  non-empty Mongo regex flags and wider JavaScript regex syntax remain
  controlled differences.
- the ordinary compact-SGV path retains `count=10000`, but an artificial
  selection of thousands of documents containing abnormally large custom
  fields is still materialized across DO RPC, sorting, formatting and ETag
  hashing. A total-result budget or streaming redesign is deferred as
  extreme-request hardening.

The GET/HEAD representation subset is tighter: differential probes lock
extensionless plain text by default, JSON/CSV/TSV/TXT bytes, lowercase
extension override and uppercase-extension fallthrough, result-derived
Last-Modified, the exact base-route runtime-SGV IMS precheck/fallback header,
Express weak ETags, ordinary result IMS and normal INM 304 behavior, and
sort-before-limit followed by formatter time ordering. Workers adds the common
`no-store`/CORS headers; Cloudflare may strip dynamic `Content-Length` at the
public boundary.

### API v3 implemented-collection controlled differences

The entries/treatments/device-status/profile verticals keep the route, JWT,
permission-branch, validation, tombstone, history and renderer contracts named
above. They are not complete generic API v3 compatibility. The remaining or
deliberate differences are:

- request JSON is capped at 512 KiB; locked `body-parser` is configured for
  50 MiB;
- top-level JSON primitives return the treatments 400 envelope; the locked
  strict body-parser/error-middleware path returns 500;
- multiple operators for one field now match the locked object-overwrite
  behavior: the later query item replaces the earlier operator object, and the
  adapter-owned valid-row condition replaces caller `isValid`;
- a parsed zero limit, including `limit=0x10`, is capped at 1,000 rows instead
  of using Mongo's unlimited `cursor.limit(0)` behavior;
- a finite positive `API3_MAX_LIMIT` below 1,000 lowers the search/history
  ceiling just as upstream configuration does; invalid values fall back to
  1,000 and larger values remain capped for Workers Free;
- API preflight advertises `GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS` plus the
  upstream authorization, conditional and content headers; implicit HEAD uses
  the GET status/headers and omits the body for version, status,
  lastModified and every generic API3 route;
- JSON/CSV/XML small and medium responses have locked differential fixtures,
  but CSV/XML still buffer the complete result; Free-plan CPU and 128 MB memory
  behavior for worst-case 1,000-row/nested results is not closed;
- `$re` accepts a bounded, case-sensitive, linear subset compiled to SQLite
  `GLOB`; unsupported constructs, patterns above 128 UTF-8 bytes and compiled
  GLOBs above 50 bytes return controlled 400;
- unsafe field syntax and SQLite's 100-binding/100,000-byte statement limits
  return controlled 400 responses;
- non-negative `skip` values through JavaScript's maximum safe integer are
  accepted; larger parsed offsets return controlled 400 instead of reaching an
  unsafe SQLite integer binding;
- comparisons, ordering and projection across mixed JSON types, arrays and
  nested values have not completed a Mongo differential matrix;
- a final server-ID sort key makes exact ties deterministic on SQLite;
- `srvModified` allocation is strictly monotonic across same-millisecond writes
  and DO eviction, an intentional platform enhancement over upstream's direct
  clock value;
- `/lastModified` evaluates all six official generic collections; Settings is
  included only when its read permission is present and uses no created-at
  fallback.

Extension middleware is not collapsed into renderer support. The adapter uses
the locked `mime` 2.6.0 table: malformed JSON fails before extension handling;
unknown MIME extensions return 406 before route authentication; known MIME
extensions are stripped and can reach JSON write handlers. Resolved
`application/json` aliases, including `.map` and `.JSON`, use the JSON renderer.
Known unsupported read formats authenticate/query first and then return the
controlled renderer 406. Negotiated responses and renderer-generated 406
responses vary on `Accept`. The 512 KiB and query-limit errors are platform
controls, not upstream claims.

## Historical deployed integration evidence

Runtime candidate `56353da` passes 799/799 tests in 73
Workers-runtime files plus 23/23 audit tests, 42/42 unchanged direct upstream
client tests across eleven complete files and 143/143 unchanged tests across twenty-one locked server/data-plugin
files. It connects schema-v14 background work to automatic Uploader Battery, AR2, Simple Alarm,
Error Codes, Pump, OpenAPS, xDrip-js, Loop, BWP, CAGE, SAGE, IAGE, BAGE, Treatment Notify, Timeago and opt-in
DBSize evaluation while retaining the complete named
notification-processor contracts, schema-v13 emission persistence and atomic
`/alarm` publication. It retains Basal Profile,
request-local property/notification calculation and platform input mapping. It
retains OpenAPS/Pump, IOB/COB/treatment-to-curve, the complete age/timeago,
dataloader/database-size, Sandbox, Settings, Loop, Profile, uploader, identity,
root-delta/write, API3, authorization, realtime and notification-ACK slices.
The schema-v17 lab feed in this historical release was retired by schema v22.
Schema v24 removes the old embedded connector task/state; activation seal 28 is
current.
Cloudflare version `339263b5-c3d5-400a-b3b3-0c6299722d32` is current as
project release and Cloudflare ordinal 100 and reported a 36 ms startup. It
processed 250 Static Assets entries; that historical dry run reported 1319.52 KiB raw
/ 242.79 KiB gzip, with only
`ENTRY_STORE` and `ASSETS`.
This deployment had no explicit version annotation; none is invented.
Release 99's FIFO contract proves that peek does not mutate counters or rows,
an independently reconstructed repository sees the same prefix, a mismatched
acknowledgement rolls back, and only the exact successful prefix advances the
queue. Release 100 adds schema-v21 durable JSONP callback authority and the
locked EIO3/EIO4 callback/content-type/form-POST envelopes. The 213-assertion
post-deploy smoke passed on `public-smoke-1784727265264` with callback indexes
7 and 12 plus both Engine.IO generations and the existing direct/upgrade WSS
gates. The unchanged homepage rendered `118 mg/dL`, a trend arrow and two SVGs
without a dialog or console error; Admin loaded seven roles as authorized.
The clean-source build installs the locked Nightscout build dependencies before
running webpack and UI generation. Its accepted run installed 1,057 upstream
packages and regenerated all 250 assets. The root build command now also acts
as the Cloudflare source-import update bootstrap: a `Retry build` refreshes the
official source in the temporary Workers Builds workspace, preserves the Worker
name and plain-text `API_SECRET`, then runs the same locked clean-source build.
The deploy command remains fixed, and a request-boundary check rejects a
too-short value before Nightscout starts.
Private release acceptance 101 proved
the exact source state on a new Cloudflare account, but a real Deploy to
Cloudflare button is not yet claimed because the canonical GitHub repository
intentionally remains private.

The reusable credential-free remote smoke passed 177 assertions for health,
bounded v1 Entries/Treatments and Food helper reads, fresh Profile/current,
v1/v2 Treatment and DeviceStatus echo query shapes, empty selected-storage
slice reads,
unknown Food/Profile 404s, plural-Profile read-only behavior and v2 Summary,
API3 version, matching v1/v2 filtered Settings and database-size settings,
real ddata SQLite bytes, current/explicit-frame Activity buckets and frame
metadata, null `lastProfileFromSwitch` and all eight empty derived Treatment
buckets on a fresh tenant, the default-enabled `dbsize` and Basal properties,
opt-in-disabled Loop/OpenAPS/Pump/xDrip-js/IOB/COB/CAGE/SAGE/IAGE/BAGE, null disabled IOB/COB Summary
state, property-absent timeago, EIO3 polling/direct WSS and real EIO3/EIO4 WSS
upgrades through probe/noop/upgrade/root-CONNECT/`clients`;
default-enabled Error Codes and Runtime State, default Uploader Battery
configuration plus empty property output, default-disabled Uploader Battery
alerts, xDrip-js and BAGE properties, plus the v2-only Loop push permission
boundary and v1 non-route,
and missing-token API3 Entries returned 401. Isolated tenant
`public-smoke-1784722092670` reported
307,200 SQLite bytes,
`indexSize:0`, a 953.67 MiB maximum and `0%`/`current` state. This run sent no
API secret value and performed no protected mutation. A name-only encrypted-
secret listing was empty and protected probes fail closed. A separate
credentialed 25-entry test batch proved v1 write/read and was later
deleted by exact device/type matching. A second isolated remote contract
created one test SGV, sent a genuinely bodyless DELETE through the public
edge, observed HTTP 200/`deletedCount:1` and confirmed zero remaining rows.
Version 80 then used the current deployment for authenticated official-page
acceptance: Profile rename/save/reload/restore, Food create/read/delete, Admin
role create/delete and Reports generation all passed; all temporary values were
restored or removed. The homepage with test data displayed `129 mg/dL`,
`+3` and `FortyFiveUp`. No real health data or closed-loop client was used.
Version 93 repeated Profile rename/save/reload/restore against the current
candidate and observed the successful protected mutation in an already-open
official homepage as `dataUpdate` and `retroUpdate`. The restored Profile then
reloaded as `Profile11111111`, timezone `Asia/Shanghai`, with `Values loaded.`
and `Admin authorized`. The post-deploy homepage also displayed current
test glucose and its chart.
Release 95 then reloaded the unchanged official homepage against the Activity
ddata deployment: it displayed `117 mg/dL`, the trend and two-SVG/eleven-path
chart with no dialog or console error. Admin Tools loaded eight visible action
buttons and remained `Admin authorized`; its two known upstream secondary-page
`#chartContainer` warnings were not runtime errors. No real health data or
closed-loop instruction was used.
Release 96 reloaded the unchanged official homepage after the full-ddata split:
it displayed `129 mg/dL`, two-minute-old test data, two SVGs, 129 circles
and a populated chart without console errors. Admin Tools loaded zero subjects,
all seven system roles, eight action buttons, three tables and reported `Admin
authorized`. No real health data or closed-loop instruction was used.
Release 97 reloaded the unchanged official homepage after the legacy utility
storage increment: it displayed `116 mg/dL`, a flat arrow, one-minute-old
test data and two SVG charts without a dialog or console error. Admin
Tools again loaded zero subjects, all seven roles, eight buttons and three
tables and reported `Admin authorized`; its two known upstream chartless-page
warnings remained non-errors. No real health data or closed-loop instruction
was used.
Release 98 exercised the unchanged official Admin cleanup workflow rather than
counting page load as compatibility. Locked server collection deletion returns
MongoDB 5's `{acknowledged,deletedCount}`, while the unchanged Admin Entries
and Treatments plugins still read the legacy `n` field. NSCF now adds `n`/`ok`
only for same-origin `/admin/` requests; direct API callers retain the exact
modern result. The real page rendered `0 records deleted` for both buttons and
remained authorized. The homepage displayed `126 mg/dL`, `+4`, a rising arrow,
one-minute-old test data and two SVG charts. After one non-repeating EIO3
POST failure at cutover, an isolated handshake/root/ping replay passed and the
full 177-assertion smoke passed on `public-smoke-1784722092670`. No real health
data or closed-loop instruction was used.
Version 81 retained those assets and workflows, rejected unknown provider
receipts on both v1 and v2 with the locked 500 body. The real homepage
displayed `121 mg/dL`, `+4`, four minutes
ago with no visible alarm dialog, console warning or console error.
Version 82's credential-free smoke passed 77 assertions on isolated tenant
`public-smoke-1784690470717`. The test dataset contained current five-minute
rows and the unchanged homepage refreshed to `127 mg/dL`, four minutes old,
without a dialog or console warning/error. The active-Profile write/push path
is proven by the real SQLite DO eviction test, not claimed as a protected
remote mutation because the deployment shell had no injected API_SECRET.
Version 84's 99-assertion smoke passed on isolated tenant
`public-smoke-1784694550269`. It confirmed EIO3's upstream-exact two-stage
open/root-CONNECT order and client-ping/server-pong while retaining EIO4. The
unchanged homepage displayed `127 mg/dL`, `-3`, one minute old with the chart
present, a connected live client and no console warning/error.
Polling-to-WebSocket upgrade was still a
gap in that version.
Version 85's 106-assertion smoke passed on isolated tenant
`public-smoke-1784696258002`. It completed the standard EIO4 WSS upgrade and
received root CONNECT plus `clients`; duplicate, malformed and alarm-timeout
candidates preserve the polling session in local DO contracts. The refreshed
unchanged homepage displayed `121 mg/dL`, `+4`, three minutes old without a
warning or console error. EIO3 direct WebSocket/upgrade, JSONP and binary remain
explicit gaps.
Version 86's 106-assertion smoke passed on isolated tenant
`public-smoke-1784697190440`, retained the same real WSS upgrade and reported
299,008 SQLite bytes. The batch-specific local DO contract creates two SGVs
and Treatments, verifies the official 95-mg/dL surrounding-SGV marker and
profile-derived mmol field in the initial root event, evicts the DO, creates a
second Treatment and observes the curved marker in its pushed delta. The remote
smoke remained credential-free and therefore did not fabricate a protected
write claim. A fresh official-page session displayed current test glucose,
two SVGs and no dialog; root and alarm events were received with zero console
warning or error.
Version 87's 120-assertion smoke passed on isolated tenant
`public-smoke-1784698633397`, including the exact read-only Food/Profile route
surface added to the reusable remote gate. Local contracts populate mixed
quickpicks, prove exact hidden-string filtering, numeric/string position order,
query ignoring and raw non-Treatment shapes across v1/v2. A fresh official
Food Editor session reached `Database loaded`, rendered the full record and
Quick-picks controls and logged no warning/error. The homepage displayed
`118 mg/dL`, `-3`, four minutes old with no dialog or console issue.
Version 88's 121-assertion smoke passed on isolated tenant
`public-smoke-1784700236170` and added the official default-enable assertion for
Error Codes while retaining EIO3 polling and real EIO4 WSS upgrade. Ten pure
adapter cases and three real SQLite DO scheduler cases prove default/custom
mapping, exact metadata, information/urgent delivery, future activation and
ten-minute clear without injecting an error reading into the public tenant. A
fresh official page displayed `122 mg/dL`, `+4`, an upward trend and the chart,
Settings/About reported 15.0.7, and the page logged no dialog, warning or error.
Version 89's 125-assertion smoke passed on isolated tenant
`public-smoke-1784702685161` and added explicit evidence that xDrip-js remains
opt-in and does not fabricate `sensorState` on an empty/default tenant. Eleven
pure/HTTP/property cases and three real SQLite DO cases cover the upstream
property fields, notification metadata, state/battery precedence, future and
24-hour boundaries, minute-31 repeat, eviction persistence and All Clear. A
fresh official page displayed `114 mg/dL`, `+2` and its chart; Settings/About
reported 15.0.7 and the captured browser log contained zero warnings/errors.
Version 90's 129-assertion smoke passed on isolated tenant
`public-smoke-1784704705985` and added default Runtime State, default-disabled
BAGE and Summary-omission evidence while retaining EIO3 polling and real EIO4
WSS upgrade. Five pure/source/HTTP cases and one real SQLite DO scheduler case
cover BAGE selection, display, Summary state, threshold metadata, future
activation, exact 20-minute window, heartbeat and clear. A fresh official page
displayed `127 mg/dL`, a live-changing delta and the chart; Settings/About
reported 15.0.7 and the captured browser log contained zero warnings/errors.
Version 91's 134-assertion smoke passed on isolated tenant
`public-smoke-1784706560346` and added default Uploader Battery configuration,
empty-property output and default opt-in alert evidence while retaining EIO3
polling and real EIO4 WSS upgrade. Source/HTTP/property cases and one real
SQLite DO scheduler case cover its recent-device minimum, multi-device/voltage
message, future activation, heartbeat, exact expiry and All Clear. A fresh
official page displayed `113 mg/dL`, `-1`, one-minute-old test data and
the chart; Settings/About reported 15.0.7 and the captured browser log contained
zero warnings/errors.
Version 92's 139-assertion smoke passed on isolated tenant
`public-smoke-1784710160605` and proved the protected v2 Loop route reaches its
401 permission boundary while the same v1 path remains 404. Nine local tests
cover exact configuration/Profile errors, all four payloads, a verifiable ES256
JWT, APNs request headers/body, bounded provider failures, form parsing and
route authorization. The lab has no Apple credentials, so this is not a live
APNs or remote-bolus claim. EIO3 polling and real EIO4 WSS upgrade remained
green. A fresh official page displayed `117 mg/dL`, `+3`, one-minute-old
test data and its chart; the official Admin page loaded seven built-in
roles, zero subjects, all cleanup groups and `Admin authorized`.
Version 83's 77-assertion smoke passed on isolated tenant
`public-smoke-1784692181407`. Public defaults correctly left BWP absent from
Properties and Pebble and `null` in Summary; the opt-in path is covered by a
real SQLite Durable Object alarm test. The unchanged homepage displayed fresh
`113 mg/dL`, `-1`, `Flat` test data without a dialog or console warning/error.

The deployment onboarding exposes one plain-text `API_SECRET` variable.
Clients use that same value for authorization.

The first deployment of this increment (`e24bfdec-233c-4dab-a462-142337b14118`)
showed a Cloudflare rolling-release boundary: the new Worker reached an old
live DO isolate that did not yet implement `getPluginPropertyContextJson`, so
`/api/v2/properties` returned 500. The current code catches only Cloudflare's
exact missing-RPC-method error and temporarily derives the bounded plugin inputs
from the old `getDdataSnapshotJson` RPC. The same old DO returned 200
immediately after redeploy; all other RPC/storage/parser errors still fail.

No deployed credential was supplied to remote API smoke or browser smoke, and
no deployed credential value is stored in the repository or these documents.
Local authorization contracts use isolated test-only values. Current Secret
inventory is empty and no local deployment credential is available. API-secret
writes therefore fail closed with 503 until an operator explicitly configures
an encrypted Worker Secret. The port must not generate or silently replace a
family credential.

Entries is fresh-only for the pre-1.0 lab. An incompatible old narrow
`entries` shadow is reset without importing its rows, while canonical documents
and profile remain untouched. At 2026-07-18 14:51 UTC, read-only checks against
the public instance returned an empty array from
`/api/v1/entries.json?count=10000` and a one-element array from
`/api/v1/profile.json`. Post-deployment reads confirmed zero Entries and one
profile. Thus this deployment had no simulated Entry row to lose and preserved
its profile. Remote evidence recorded only collection counts/status and the
browser load state; no profile values are copied into this record.
The deferred work is importing an external legacy Nightscout/MongoDB history.
It does not defer correctness of NSCF's own forward-only SQLite schema
activation. Redeploying the current Worker preserves that namespace; the
planned fresh-family path instead starts with a new Worker/DO namespace or an
empty tenant.
The first release therefore applies only to fresh deployments. A user who
requires existing Nightscout history in the new instance should not switch to
this release.

`EntryStore` and the optional `DexcomShareConnector` each own one independent
alarm; realtime and authorization-delay cleanup remain in `EntryStore`. On Workers Free, SQLite row reads,
row writes and index maintenance remain account-wide daily resources, and each
`setAlarm()` call counts as a write. The adapter therefore bounds unindexed
Entries candidates at 10,000 with controlled 413, synchronous deletion/history
cleanup at 128, and `$re` to the safe GLOB-compilable subset.

The official homepage uses the deployed polling slice because the locked
Socket.IO 4.5.4 client explicitly requests it; direct and polling-upgraded
WebSocket remain separate external-client transports. Their
current bounds and named differences are:

- strict EIO3/EIO4 XHR/JSONP polling with `upgrades:["websocket"]`, direct
  WebSocket and each protocol's locked probe/noop/upgrade sequence. Schema v21
  persists the initial JSONP callback index and URL-encoded form-POST mode
  across eviction;
- exact `application/octet-stream` POSTs close the SID with a controlled
  400/code-3 response; malformed UTF-8 uses replacement decoding, while
  raw-versus-replacement accounting at the 1,000,000-byte edge remains P2;
- 256 sessions per tenant, 128 outbound packets and a 1,000,000-byte whole
  queue/body limit. Request-time opportunity cleanup remains bounded to 32,
  while the SQL-derived single DO alarm independently handles all due
  heartbeat/session/lease work and reschedules idempotently across eviction;
- tenant-local anonymous/API-secret-digest/access-token/JWT authorization, with
  ACK flags derived from the granted read/write/treatment permissions; the
  anonymous-readable default remains `{read:true, write:false,
  write_treatment:false}`;
- invalid authorization disconnects only `/`; unknown namespaces still return
  `CONNECT_ERROR`, while root `subscribe` remains unhandled. Authorized
  `dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove` use the shared repository;
- `/storage` connects independently, authorizes a subject access token into
  collection rooms, persists those rooms across eviction and sends bounded
  API3-shaped create/update/delete frames for successful API3 and legacy v1/v2
  changes;
- `/alarm` connects independently. Native access tokens take priority; web
  secret/JWT/anonymous subscriptions report locked read/ACK flags. Exact
  all-clear ACK state and at most 256 bounded group snoozes survive eviction;
  the core processor consumes bounded request/snooze arrays, persists its
  priority/all-clear decision in schema v13 and atomically publishes one of the
  five official event names to every current tenant-local connection, with
  broken recipients isolated and no disconnected replay. One schema-v14 task
  feeds automatic AR2, Simple Alarm, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE,
  enabled Treatment Notify, opt-in Timeago and opt-in DBSize results through
  this same outlet; other automatic plugin evaluations remain missing;
- initial `dataUpdate` uses the locked recent-device-status shape. `loadRetro`
  uses raw normalized statuses from the same one-day SQL window; initial
  filtering keeps the most recent 10 rows per device/type without a blind
  100-row limit;
- subsequent implemented v1/v2/API3 mutations compare the full current
  snapshot with schema-v11 persisted baseline state and enqueue only non-empty
  locked `dataUpdate` output for connected, authorized, read-allowed live
  sessions. API3 queues root and `/storage` frames transactionally; legacy
  mutations also queue API3-shaped `/storage` frames while root publication is
  a follow-up DO transaction;
- schema v12 persists root write/treatment-write authority. Authorized
  `dbAdd`, `dbUpdate`, `dbUpdateUnset` and `dbRemove` events mutate the shared
  repository with their exact ACK/error order and queue any resulting delta
  after the ACK; pre-v12 session rows safely default the new flags to false;
- schema v13 adds nullable last-emission state to the existing alarm-silence
  rows and repairs a v12 object without losing group, level or snooze state;
- schema v14 adds a generic `background_tasks` table and due-time index. The one
  platform alarm is derived from realtime, authorization-cleanup and task
  deadlines; early delivery is a no-op, and caught failures persist a retry
  beginning at two seconds and capped at five minutes. Task completion or
  reschedule commits with notification state and live `/alarm` queueing;
- automatic evaluation projects at most 64 SGVs, ten MBGs, 1,000 matching
  current DeviceStatus rows plus the earliest future matching status, the latest
  Profile and the newest 1,000 Treatments within the shared JSON budget. It
  retains strict threshold-plus-one-millisecond, source-expiry, future-status,
  OpenAPS Offline start/end and Pump quiet-night timezone deadlines;
- initial/retro SQL cursors are bounded before large arrays are materialized by
  a shared 900,000-byte, 8,000-node, 2,000-document budget and a 24-level
  stored-document depth cap; this may deterministically truncate the older
  cursor tail, so removing the fixed 100-row limit is not an all-groups claim;
- polling status keeps the locked field set/order; API/careportal enabled and
  boluscalc disabled remain platform assumptions. The latest one-year
  zero-duration Profile Switch now supplies the locked `activeProfile` field;
- requiring exactly one object for `authorize` and `loadRetro` is a deliberate
  safety/resource tightening.


Final credential-free remote checks returned HTTP 200 for health, bounded v1
Entries and Treatments reads, fresh Profile/current and v2 Summary, API3
version, matching v1/v2 filtered Settings snapshots, real ddata/database-size
values, default-enabled `dbsize` and Basal, opt-in-disabled Loop/OpenAPS/Pump/IOB/COB and an EIO4
polling open packet;
missing-token API3 Entries returned its expected 401. The 77-assertion run used
fresh tenant `public-smoke-1784686572692` and observed 270,336 SQLite bytes. It
sent no API secret and performed no protected mutation. A name-only encrypted-
secret listing was empty. With the construction credential configured,
anonymous mutation now fails closed with 401; a separate 25-entry test
batch was authenticated and read back successfully.
Four fresh-tenant Admin-notification probes exposed only the public count and
no notification body.

The deployed version adds automatic AR2, Simple Alarms, Pump, OpenAPS, Loop,
CAGE, SAGE, IAGE, Treatment Notify, Timeago and opt-in DBSize evaluation through the core notification processor
while retaining Basal Profile, IOB/COB and
treatment-to-curve,
retaining CAGE/SAGE/IAGE/timeago, dataloader/database-size, the static plugin
registry and complete Sandbox, Settings and Loop property adapters. The public EIO4
polling open handshake was re-smoked without a credentialed mutation. Local
contracts prove all ten AR2 and five Simple Alarms cases, all eight core notification
processor cases, both named Basal cases, all six Treatment Notify cases, all 16
named OpenAPS/Pump cases, all 24 named
IOB/COB/treatment-curve cases, Loop
enacted/error/received/stale-alert/assistant behavior, the locked age/timeago
display, threshold, notes and notification-request behavior, prediction trimming,
UUID/dedupe/partial-failure and ObjectId-cache behavior, v1 SGV and API3
Treatment root delivery, authorization silence and persisted baseline
reconstruction while keeping authorized storage rooms, alarm
authorization/ACK/snooze, shared HTTP/Socket clear delivery and hibernated
WebSocket delivery green. The prior
credentialed `/alarm` smoke remains historical evidence, not a claim of a
current credentialed alarm publication. A current official-client smoke did
connect root and `/alarm`, receive initial `dataUpdate`, authorize read and
subscribe for alarms without a credential.

A real browser session loaded Cloudflare version 78 through the official
Socket.IO client. A clean browser profile loaded both content-addressed
transport assets, connected/authorized root, received `dataUpdate`, subscribed
to `/alarm` and reported zero console errors or warnings. Version 74 had
rendered the connected official homepage and opened Settings with Admin
authorized/About 15.0.7. The
unchanged Save workflow completed; at the user's request, the two client
stale-data alarm checkboxes were saved off while the test dataset was
intentionally idle. The only console rejections were browser autoplay-policy
errors before user interaction, not application or API failures. The version-73
pass retains exactly 26 AR2 forecast dots, and in version 72 the live database-size pill showed
`0%`. After 25 test SGV
rows were written and read back, it displayed `101 mg/dL`, an upward arrow,
`+3` and a populated two-hour chart. Those 25 exact test rows were later
deleted; Profile state remains. The official Admin-notification link
remained present. Settings exposed the official language selector and About
reported 15.0.7; Admin Tools and `clock-color` loaded without console errors.
Four fresh-tenant API
probes returned the readable-site count while hiding bodies from anonymous
callers; the immediate old zero-count response before convergence is retained.
No real health data was used. Version 80 subsequently completed authenticated
Profile/Food/Admin/Reports acceptance with temporary values restored or deleted.
The prior version-65
unchanged-default Settings save remains historical regression evidence.

An earlier deployed version completed an authenticated Profile Editor save and
introduced the content-addressed shim/service-worker cache fix after reproducing
the original post-save redirect loop. Version 80 repeated that workflow on the
current deployment and added Food, Admin-role and Reports acceptance, so those
named current workflows are no longer only historical evidence.

These observations prove only the named increment. They are not a full-port
completion claim.

## Contract-testing and delivery order

1. Use the generated route/test manifest as the dispatch list; manually confirm
   its heuristic route/test links and keep its locked-source-checked static and
   dynamic overlays current as implementation lands.
2. Build one SQLite collection contract that covers ObjectId/UUID, indexes,
   query operators, upsert, tombstones and last-modified fields.
3. Keep the adapted JWT/derived-credential/delay/Admin-notification contracts
   green while completing remaining authorization surfaces.
4. Port v1, then v2, then v3 modules in dependency order, reusing upstream
   calculation code rather than translating it by hand.
5. Keep the completed official EIO4 polling browser and external EIO3/EIO4
   direct/upgrade gates green; keep the now-accepted protected Profile save/
   push gate green. The optional test-tenant adapter must remain the only
   browser-side Cloudflare logic.
6. Add bounded tick/prune/plugin producers to the deployed persisted alarm
   table; AR2, Simple Alarms, Pump, OpenAPS, Loop, CAGE, SAGE, IAGE, enabled
   Treatment Notify, opt-in Timeago and opt-in DBSize already share the first
   automatic task.
7. Run the applicable upstream tests through the adapter, then execute local
   Workers tests, deployment dry-run, remote API smoke and real-browser flows.

No real CGM data, medical credentials, new medical algorithms or dosing advice
are permitted. The deployment remains simulated-data only.
