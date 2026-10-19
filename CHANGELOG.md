# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

This log covers Nightscout for Cloudflare changes. The upstream Nightscout
version is tracked separately. Existing users should follow the
[upgrade instructions](README.md#2-upgrading). Upgrades currently support only instances deployed with the quick installer.

## 1.4.0 — Database read optimization and authentication fixes (2026-10-20)

Based on Nightscout 15.0.8, this version further reduces repeated database reads and fixes quota error messages and API key verification.

### Changes

- Reduce repeated reads in shared device-status, treatment, glucose and Profile paths during browser refreshes, real-time synchronization and access by multiple clients.
- Improve cache updates during ongoing uploads, initial warming and rebuilding after object eviction. Keep query results current as records and time windows change.
- Extend treatment query planning and bounded reuse for large histories, fields, arrays, filters, custom sorting and pagination. Fix inconsistent custom sorting of mixed-type fields while retaining filtering, pagination, permissions, error and rollback checks.
- Distinguish database read-quota, connection and server failures from explicit authentication denial. Temporary failures preserve verified credentials, honor `Retry-After` and use one pending retry. Verify each candidate API key independently of the existing JWT; change the identity and remembered key only after successful verification, and ignore stale hashes, responses and background refreshes.
- Add optional `READ_DIAGNOSTICS=1` request/RPC measurements, disabled by default. Diagnostic logs omit record bodies, credentials and query values; diagnostic measurement itself adds no SQL or persistent database writes. Coverage is defined in the test record.

### Measurements and validation

| Same local workerd synthetic workload: 12 simulated minutes, 192 GET handler calls | Stable 1.3.2 | Current 1.4 implementation |
| --- | ---: | ---: |
| Database rows read | 2,345,216 | 8,154 |
| Database rows written | 182 | 200 |

The workload starts with 5,000 device-status and 5,000 treatment records, performs twelve status uploads and two treatment uploads, and advances the clock for four readers. Reads decrease by approximately **99.65%**, while writes increase by **18 rows**, including index maintenance. These are local synthetic measurements, not customer bills or daily usage. See the [current regression case](test/continuous-http-read-budget.test.ts) and [measurement methods and detailed audit record](docs/testing/READ_QUOTA_HARDENING.md).

The October 18 runtime validation passed **1,328 tests across 171 Workers files**, including full-day synthetic workloads, ongoing uploads, cold recovery, complex queries, permissions and rollback. Type checking, Worker packaging and UI patch checks passed; the rebuilt client passed **41 initialization tests**. Version guards and Worker checks passed separately after the version-label update. The installer separately passed **207 tests**.

### Upgrading

Users choose and confirm an upgrade on the upgrade page. Upgrades retain the original instance address, data bindings, settings and API key. Existing instances are not upgraded automatically, and older sealed testing jobs remain pinned to their original package.

## 1.3.2 — Stable release with fewer requests and database reads (2026-10-15)

Promotes the request and read optimizations introduced in 1.3.2-beta.1 to the stable release:

- Simple device-status count queries read only the requested candidate limit in SQL. Bounded exact-result caches reuse unchanged device-status and treatment responses, including empty results; default treatment queries use an existing index.
- Common successful REST paths use **2 Durable Object RPCs instead of 3–11** in local tests. Authorization failure delays, current permissions and response semantics are preserved.
- Failed browser connection initialization waits **five seconds** before retrying, with one pending retry and obsolete callbacks ignored. The updated browser bundle receives a new asset URL and cache key.

No database migration is added. GitHub `main` and both web installers provide **1.3.2**. Supported existing installations, including 1.3.2-beta.1, can upgrade while keeping their address, data, settings and original API key. The older testing build is no longer offered for new jobs; existing pinned testing jobs can still resume with their original package. Existing instances are not upgraded automatically.

See [measurements, regression coverage and limits](docs/testing/REQUEST_BUDGET.md). These changes fix reproduced NSCF issues; the exact cause and exhausted quota in the original user report remain unconfirmed.

October 15 validation passed **1,029 tests across 106 Workers files**, the complete project test command, ten dedicated browser retry/build checks, type checking and package construction. The installer separately passed **204 tests** and deployment dry-runs for both languages.

## 1.3.2-beta.1 — Request and database-read optimization (2026-10-13, testing branch)

The `1.3.2-beta.1` branch limits count-only device-status reads in SQL, caches exact unchanged device-status and treatment responses, and uses the existing treatment index. REST authentication resolves within one Durable Object call; entry freshness and data, and plugin context and status, each share a single data call. Authorization failure delays and current role checks remain in place. Browser initialization now waits five seconds before retrying a failed connection, with one pending retry and obsolete callbacks ignored. Updated client code receives a new asset URL.

At its October 13 publication, this was an optional testing upgrade and the stable default remained **1.3.1**. The changes were subsequently included in stable 1.3.2. No new database migration is introduced, and uploads, history, filtering and output semantics are retained. See [measurements, regression coverage and limits](docs/testing/REQUEST_BUDGET.md). These fixes address reproduced amplification in NSCF; the original report's exact exhausted Cloudflare quota is still unconfirmed.

## 1.3.1 — Stable release with Trio read optimization (2026-09-30)

Promotes the Nightscout 15.0.8 adaptation and the tested 1.3.1-beta.1 runtime to a stable release. Legacy v1 status uploads update the cache incrementally; unchanged treatment, Profile and food queries reuse bounded prefixes; time-aware cache rules and synchronous polling reduce repeat SQL without removing records, writes, revision history or upload acknowledgments. No new schema change is introduced relative to beta.2.

With an active browser, the same synthetic 163-upload workload fell from **13,700 to 6,123 rows read**, with **3,111 rows written in both runs**. A separate workload with 2,000 treatment rows fell from **3,490,578 to 6,123 reads** after the initial v1 cache fix. These are targeted local measurements, not account-wide billing predictions. The application passed **1,012 Workers tests across 102 files**; see [measurement scope and validation](docs/testing/TRIO_READ_OPTIMIZATION.md).

At its September 30 publication, GitHub `main` and both web installers began providing **1.3.1**. Supported existing installations can select it on the upgrade page while retaining their address, original databases, settings and API key. The upgrade page also supports explicitly confirmed testing builds when a newer one is available, pins the selected package through retries and blocks recognized downgrades. Existing instances are not updated automatically.

Includes the AAPS synchronization, report, time-zone, Admin Tools and integration changes documented under beta.2. Default-off third-party integrations still need real-service acceptance, and previously recorded runtime limitations remain open. The original reported Trio authentication failure is not confirmed to have been caused by read amplification.

The September 30 installer verification passed **199 tests**: 41 Node script tests and 158 Vitest tests, plus type checking and deployment dry-runs for both languages. Installer and application counts are separate.

## 1.3.1-beta.1 — Trio read optimization testing branch (2026-09-29)

Branch `1.3.1` adds incremental caching for legacy device-status writes, bounded raw query-prefix caching for unchanged treatments/profile/food, time-aware recent-treatment and Profile Switch cache rules, and fewer duplicate reads during synchronous polling dequeue. Writes, revision history and notification/output semantics are retained. Tests cover rollback, time-window boundaries, output budgets and persistence after eviction. See [branch testing evidence](docs/testing/TRIO_READ_OPTIMIZATION.md). The September 29 branch publication did not create a Release or deploy the web installer. A separate installer update later that day added this fixed testing package as an explicit upgrade option; 1.3.1 subsequently promoted the runtime to stable.

That September 29 testing-channel installer update passed **192 installer tests**, with type checking and deployment dry-runs for both languages.


## 1.3.0-beta.2 — Nightscout 15.0.8 adaptation and read/write optimization (2026-09-15, prerelease)

Adds default-off Cloudflare adapters for Nightscout-source, LibreLinkUp, Glooko and Webhook, plus BRIDGE automatic migration and an explicit legacy protocol mode. Sessions, page cursors and delivery retries survive restart; real-service acceptance remains pending. Fixes fixed-offset Profile timezones and admin date bounds, adds enforced/report-only CSP with configured frame origins, and executes real upstream report modules for GMI/RMS and boundary regressions. The old skipped full-report suite is now honestly marked unresolved. See the [configuration guide](docs/CONFIGURATION.md) and [beta testing evidence](docs/testing/NIGHTSCOUT_15_0_8.md).

At its September 15 publication, this prerelease became available from GitHub `main` and both web installers. It further reduces repeated database reads during AAPS synchronization and index writes during backfill, preserves cache consistency after failed writes, and fixes report counting, RMS, empty-hour results and daylight saving boundaries. The upgrade service also fixes unconfirmed completion results and recognizes older installations whose markers were removed by a Cloudflare settings update. Addresses, original databases, settings and API values are preserved during supported upgrades; existing instances are not upgraded automatically. See the [README](README.md) and [release notes](https://github.com/sid-luo/nightscout-for-cloudflare/releases/tag/v1.3.0-beta.2). The previous stable release remains available at [v1.2.0](https://github.com/sid-luo/nightscout-for-cloudflare/tree/v1.2.0).

The adaptation also covers Dexcom Connect, client translations, units and legacy trend arrows, input/output protection, API3 filtering and identity checks, and the optional same-origin frame restriction. Cloudflare uses its own storage and variable configuration; the upstream Docker/MongoDB/server-listener stack is not copied into this port.

| Same local synthetic dataset | Before the 1.3 Beta optimization | After |
| --- | ---: | ---: |
| One new glucose record followed by one AAPS status upload: rows read | 6,128 | 102 |
| Same sequence: rows written | 45 | 42 |
| Full upload of 10,000 device-status records: rows written | 160,001 | 150,001 |

This is a before/after comparison within the Beta work, not a direct stable 1.2.0-versus-1.3 measurement. The paired upload reads decrease by approximately **98.3%**. Records, history synchronization and upload acknowledgments are retained; caching does not mark old glucose as new or add an external task that polls every second. Report fixes cover duplicate first/tied glucose points, RMS omitting the last point, single-point and empty-hour results, hourly precision and empty candlesticks. Date bounds use the next midnight in the Profile time zone, including 23- and 25-hour days; failed report queries clear old results and allow retry.

Recorded validation includes **355 upstream client tests**, **162 upstream server-plugin tests**, **13 original-module plus 33 overlay report tests**, and browser checks of **11 report views**. Two pre-existing upstream pending cases remain documented. A real AAPS client with a virtual pump verified upload acknowledgments, realtime events and its upload queue returning to zero, followed by observation across day boundaries. On isolated Cloudflare instances with synthetic data, 1.2.0 upgrades preserved the address, original databases, records, revision history, settings and API key; a lost success response and repeated finish required no additional upload. Fresh Beta authenticated reads/writes also passed. The September 15 installer passed **172 tests**, type checking and build checks for both languages. Detailed scope remains in the [15.0.8 test record](docs/testing/NIGHTSCOUT_15_0_8.md).

## 1.3.0-beta.1 — Nightscout 15.0.8 testing track (unreleased)

The initial beta.1 was an independent testing branch only. It updated the unmodified upstream client and
source snapshot to 15.0.8, API3 to 3.0.5 and Socket.IO client to 4.8.3. Includes
stored-text and XML output hardening, BWP/COB/OpenAPS/direction fixes, profile
APNS environment selection, and bounded admin date-range/profile cleanup.
Prerelease source builds stay pinned to their checkout. See the
[testing track](docs/testing/NIGHTSCOUT_15_0_8.md) for evidence and limitations.

At the initial beta.1 stage, no stable Release, installer publication or production deployment was included.


## 1.2.0 — Read optimization and existing-instance upgrades (2026-09-06)

This release includes the read optimization. Both Chinese and English upgrade pages are live; existing deployments require the user to confirm an upgrade.

### Changes

- Preserve the Slovenian translation compatibility alias used by the web installer.
- Reduce repeated historical queries when AAPS/NSClientV3 device-status uploads
  update the website.
- Reuse unchanged glucose query results and merge the changed device-status row.
  Database reads remain available when data changes, the object restarts, or
  cached results cannot be safely reused.
- Return an explicit temporary-unavailability response and retry interval for
  recognized database read-quota failures.

No historical records, upload acknowledgements, history synchronization or
necessary website updates were removed. Nightscout calculations and existing
filtering, sorting and output bounds are unchanged.

### Validation

For the same synthetic local workload, one device-status upload with a connected
browser used **41 rows read instead of 2,060: approximately 98% fewer**. Initial
page loading still retrieves history. **875 core tests**, type checking and the
build check passed.

This measures a particular upload scenario, not a guaranteed 98% reduction in
account-wide daily usage. Cloudflare's free read and write quotas remain
unchanged. See the [measurement details and limits](docs/performance/realtime-read-amplification.md).

### Web upgrade flow

- Add separate upgrade pages with links to and from the installer. Reuse each site's OAuth app and return to the upgrade page in the same language.
- Identify the original instance and verify database bindings. Update code and assets while keeping the address, database, password and settings.
- Compare the actual release fingerprint, not only the version number. Support retrying confirmation after a temporary failure in the final step.
- Fix the authorization leave-page prompt and Cloudflare discovery pagination parameters; read all result pages.
- The bilingual installer passed 129 tests, type checking and deployment build checks. Mock browser checks cover confirmation, refresh and retry, address preservation, error states and mobile layout.

### Getting the update

- **Web installer:** the [English upgrade page](https://nscf.sidluo.com/upgrade/) and [Chinese upgrade page](https://ns.sidluo.com/sj/) are available for connecting the original account and choosing an instance. Check the available bundle version shown on the upgrade page before confirming.
- **GitHub one-click deployments:** one-click upgrades are not currently supported.

The upgrade flow does not create databases or migrate old data. Unrecognized installations, mismatched migration versions or custom bindings need separate review. New installations still create separate instances. Daily database quotas and existing compatibility limits are unchanged.
