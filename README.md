![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

**English** | [简体中文](README.zh-CN.md)

Deploy Nightscout to your own Cloudflare account without renting a separate server or MongoDB service. This project uses Cloudflare Workers and SQLite Durable Objects, preserving Nightscout's main pages, charts, plugins and calculations while adapting storage, synchronization and background tasks for Cloudflare.

This is an independent, unofficial open-source port. Actual costs depend on your Cloudflare plan and usage; application optimizations do not increase the platform's allowances.

> **Stable release: NSCF 1.3.2 · Based on Nightscout 15.0.8.**
>
> Reduces repeated REST database reads and internal Durable Object calls, and fixes immediate browser retries after a connection failure. Includes the earlier AAPS and Trio synchronization improvements. See the [release notes](https://github.com/sid-luo/nightscout-for-cloudflare/releases/tag/v1.3.2) and [measurements and test scope](docs/testing/REQUEST_BUDGET.md).

[Web installer](https://nscf.sidluo.com/) · [Upgrade an existing installation](https://nscf.sidluo.com/upgrade/) · [Deploy from GitHub](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

Both installers and GitHub `main` provide **1.3.2**. Existing instances update only when their owner starts an upgrade.

The [`1.4` test branch](https://github.com/sid-luo/nightscout-for-cloudflare/tree/1.4) is labeled **1.4.0-beta.1** and contains further read-quota hardening. It is a prerelease for validation; see the [measurements and test scope](docs/testing/READ_QUOTA_HARDENING.md). GitHub `main` and the default installers remain on stable **1.3.2**.

## Why this project exists

Nightscout is a great project. As a long-time user, I hope more people can deploy and use Nightscout easily, quickly and at low cost.

## What works today

- Use the Nightscout home page, glucose chart, trend arrows, status information, clock, reports and settings.
- Synchronize data through common v1, v2 and v3 APIs and real-time connections, including common AAPS / NSClientV3 upload workflows.
- Manage records in Admin Tools: preview and clean up glucose, treatment and device-status records by date, and retain a chosen number of Profiles.
- Enable data sources and Webhooks as needed. Newly added integrations are disabled by default; validation with real third-party services is still in progress.

## What is new in 1.3.2

- **Fewer repeated database reads.** Simple device-status queries apply the requested count directly in SQL instead of first loading up to 5,000 records. Unchanged device-status and treatment queries reuse bounded exact-result caches, and default treatment queries use an existing index. Writes and rollback invalidate the affected cache; complex filtering keeps its existing semantics.
- **Fewer internal calls per REST request.** Authentication and related data reads are combined. Common successful paths measured at 3–11 Durable Object calls now use 2, while preserving failure delays, current permissions and response behavior.
- **Controlled browser retries.** Failed connection initialization waits five seconds before retrying, with only one pending retry. Updated browser code uses a new asset URL so the previous bundle is not kept under the same cache key.

These changes were introduced in 1.3.2-beta.1 and are now included in the stable release. No database migration is added. The [test record](docs/testing/REQUEST_BUDGET.md) separates local measurements from real account usage: the fixes address reproduced issues, but do not establish the cause of every reported failure or guarantee a particular daily usage reduction.

## Improvements retained from 1.3.1

### Fewer repeated reads during Trio synchronization

Legacy v1 device-status uploads now update the query cache instead of invalidating it on every upload. Unchanged treatment, Profile and food queries reuse bounded cached results, and synchronous polling avoids duplicate queue reads. Time-window changes, writes, rollback and cache eviction still trigger the required refreshes. Historical records, writes and upload acknowledgments are preserved.

| Same local synthetic workload: 163 status uploads with an active browser | Rows read before | Rows read after | Rows written before / after |
| --- | ---: | ---: | ---: |
| No treatment history; all 1.3.1 cache changes combined | 13,700 | 6,123 | 3,111 / 3,111 |
| 2,000 treatment history rows; auxiliary-query changes after the initial v1 cache fix | 3,490,578 | 6,123 | 3,111 / 3,111 |

These fixtures measure specific read amplification, not customer bills or guaranteed daily savings. The second row uses a different baseline to isolate the treatment-history fix. The original reported authentication failure still lacks a confirmed server-side cause. See the [measurement details](docs/testing/TRIO_READ_OPTIMIZATION.md).

### Nightscout 15.0.8 changes carried forward from the 1.3 testing releases

The table below compares this port with the [official 15.0.8 release notes](https://github.com/nightscout/cgm-remote-monitor/releases/tag/v15.0.8). **“Adapted” means the corresponding code and focused checks are in place; it does not mean every client, device or real account has been validated.**

| Upstream change | Status in NSCF 1.3.1 |
| --- | --- |
| Date-range cleanup and Profile cleanup | Adapted; previews use the Profile time zone, and batch processing retains the completed count. |
| GMI / Revised GMI, report and time-zone fixes | Adapted; checks cover unit conversion, fixed offsets and day boundaries across daylight saving time. |
| AAPS temporary basal charts, OpenAPS predictions, historical COB and BWP | Adapted with focused regression tests; specific controller scenarios still need comparison in real use. |
| Clock emoji, units, legacy trend arrows and translations | Client changes synchronized, with Worker trend handling adapted; component and language checks are in place. |
| Input text sanitization, output protection, API3 filtering and identity checks | Adapted; NSCF retains its stricter request-size limits. |
| Split view, configured frame-source CSP and optional same-origin framing restrictions | Adapted; the same-origin restriction is enabled through configuration. |
| Dexcom Connect, legacy BRIDGE configuration, Nightscout-source, LibreLinkUp and Glooko | Cloudflare implementations and simulated tests are in place; newly added sources are disabled by default, and real-account workflows await validation. |
| New-glucose Webhooks, deduplication and retries | Persistent jobs and simulated tests are in place; disabled by default, with real receivers awaiting validation. |
| Dependency and test updates | Updated the client and sanitization dependencies this port uses and expanded Workers tests; the full Node server stack was not copied over. |
| Docker, MongoDB, file-mounted secrets and server listening addresses | Not applicable to the Workers architecture, which uses Cloudflare storage and variable configuration. |

### Additional NSCF fixes and optimizations

**Further reduce repeated reads and writes during AAPS synchronization.** This keeps the read optimizations released in 1.2.0 and addresses a remaining case where a new glucose record followed by an AAPS device-status upload caused repeated history reads. Caches update as records change, empty polls and connection keepalives avoid repeated queries, and two redundant indexes have been removed.

| Same local synthetic dataset | Before the 1.3 Beta optimization | After |
| --- | ---: | ---: |
| One new glucose record followed by one AAPS status upload: rows read | 6,128 | 102 |
| Same sequence: rows written | 45 | 42 |
| Full upload of 10,000 device-status records: rows written | 160,001 | 150,001 |

Reads fell by approximately **98.3%** in this combined scenario. This compares the same dataset before and after the Beta optimization; **it is not a direct measurement of stable 1.2.0 against 1.3, or a claim about daily usage reductions**. Records, history synchronization and upload acknowledgments are preserved. Caching does not mark old glucose as new data or add an external task that calls the server every second.

**Keep caches consistent with the database.** Failed writes discard the corresponding cache copy so an in-memory record cannot survive a database rollback. Activating an existing database also avoids repeated scans of historical indexes.

**Fix report calculations and display.** Changes address double-counting the first glucose record, duplicate records with the same timestamp, RMS omitting the last record, invalid results for single points or empty hours, loss of precision in hourly averages, and empty candlestick data.

**Fix date transitions and report loading.** Reports retain the selected dataset and use the next midnight in the Profile time zone as the end of each day's query range, including 23- and 25-hour days around daylight saving changes. Failed queries clear old results and allow a retry after the query conditions are corrected.

**Handle Cloudflare integration edge cases.** Changes normalize Nightscout source URLs, handle oversized responses and invalid dates, and persist synchronization progress and Webhook retry state. Beta builds do not automatically switch back to stable source code.

**Fix upgrade confirmation and recognition of older installations.** Resolves cases where the program was updated but the upgrade page still showed an unconfirmed result. Older web-installer instances can also be recognized when a Cloudflare settings update removed their installation marker. Upgrades still verify the original instance and databases, preserving the address, data, settings and original API key.

The basic read optimizations, web upgrade entry points and authorization-navigation fixes released in 1.2.0 are retained, rather than listed again as new features.

## Testing progress

- October 15 stable-release verification: **1,029 tests across 106 Workers test files** passed, along with the complete project test command, 10 dedicated browser retry/build checks, type checking and package construction. The October 15 installer verification separately passed **204 installer tests**. Coverage and limits are recorded in the [request/read test record](docs/testing/REQUEST_BUDGET.md).
- September 30 release verification: **1,012 tests across 102 Workers test files** passed, along with the complete project test command, type checking, source build and upstream-mapping checks. Regression coverage includes rollback, time-window boundaries, cache eviction and interleaved queries.
- Earlier 15.0.8 adaptation: 355 upstream client tests and 162 upstream server-plugin tests passed. Two pre-existing upstream skipped cases remain documented; this is not a claim that the entire upstream test suite passed.
- Reports: 13 upstream module tests, 33 overlay tests, and browser checks of 11 report views using synthetic data.
- AAPS: virtual-pump testing verified upload acknowledgments, real-time events and the phone's upload queue returning to zero, followed by observation of uploads across day boundaries and database usage. This does not extend validation to every real pump, Loop or third-party service.
- Installation and upgrading: on September 15, isolated Cloudflare instances with synthetic data verified that upgrading 1.2.0 preserves the address, original databases, records and revision history, settings and API key. Recovery after a lost success response and repeated finish requests required no additional upload. A fresh Beta installation passed authenticated read/write checks. That installer revision passed **172 tests**, type checking and build checks for both languages. The September 29 testing-channel update subsequently passed **192 installer tests**; the September 30 stable-package update passed **199 installer tests** (41 Node script tests and 158 Vitest tests) and deployment dry-runs for both languages. Installer and application checks are counted separately.

Known limitations include occasional internal-task connection interruptions, one application exception whose cause is still unknown, and a stale-data notification gap after more than 48 hours without glucose. Real third-party integrations and controlled offline catch-up still need further validation. The full scope is documented in the [test record](docs/testing/NIGHTSCOUT_15_0_8.md).

## How to use

### 1. First installation

Use the [web installer](https://nscf.sidluo.com/) to deploy **1.3.2** without GitHub or a command line.

You can also use the GitHub deployment button to deploy **1.3.2** from `main`, following the [first-time deployment guide](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started).

### 2. Upgrading

For a supported instance deployed through the web installer, including 1.2.0, 1.3.0-beta.2, 1.3.1 and 1.3.2-beta.1, open the [English upgrade page](https://nscf.sidluo.com/upgrade/), authorize the original account, select the instance and confirm the upgrade to **1.3.2**. The upgrade preserves your address, data, settings and original API key, so AAPS keeps its existing configuration. Other instances are not upgraded automatically.

Existing 1.3.2-beta.1 installations can upgrade to stable 1.3.2 through the same page.

Instances deployed through the GitHub button or not recognized by the installer are not supported by this path. If the original `API_SECRET` is a Cloudflare Secret, the page asks you to save the same original value as a plain-text variable before checking again.

### 3. API key

Future installations and upgrades will use a plain-text `API_SECRET` that can be viewed and edited in the Cloudflare dashboard. Upgrades will preserve the original key instead of generating a new password. The site continues to use HTTPS, and client authentication remains unchanged. Do not include the plain-text value in public source code. Existing instances do not need a separate change for this purpose.

## Nightscout and Nightscout for Cloudflare

Nightscout for Cloudflare is an independent, unofficial Cloudflare port of
Nightscout. It keeps the upstream Nightscout version and the port version
separate:

- Nightscout upstream version: **15.0.8**
- Nightscout for Cloudflare version: **1.3.2**

The upstream Admin Tools still provide their corresponding functions, but this
port stores records in SQLite Durable Objects instead of MongoDB. Some visible
names are therefore adjusted to avoid implying that a MongoDB database is
present.

| Original Nightscout name | Nightscout for Cloudflare name |
| --- | --- |
| Clean Mongo status database | Device status maintenance |
| Clean Mongo treatments database | Treatment records maintenance |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance |
| Remove future items from mongo database | Future-dated records maintenance |

## Technical documentation

- [Configuration and advanced features](docs/CONFIGURATION.md)
- [Cloudflare architecture](docs/ARCHITECTURE.md)
- [Upstream compatibility matrix](docs/UPSTREAM_COMPATIBILITY.md)

## Safety information

Nightscout for Cloudflare is an independent, unofficial, open-source community
project. It is not an official Nightscout release, does not come with guaranteed
technical or medical support, and has not been officially approved or regulated
for diabetes therapy or treatment. Anyone who deploys it is responsible for
building, configuring, securing, maintaining and operating it, and does so at
their own risk.

Nightscout for Cloudflare requires a working internet connection and the
availability of Cloudflare services. Do not rely on it as your only way to know
your blood glucose values or trends, or as the basis for diagnosis, treatment or
insulin dosing. Be ready for unexpected failures and always keep an independent
way to check your blood glucose levels.

These precautions follow the [official Nightscout safety guidance](https://nightscout.github.io/).

## License and attribution

This project is licensed under `AGPL-3.0-only`. Nightscout contributors retain
all rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
