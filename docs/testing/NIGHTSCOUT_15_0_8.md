# NSCF 1.3 beta — based on Nightscout 15.0.8

NSCF version: **1.3.0-beta.2**. Development branch:
[`ns-15.0.8/ns4cf-1.3-beta`](https://github.com/sid-luo/nightscout-for-cloudflare/tree/ns-15.0.8/ns4cf-1.3-beta).
Beta refers to the NSCF adaptation; official Nightscout 15.0.8 is a stable upstream release.
This is an independent testing track from stable NSCF 1.2.0. No stable Release,
production deployment or installer publication is part of this work.

## What changed

- The unmodified official 15.0.8 snapshot is locked to
  `92d0834219aa771b5837dbcbf1baeb839a200cf6`. All 764 source files match the
  downloaded tag archive. The generated official browser bundle is byte-identical
  to the bundle shipped in NSCF. This brings the report, clock, translation,
  client output-encoding and AAPS chart changes in the official release.
- API3 reports protocol 3.0.5 and supports `filter_parameters` strings and arrays,
  preserving spaces/equals in values and existing bounded field validation.
  PUT rejects callers without either applicable write permission before
  purification or a storage lookup; the selected create/update branch still
  enforces its own permission. XML keys are safely encoded with collision
  handling, and underscore-prefixed keys are elements instead of attributes.
- Stored-text purification uses upstream's pinned sanitize-html 2.17.5 parser,
  allow-list and identity-preserving text behavior, with bounded per-document
  work. It covers canonical snapshots, REST, API3, Activity and root Socket.IO
  mutations; malformed realtime batches cannot commit a valid prefix. NSCF
  also purifies Settings documents as a controlled stricter boundary.
- BWP requires positive IOB before snoozing a high alarm and ignores calculation
  errors. Historical COB uses the requested time. Legacy direction aliases and
  OpenAPS forecasts with missing/blank/null basal details match 15.0.8 behavior.
  An explicit Profile `isAPNSProduction` takes precedence over the Loop push
  environment fallback. The beta.2 connector expansion is described below.
- The official Admin Tools forms and previews are preserved. Date-range cleanup
  for entries/treatments/devicestatus and profile pruning use a small platform
  action adapter. Cleanup runs sequentially in batches, shows confirmed totals,
  and stops with the partial total if a request fails. Date bounds use the
  Profile timezone, including DST. Profiles retain the newest requested number
  by `startDate` and descending `_id`, matching the official ordering.
- Socket.IO's byte-identical browser client is now 4.8.3; EIO4/SIO5 and legacy
  EIO3 transport behavior remain covered. Service-worker asset versions include
  the platform maintenance adapter, avoiding stale test UI code.
- `ALLOW_UNRESTRICTED_FRAME_EMBEDDING=false` (or `off`) enables SAMEORIGIN and
  enforced `frame-ancestors 'self'` on Worker-served responses. The 15.0.8
  default remains `true`. Beta.2 also implements enforced/report-only CSP with
  the configured frame origins.
- Prerelease builds cannot auto-refresh themselves from the stable source
  channel, even when `NSCF_AUTO_UPDATE=1` is set. The default Worker name in
  this branch is `nscf-nightscout-beta`.

## Beta.2 acceptance revision — 2026-09-09

- A report-only overlay fixes duplicate first readings, timestamp deduplication,
  single/empty-hour nonfinite results, RMS omission of the last reading, and
  fractional hourly means. Empty candles are skipped. The locked upstream
  snapshot and main bundle remain unchanged; the report overlay is a separate,
  cache-versioned asset. GMI/RMS retain upstream interpolation and spike cleaning.
- Report requests preserve the selected tenant and use Profile-local next
  midnight on 23/25-hour DST days. Day-to-day axes use real local timestamps.
  Invalid dates, targets, empty weekdays and ranges exceeding 185 days show a
  retryable message; failed report reads cancel pending reads and clear stale output.
- Source fixes normalize Nightscout root URLs, reject trailing-dot local aliases,
  cancel oversized response streams, and reject invalid Libre calendar dates.
- Full regression: **89 Workers files / 959 passing tests**, 355 official client
  cases (2 original pending), 162 official server cases, and script audits.
  Reports: **13 original-module + 33 overlay cases**; the two skipped original
  report workflows are activated and replayed with all original assertions in
  separate processes to isolate upstream benv/global cache interference. The
  strict whole-file manifest remains 43 pass / 90 adapted / 1 excluded /
  23 unresolved; this does not declare complete upstream parity.
- An isolated local Worker with 864 synthetic readings and three meals passed
  all 11 report views in a real browser. Independent distribution totals and
  GMI/RMS matched; three-month loading and validation/recovery passed. DST
  boundary fixtures included exactly two in-day readings, with 23/25-hour axes
  and 23/25 U synthetic basal totals. A normal day produced 24 U basal, 0.5 U
  bolus and 12 g carbs, matching the fixtures.
- **56 connector/durable-job tests** use mocked external responses. They cover
  refresh, malformed input, size/time limits, partial writes, same-time cursors,
  disable-in-flight, redirects, duplicate/coalesced notifications and receiver
  rotation. Real third-party credentials, 2FA and receiver delivery remain untested.
- Real xDrip acceptance is read-only. Short-window continuity across Shanghai
  midnight and independent formulas in both units/timezones were checked locally;
  private health evidence is kept outside the source tree. This does not establish
  multi-day availability or validate real AAPS/Loop treatment/prediction workflows.

## Beta.2 validation — 2026-09-08

- Full `npm test`: **88 Workers files / 949 tests passed**, plus 355 official
  client cases (2 pending), 162 official server cases and all script audits.
- New/updated connector suites: **46 mocked protocol and durable-job tests**.
  They cover BRIDGE migration/legacy mode, Nightscout collection cursors and
  tie pagination, LibreLinkUp patient selection/region hints/current glucose,
  Glooko CSRF/API fallback/units/basal conversion, persistence, partial writes,
  tenant isolation and Webhook baseline/retries/idempotency/coalescing.
- **13 executable report regressions** run the unmodified upstream report and
  Profile modules: GMI/revised GMI, RMS in both units, boundaries/empty input,
  half/quarter-hour offsets, summary spacing and AAPS sub-minute basal times.
- The old `reports.test.js` full workflow has `describe.skip`; it is now marked
  **unresolved**, correcting the old passing claim. Targeted tests do not certify
  every report/edit/delete workflow. Current manifest: 43 pass, 90 adapted,
  1 fixed-scope exclusion, 23 unresolved whole-file claims.
- TypeScript passed. New source readers and Webhook default off, and all new
  external HTTP tests use synthetic responses. No real account was accessed.
- Package/deployment verification is recorded separately after rebuilding.

## Historical beta.1 validation — 2026-09-07

- Full `npm test`: **86 Workers files / 904 tests passed**.
- Official client/client-core runner: **355 passed**, with **2 existing pending
  report cases**. The four host-date goldens run unchanged in their captured
  America/Los_Angeles timezone; the main suite runs in UTC.
- Official server/data-plugin runner: **162 passed** across 23 files.
- Route/source, auth, Cloudflare config, source-update, translation and admin
  adapter audits passed. The regenerated inventory contains **163 routes and
  157 upstream test files**: 44 pass, 90 adapted, 1 fixed-scope exclusion and
  22 unresolved whole-file claims. This is not a claim of complete upstream
  parity; see [the generated manifest](../UPSTREAM_TEST_MANIFEST.md).
- `npm run check` passed. Actual Wrangler dry-run bundling passed at
  **1928.08 KiB raw / 398.46 KiB gzip**, with no upload.
- Local HTTP smoke passed **212 assertions**. Browser verification confirmed
  Admin authentication, both new tools and three-collection date preview;
  the homepage showed synthetic `110 mg/dL`, a chart, and About versions
  `15.0.8` / `1.3.0-beta.1`. Initial empty-profile setup warnings were resolved
  by adding a synthetic test Profile; no real CGM or APNS traffic was used.
- The existing 10,000-record backfill still used **410,098 reads**. With a
  browser subscriber, one device-status upload still used **41 reads**;
  maintenance indexing increases that upload from 15 to **16 writes**.
  Indexes are partial and JSON-guarded, preserving authorization update
  semantics and handling of existing malformed records.
- NSCF changes pass `git diff --check`. Three whitespace findings in the
  official snapshot are retained to keep the vendor source unmodified.

## Controlled limits

Each maintenance batch deletes at most 64 snapshots and 128 stored revisions.
A single record with more than 128 revisions returns 413 before that batch
writes. Previously completed batches remain deleted and the UI reports their
count; this is not an all-or-nothing multi-request transaction. Direct profile
pruning without `_nscf_batch=1` is atomic within a 128-record/revision budget;
larger requests must use the admin batch action. `keep` accepts 10–10000 and
defaults to 100. Malformed legacy Profile startDate types are rejected before
batch writes. Existing NSCF upload, query and scan budgets remain stricter than
upstream's general 10,000-item batch ceiling.

Beta.2 adds Workers adapters based on Connect 0.0.13 for Dexcom Share,
Nightscout-source, LibreLinkUp and Glooko, legacy BRIDGE migration/protocol,
and a durable Webhook outlet. See the [configuration guide](../CONFIGURATION.md)
for opt-in settings and intentional platform limits. New SQLite DO migrations
v3 (SourceConnector) and v4 (WebhookDelivery) retain existing v1/v2 namespaces.
Sources and Webhook use the default dataset only; other tenants cannot activate
global credentials. Node/Docker/Mongo process features remain inapplicable.
Real-account AAPS/Loop/CGM and real Webhook receiver acceptance are required before
stable release; synthetic tests do not replace them.

## Running your own isolated test instance

Use a **separate Worker name**, its own Durable Object namespaces and a new
address. A preview URL of the production Worker does not isolate its data.
If using Pages, also use a separate Pages project and bindings. Do not attach
production `script_name` bindings, production routes or production custom domains.

```sh
git clone --branch ns-15.0.8/ns4cf-1.3-beta --single-branch \
  https://github.com/sid-luo/nightscout-for-cloudflare.git nscf-beta
cd nscf-beta
npm ci
NSCF_AUTO_UPDATE=0 npm run build
npm run check
npm test
```

For Cloudflare Git integration, select this testing branch and use
`NSCF_AUTO_UPDATE=0` in the build environment. Select the intended test account,
choose a unique Worker name, and set a separate `API_SECRET`. Keep the same
**test** name/data space for later beta commits so testing data persists. The
ordinary installer and README one-click links still deliver the stable track.

An independent maintainer test instance was deployed on 2026-09-08:
https://nscf-nightscout-beta.qwjklqw2182j.workers.dev/ . The first deployment used the verified
1.3.0-beta.1 prebuilt package (source commit `47ad24a`),
with its own Worker, SQLite Durable Object namespaces and API secret.
Anonymous data reads and writes are denied. The test credential is delivered
privately, never committed here. Initial Profile setup and real-client
acceptance remain the maintainer's next steps.

The deployment uses a pinned prebuilt package through Wrangler; no automatic
Git push deployment is configured. Subsequent verified beta packages should
update this same test Worker so its URL and test data persist.
`NSCF_AUTO_UPDATE=0` and source branch/commit markers are recorded on the
test Worker. No production resources or stable GitHub Release have changed.

Official source: [15.0.8 release](https://github.com/nightscout/cgm-remote-monitor/releases/tag/v15.0.8).
