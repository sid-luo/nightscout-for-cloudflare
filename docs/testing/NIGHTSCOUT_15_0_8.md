# NSCF 1.3 beta — based on Nightscout 15.0.8

NSCF version: **1.3.0-beta.1**. Development branch:
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
  environment fallback. Existing connectors remain within their prior scope.
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
  default remains `true`; broader `SECURE_CSP*` support is unchanged.
- Prerelease builds cannot auto-refresh themselves from the stable source
  channel, even when `NSCF_AUTO_UPDATE=1` is set. The default Worker name in
  this branch is `nscf-nightscout-beta`.

## Validation — 2026-09-07

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

New connectors, Connect auto-migration, webhook support, Docker/Node server
features and unresolved upstream-only integration tests are outside this
upgrade. Real-account AAPS/Loop/CGM acceptance is still required before stable
release; local synthetic tests do not replace it.

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

A Cloudflare test account has not yet been selected, so there is no deployed
15.0.8 test URL. A prebuilt installer-compatible package has been prepared
locally, outside the production installer's asset directories. No production
resources or stable GitHub Release have been changed.

Official source: [15.0.8 release](https://github.com/nightscout/cgm-remote-monitor/releases/tag/v15.0.8).
