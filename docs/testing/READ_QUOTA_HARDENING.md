# Read quota hardening — NSCF 1.4.0

Base: stable 1.3.2, `8d2395a0e7141feb55c6656ef62801795ab4c1f3`.
NSCF 1.4.0 promotes the sealed `read-budget-hardening` implementation prepared
on October 18, 2026 and subsequently packaged as `1.4.0-beta.1` on branch `1.4`.
The stable release updates version metadata, the displayed version and matching
assertions; runtime logic remains the final sealed audit implementation.
Dated audit sections preserve the local state and version at the time of
measurement. Release availability and user-facing changes are recorded in the
[changelog](../../CHANGELOG.md).

The reporting YouTube user's version, workload and database remain unknown;
these are reproducible shared-code defects, not a claim to have uniquely
identified that user's incident. Earlier audit tables below preserve
historical measurements; the first-cold/large-field/isolated-learning audit
below describes the latest local package. The preceding cold/partial/upload
and authorization/ordinary-reader audits remain part of the cumulative patch.

## First cold bulk read, large-field refusal and isolated learning (latest audit)

This follow-up adds zero persistent writes, tables, indexes, migrations, alarms
or cache capacity. Runtime changes are limited to EntryStore's fixed auxiliary
treatment readers, the existing membership helper and Profile validity helper.
Clinical results, native residual predicates/order, original error windows,
permissions, rollback, all-day budgets and diagnostic scopes remain required.

A cold properties or realtime ddata/frame reader previously interleaved each
of seven fixed categories with progressive membership learning, repeatedly
scanning history before that learning completed. After the first expensive
original category cursor **naturally reaches EOF**, the eligible top-level
bulk reader now moves the remaining categories' existing learning turns before
their fallback scans. It performs at most the same seven logical candidate
calls, preserving the original 5,000-row batches, 32,768 soft long-array-work
gate (a current row can finish beyond it), and pool limits.
Once upfront learning starts, subsequent loaders in that bulk only peek at
existing complete authority. Partial, dense,
foreign, refused or unsafe coverage still uses the entire original SQL.
A category-iterator consumer return or SQL failure cannot trigger upfront learning.

A negative-only in-memory guard permits this reorder only while the fixed
treatment windows are truly unused. An actual category access consumes the
qualification, including a cache/native hit; a full treatment invalidation
rearms it. A nested scope declines both parent and child reordering and finally
restores the parent scope. Fresh object construction may itself read a snapshot,
so a new object does not guarantee eligibility on its first HTTP request.
No cold flag, partial prefix or peek result authorizes data outside the existing
complete, generation/epoch-checked membership pool. Mixed cached windows,
near-EOF partial views and cheap queries retain the original policy.

Four real properties HTTP requests after genuine uploads and a sealed recovery
of 20,001 historical scalar plus 35 long-array treatments now cost
**40,214 / 136 / 139 / 142 = 40,631 reads**, versus the preceding package's
140,404 / 136 / 139 / 142 = 140,821, a 71.15% reduction. Each GET writes zero
rows. The membership source still costs 20,042 reads in six calls: the saving
comes from reducing six broad category scans to one, not a larger build.
This HTTP counter excludes fixture/upload/oracle and constructor SQL. A separate
same-state replay of the preceding policy and independent original result SQL
measures private properties 140,756 -> 40,566 and ddata 140,780 -> 40,590.
A 90-day-old history outside age windows improves only 40,756 -> 40,566.
Cheap queries remain 1,060 -> 1,060; a near-EOF partial case remains 24 -> 24
and a mixed already-cached partial case remains 296 -> 296, each one build.
These scopes are distinct and are not summed or substituted for HTTP totals.

Isolated category queries deliberately retain their original progressive
learning. Their seven-read replay remains exactly 120,043 on both policies;
the original large-store test and sixth/seventh-upload payback remain unchanged.
A peek-only isolated draft was rejected because it would never warm itself,
leaving repeated broad scans indefinitely. A partial PK-UNION prototype passed
result parity but regressed an out-of-age-window first read from 40,277 to
70,244; it is archived as a rejected experiment and is absent from runtime.
Necessary-superset correctness alone does not establish a bounded-cost source.

After DML invalidates Profile's read-only anchor, the same-request volatile
whole-collection proof now checks the greatest PK first, retains only its ID
and UTF-16 work count, then verifies the strict preceding prefix. Both parts
require native and JS JSON validity, the original ASCII ID/body limits and real
EOF. Tail plus prefix retain the 10,000-source-row, 128 KiB/body and 4 MiB parse
work limits, with the original total_changes/generation checks. No successful volatile
proof or body is retained across requests/rollback; refusal only disables the
optional path. The read-only proof and old 5,000-row error window are unchanged.

With 6,001 Profile rows and a 200 KiB body at the final PK, the first real HTTP
read falls from **18,010 to 12,010**, because the rejected proof reads one row
instead of 6,001. Repeat refusal remains 12,009. A large body at head or middle
adds one read (12,011 -> 12,012; 15,011 -> 15,012). In the measured Profile-only post-DML fixtures, the strict native prefix
endpoint costs one extra billed source row: 32-row HTTP 40 -> 41 and 6,001-row
HTTP 6,009 -> 6,010. The mixed-collection deep audit remains 5,008 on both policies. Exact 9,999/10,000
boundary proofs read 10,000/10,001; >10,000 still refuses within 10,001 and
costs 30,010 first / 20,009 repeat. Uniform 4 MiB work refusal still costs
13,744 first / 12,009 repeat. This is an explicit measured tradeoff, not a
universal large-field or first-read improvement, and the work cap is not a
whole-request CPU bound.

The final focused combined workload keeps the same 81 HTTP requests, four
simulated minutes, two true sealed recoveries and 256 side-budget rows.
Intercepted SQL, including constructor/authentication/uploads and background
running during inspection and at the tail, costs **110,784 reads / 1,113 existing
writes**, versus 310,814 / 1,113 in the preceding package. Fixture/enrollment/JWT
creation, original-result oracles and inspection SQL are excluded, as are KV
and internal platform operations outside SqlStorage.exec. Background scheduling affects these
totals: the earlier current-package exploratory run was 110,409. All 375
additional reads equal the captured per-phase alarm deltas (2,853 -> 3,228);
that earlier result is not substituted for the frozen final run. Diagnostic awaited-RPC read reports stay
213 / 1,115 / 73 / 84, exactly equal to native same-scope counters; constructor
and background remain explicitly outside that diagnostic scope. This is a
four-minute fixture, not an all-day or arbitrary-environment quota guarantee.

Frozen validation passed: `npm test -- --maxWorkers=2`, 171 files /
1328 tests, including unchanged original all-day and upstream report workflows;
focused 8 files / 32 tests; reviewed old cost files 2 / 8;
TypeScript, local Worker dry-run, diff check and UI patch reverse check.
The first full run passed 1,326/1,328 and failed only two descriptive cost
snapshots. Manual changes were restricted to two cold privateRoot counts and
removed fallback entries, and the two Profile proof-source SQL shapes (the
latter fixture's total remains 5,008). No snapshot update command was used.
Earlier Profile contract changes only describe volatile two-part calls and
measured source +1; original results, side/writes, limits and rollback gates
were preserved. Two EOF unit failures proved the fixture's fresh constructor
had legitimately consumed cold eligibility; only the test setup now uses the
real full-treatment invalidation. The cheap fixture separately keeps the same
selected latest rows while adding older matches to avoid an actual partial-sort
full scan. Failed/interim logs and decisions are retained, not counted as passes.

Worker: 2,160,765 bytes, SHA-256
`71a958a4723e280e3f302cfdef025462113c8728aebf699e9c4077dd4c136c28`. All 218 public assets remain byte-identical to the preceding
package. Evidence is in `first-cold-large-fallback-audit/`; its finalizer checks
184 source/test/document files, a hash-verified archive and an 11-file package
patch with forward/reverse byte replay. The branch/version remain uncommitted
`read-budget-hardening` / 1.3.2. No upgrade, push, publication or deployment
occurred. Neither this finite fixture nor the parse-work cap establishes a
universal quota or CPU guarantee.



## Cold recovery, unfinished membership and continuous uploads (preceding audit)

This package adds zero persistent writes, tables, indexes, migrations, alarms
or cache capacity. It changes three optional read paths while preserving the
original data, residual predicates, native order, page and error contracts.
The version remains local uncommitted 1.3.2; no upgrade or deployment occurred.

Deferred treatment schemas used seven independent properties category loaders
(Profile Switch plus six age categories). Treatment uploads cleared their
bounded results, so they repeatedly scanned the same history. These loaders
now reuse the existing **complete** membership superset. Empty categories need
no treatment data query; sparse categories use a bounded PK source with the
entire original text/JSON/time/duration/order/limit predicate. Array members,
stale IDs and rollback ghosts cannot bypass that predicate. Partial, dense,
unsupported or unsafe coverage keeps the original SQL. Only naturally completed
expensive cursors advance learning; an output-budget stop is not EOF. Existing
native and completed side-index paths are unchanged.

Four actual properties HTTP requests after four genuine treatment uploads,
starting from a true sealed recovery of 20,001 historical scalar and 35 long-array
treatments, measure 561,657 → 140,821 reads, with zero request writes. The four
before samples are 140,400 / 140,409 / 140,419 / 140,429; after samples are
140,404 / 136 / 139 / 142. The first cold request adds four reads; the benefit
comes after learning completes. A separate isolated-category fixture has a
short-run regression: cold age-battery 20,004 → 25,005, and three upload/read
cycles 20,005 / 20,006 / 20,007 → 25,006 / 25,007 / 25,008. These four extra
5,001-row learning batches total 20,004 reads before EOF; they are not reported
as a cold-read improvement. The original five-sample audit remains intact,
with separate continuation evidence: after another genuine upload, read six
completes coverage at seven reads; read seven after another upload costs two
reads and performs no membership build. Both GETs write zero rows; each upload
separately costs 14 reads / 18 existing writes. The seven selected current
loader reads total 120,039, strictly below 140,029 actual same-state reads from
seven complete original indexed category queries. This original category SQL
is a lower bound excluding old metadata/future lookahead, not a replay of the
whole old loader. Ordinary-window/warm/oracle/upload work is outside this
seven-read scope. Eviction before payback or stopping early still pays more.
The four-properties fixture has exhausted the existing optional
daily backfill budget, and its measurement excludes fixture/upload/oracle and
constructor SQL. Complete full-input results match independent original SQL.

Unfinished **global** membership coverage can now exclude proven non-members
from its processed prefix while retaining every ID beyond the frontier and all
monotone old/new mutation candidates. This is a necessary superset, not an empty
or complete result. It is limited to legacy reads with at most 16 filters and
only when the expanded SQL/bindings fit the existing limits; original validation
runs first. SQLite still applies the full original predicate, order and page.
Focused partial views keep the old path: an attempted extra sparse-ID probe
added one read to an existing capacity test and was rejected without changing
its gold. API3 partial optimization is also disabled. The native and deferred
lazy-error fixtures compare against each original SQL outcome; the first failed
fixture had not evaluated the original, and later proved that deferred original
SQL itself also threw. No new API3 planner defect is claimed from that fixture.
The original EOF, 5,000-row batches, long-array work limit and memory caps remain.

Two actual repository learning lifetimes measure 237,088 → 138,688 reads for
77 long-array rows and 235,513 → 202,713 for 20,001 old scalar plus 35 near
long-array rows, with zero writes. The separately captured raw SQL prototypes
cost 138,686 / 202,713; they are not the runtime baseline. The old scalar prefix
lies outside the original date window, so its first four partial batches show
no reduction; only the later long-array prefix helps. Native sort/ties/page,
duplicate JSON keys, unknown suffix, mutation union, rollback ghosts, dense
and focused refusal, SQL/bind limits and lazy errors retain original oracles.

Profile/current no longer permanently loses all optimization after unrelated
CGM uploads. The old read-only activation proof and constructor anchor remain.
A DML-invalidated activation may instead synchronously verify the whole Profile
collection and execute the live indexed top-one within the same request, checking
`total_changes()` and cache generation before and after. Successful validity or
profile data is never retained across requests or rollback, and the old anchor
is never re-sealed. This per-request scan admits at most 10,000 source rows,
128 KiB per body and 4 MiB of UTF-16 JSON.parse input work, with true EOF required.
The work cap is not a total SQL/HTTP CPU or memory cap. A sticky boolean can only
decline optional work after unsupported/over-limit input; it cannot authorize
any result. Native errors still propagate, and refusal retains the old parse
window, response and errors.

Across three actual reads after genuine CGM uploads, Profile/current measures
213 → 120 reads for 32 profiles and 36,027 → 18,027 for 6,001 profiles, with zero
GET writes and unchanged separately measured upload costs. The read-only costs
40 / 8 / 8 / 8 and 17,010 / 1,009 / 8 / 8 remain unchanged. Refusal has a first-use
cost: an over-10,000 collection first costs 30,010 rather than the old 20,009,
then returns to 20,009 even after another upload. A 6,001-row large-body fixture
first costs 13,744 rather than 12,009, then returns to 12,009. Raw mutation,
first fill inside a private transaction, restored malformed data and rollback
are compared to the original response/error; no permission cache is added.

The same four-minute, 81-HTTP-request combined fixture with two true sealed
recoveries measures 1,066,275 → 310,814 native reads (70.85% fewer), with the same
1,113 existing writes and 256-row side-maintenance budget. Constructors,
authentication, uploads, inspection-window alarms and the final background tail
are included; actual fixture/enrollment/JWT setup and result-oracle SQL are
excluded. Properties now complete learning before the same three missing-category
requests in each minute, so only stage assertions move; request count, clinical
oracles, fresh glucose/correction, revocation, 1.5M/5,000 budgets and 60-second
hang guard remain. Four diagnostic comparisons match independently captured
awaited RPC-body reads at 213 / 1,115 / 73 / 84; responses and zero writes match
with the flag off/on. Background differences are accounted separately.

This is a short mixed workload, not a new full-day or arbitrary-environment quota
guarantee. First cold reads, genuine eviction, partial coverage, selected long
arrays, dense/unsupported categories, large bodies and capacity refusal retain
costs. Activity and role lists keep their complete original windows and broad
reads. This package does not establish the reporting user's unique root cause
or claim lower billed CPU for every workload. Evidence, original sources, failed
runs and explicit decisions are preserved in
`output/diagnostics/read-budget-2026-10-18/cold-partial-upload-audit/`.

<!-- cold-partial-upload-audit-final-validation -->

Final validation: `npm test -- --maxWorkers=2` passes 168 files / 1,312 tests
(143.58 seconds), including both unchanged full-day fixtures and the upstream
client/server/report workflows. The new/boundary focused run passes 11 files /
45 tests; the three legacy-cost files pass 12 tests; the combined run passes.
The first full run's 1,309 passes / three legacy inline cost mismatches remains
archived. Three individually reviewed cost/SQL/plan blocks were changed by hand,
without `-u` or a generic bulk updater; clinical results, side state, writes,
original daily budgets and the 180-second guard are unchanged. The isolated
five-read +20,004 learning cost and separately measured seven-read payback are
both retained. TypeScript, Worker dry-run, diff and UI patch reversibility pass.
All 218 public assets are byte-identical. The preceding 177 sources remain
preserved; the final source archive has 181 files with 14 files in this package's
patch, verified by forward/reverse byte replay. Worker: 2,156,997 bytes, SHA-256
`4da14430368edf57b847452f91b41501a2b6d5e336cb145e68c04a456fee389c`.
Full evidence is in `cold-partial-upload-audit/final-evidence.json`.

## Authorization, ordinary readers and opt-in diagnostics (preceding audit)

Submitting a new API secret now verifies that candidate digest alone, without
an existing Bearer JWT masking the result. The active identity, permissions and
remembered credential change only after a successful candidate response.
Incorrect candidates, temporary storage failures and late callbacks preserve
the verified session. A successful switch with Remember disabled clears the
previous remembered digest. Background refresh cannot restore the previous JWT
or replace the new identity with a stale URL token. Treatment write controls
use verified write permission. Server permissions and credential precedence
are unchanged. The rebuilt UI passes all 41 client initialization tests; the
upstream single-argument hashauth contract remains supported.

The ordinary-path audit measures Profile/current, simple and custom Activity
queries, and stored+builtin role lists at 32 and 6,001 source rows. HTTP handlers
call actual EntryStore methods through an owner proxy for SQL accounting;
fixture construction, independent result oracles and constructors are excluded
from this table. These are logical RPC counts, not transport measurements.
The additional Profile fixture really evicts and recreates the Durable Object
before the four measured requests. Mixed startDate types, a 96 KiB field,
malformed JSON, old 5,000-row windows and exact wire results are preserved.

| Read-only Profile/current | Former reads per request | New reads across four requests | Former four-request total | New total | New writes |
| --- | ---: | --- | ---: | ---: | ---: |
| 32 source rows | 71 | 40, 8, 8, 8 | 284 | 64 | 0 |
| 6,001 source rows | 12,009 | 17,010, 1,009, 8, 8 | 48,036 | 18,035 | 0 |

The former four-request totals are four times the measured original current
request cost, not a separately replayed four-current-request baseline. All new
four-request samples are measured.

This is a deliberately narrow optimization. A whole-collection proof checks
both native JSON validity and actual JavaScript parsing in PK batches of
5,000 plus an EOF probe. Partial progress cannot authorize the shortcut.
Only losslessly round-trippable printable ASCII IDs of 1–128 characters and
bodies at most 128 KiB enter the optional proof; unsupported rows fall back
without truncating the original result or introducing a new public error.
Proofs and progress use the existing 4 MiB shared pool. After true EOF, a live
native top-one query can use the existing Profile startDate index; no profile
body or permission result is cached. Inside-window malformed rows still fail,
while malformed rows outside the old window do not create a new error.

One constructor `total_changes()` marker costs zero source reads and zero
writes. Any later DML change permanently refuses this activation's proof,
including raw SQL, a first fill inside a private transaction and rollback.
`total_changes()` does not roll back, and this is not a DDL/commit clock.
A fresh activation can learn again. Consequently active CGM uploads, cold
partial scans and capacity rejection still have their original broad-read
boundary. The 6,001-row first request is more expensive than before; the table
includes that cost. Exact missing-method fallback supports older DOs once;
operational errors and embedded matching text never trigger a retry.

Activity still consumes the original 5,000-candidate JavaScript filter/sort
window. In the 6,001-row fixture it costs 10,008 reads per request. Wide-role
default authorization costs 10,008 reads and the complete admin role list
costs 10,007, returning 5,000 stored roles plus seven uncovered builtins.
No full permission cache was introduced: current collection clocks do not
cover all legacy mutations, and caching an uncommitted role result could
survive a rollback incorrectly. These paths were measured and retain their
contracts; they are not claimed to have improved.

`READ_DIAGNOSTICS` is absent from default configuration. Only the exact string
`"1"` enables temporary, in-memory request/RPC measurement. The default path
makes no extra diagnostic RPC or SQL call. Enabled read RPCs execute the
original method once and return its value plus cursor metrics. Logs contain
route templates, operation names, random trace IDs and hashes of SQL/query
shapes; they omit SQL literals/bindings, URL values, credentials and clinical
bodies. AsyncLocalStorage isolates overlapping RPC scopes using the existing
nodejs compatibility configuration; see the [official runtime documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/).
No counters are persisted and the diagnostic code issues no additional SQL.

The log scope is awaited RPC bodies, excluding activation and background work;
`wallMs` is elapsed time, not billed CPU. Failed SQL, capture beyond 128 cursors,
unmeasured methods, failed RPCs or pending RPCs mark the report incomplete.
Known captured rows remain a partial count. Only an exact missing diagnostic
method falls back to the original read (two physical attempts, one logical
operation), with incomplete coverage recorded. Logging failure cannot change
the clinical response. The dedicated real-RPC HTTP test returns identical
Activity JSON and zero database writes with diagnostics enabled; it also tests
scope isolation, original errors, bounded capture and fallback behavior.

The combined fixture covers four simulated minutes, 81 HTTP requests and two
true sealed object recoveries. It starts with 20,001 historical scalar treatments
and 35 long-array treatments (1,025 members each), then mixes one-minute glucose
uploads/correction, status, treatments, Activity, Profile/current, properties,
custom sorts, partial-to-EOF membership learning and immediate role changes.
Its restricted default-role configuration makes the custom reader grant
independently revocable; the separate ordinary fixture measures readable
public defaults. Public v1 treatment `skip` is ignored by the original parser,
so this test does not claim that URL option exercises pagination.

The final focused run records **1,066,290 native rows read / 1,113 rows written**,
including constructor SQL, authentication, business uploads, side maintenance
and background alarms observed during inspection and the final counter harvest. Actual
fixture/enrollment/JWT setup and result-oracle SQL are excluded; SQL-independent
KV/platform work is not measured. The original limits remain fewer than
1,500,000 reads, fewer than 5,000 writes and a 60-second hang guard. Those writes
are the existing business and previously approved maintenance costs: this
package introduces zero persistent writes, tables, indexes, migrations or alarms.
This short stress fixture complements the existing full-day tests; its result
must not be extrapolated into a daily quota guarantee.

Four warm-activation diagnostic comparisons return identical complete results
and zero writes with the flag off/on. An independent test-owned async scope
compares actual native RPC-body cursors to the collector: 341, 1,115, 73 and 84
reads respectively, all exact. Additional full-window work is identified as
background alarm SQL, retained in the combined total rather than subtracted
as an unexplained difference. Earlier measurement logs that missed an alarm
batch during inspection (856 writes) remain preserved and are superseded by
the 1,113-write result. Four properties requests still consume 564,826 reads
in this large deferred-history fixture; cold and partial work remains expensive.

Final `npm test -- --maxWorkers=2` passes 164 Vitest files / 1,300 tests,
both existing daily workloads, upstream/client/server contracts and the original
report workflows. The first full run passed 1,299 tests and exposed one older
prototype fixture's uncontrolled random canonical IDs and two exact read-count
mismatches. Four IDs are now fixed at 6000–6003 (24-digit hex); only the two
corresponding read golds were manually tightened from 5,006 to 5,005 after
native measurement. All result, memory and write assertions stay unchanged.
No `-u` or automatic snapshot update was used, and the original clinical,
read/write and 180-second daily hang guards were not relaxed. The full fixed
six-test file and final full run both pass; failures and decisions are retained.
TypeScript, Worker dry-run and cumulative UI patch reversibility pass. The
218 public assets include 210 unchanged files and eight intentional bundle,
source-map, cache-key and referring-page changes. No upgrade or deployment was
performed. Source/test hashes are frozen; final documentation records the run.

Local evidence is in `auth-general-combined-audit/` under the root diagnostic
folder. Earlier audit sections below retain historical results and limitations.

## Why five million reads can disappear quickly

Rows returned are not rows examined. A count of one, or an empty response,
can still scan and sort thousands of records. The local workerd measurements
use each consumed SQL cursor's `rowsRead` and `rowsWritten`, including work
performed by indexes. They do not infer database work from HTTP request counts.

- The 1.3.2 serialized device-status cache rejects entries over 1 MiB. A
  5,000-record candidate response can exceed that limit, so even the same
  query without new uploads repeatedly reads history. Uploads also invalidate
  exact responses. A synthetic 5,100-record fixture consumed 10,001 rows on
  every candidate read. About 500 such queries consume five million rows;
  one per minute reaches that amount in about eight hours and twenty minutes.
- Missing treatment event categories still traverse history. A date index
  alone cannot seek a category that does not exist. Opposite ID ordering on
  equal timestamps can also make `LIMIT 1` visit an entire timestamp group.
- Properties, plugin inputs, realtime and notification loaders have their own
  treatment reads. Fixing direct REST queries does not automatically optimize
  those paths. Moving lower and upper time bounds previously bypassed caching.
- SQLite can choose the broad time index even after a matching category index
  exists. Actual query plans, rather than index existence, determine the cost.

The free SQLite Durable Objects allowance is five million rows read per day;
daily free limits reset at 00:00 UTC. This is separate from request limits.
See [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [SQL cursor metrics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Shared fixes

Device-status reads now share one raw latest-N candidate cache, capped at
5,000 records and 8 MiB including conservative metadata. Known writes update
it by canonical ID within a transaction fork. Unknown changes, deletion,
maintenance, unknown exact tie order, an exposed unknown suffix and oversized
results invalidate it. The old 5,000-record window, filtering, sorting and
coercion are preserved; no TTL or historical deletion is used.

The second audit found that ordinary four-by-48 prediction arrays can exceed
even this 8 MiB cache. The query-aware legacy RPC therefore filters the original
descending SQL cursor with the unchanged JavaScript predicate, stopping only
after enough matches or the original 5,000-candidate boundary. Valid custom
sorts still inspect the complete window. A partial stream is never installed
as a complete candidate cache. Cold wakes and changing date parameters do not
require the full prefix for a small, recent match. Missing RPC methods have
precise fallbacks; operational failures and quota errors do not retry them.

Two optional treatment indexes cover raw `created_at` ordering and event type.
String-category legacy queries split disjoint scalar and array candidates.
The category index uses a CASE expression to place every array in one bucket;
both branches can stream in date/ID order. SQLite MERGE applies one final
OFFSET/LIMIT after all original filters, avoiding the first draft's whole-prefix
materialization and rowid fetch. Point identities bypass that merge, and the
existing identifier index is selected when its schema is present. Equivalent
explicit sorts retain partial-index eligibility. UUID, arrays, null dates and
SQL binding limits retain their old semantics. Missing indexes retain the
preceding single-query path. The earlier raw-value v31 index was only local;
there is no published v31 schema to upgrade.

Canonical ISO date lower bounds also add a necessary raw index bound while
retaining the complete scalar/array predicate. Arrays remain eligible because
their serialized JSON begins with `[`, which sorts after the digit-leading
ISO bound. Arbitrary text, upper bounds and near-limit SQL statements retain
the original path; a derived predicate must not turn a legal query into a
binding-limit rejection. Mixed types, custom sorts and exactly 100 bindings
are covered by an independent former-SQL oracle.

Fixed raw-text event loaders use the category index only after confirming its
presence. This avoids SQLite's measured preference for a full time-range scan.
After a failed migration, capability state is discarded so read-only fallback
cannot force an index that rolled back.

Complete bounded treatment windows are reused while both time bounds advance.
The earliest future treatment provides a conservative expiry boundary: the
query reloads exactly when that record can become visible. Time reversal,
writes, deletes and rollback invalidate the appropriate result. A bounded raw
cursor is read to true EOF before admission, independently of the unchanged
output byte/node budget. A truncated response can reuse this complete raw
window; an incomplete SQL prefix cannot become a cache entry. Overflow falls
back to streaming the buffered prefix and remaining cursor in their original
order. Read-ahead errors are deferred to their original consumption boundary.
Limits remain 512 KiB per key, 4 MiB for cache-owned entries and unfinished
miss buffers, and 32 keys, including raw UTF-16 values and metadata. These are
not a total-process-memory guarantee for arbitrary externally parked iterators;
the EntryStore consumers run synchronously.

The browser distinguishes explicit authorization denial from unavailable
storage, network errors and other server failures. Temporary errors preserve
credentials, use one pending retry with backoff and honor `Retry-After`.
Stale responses cannot clear replacement credentials or restore old permission
flags. The rebuilt bundle has a new content URL and service-worker cache key.
Every new secret submission, including a locally rejected short input,
invalidates the preceding verification and asynchronous hash. A successful
attempt uses its own captured digest and remember setting.

Properties and notifications now retain their own complete SGV64 and MBG10
query results when a compatible root prefix is absent. Each exact SQL key
keeps its actual capacity, raw predicates and transaction-aware point updates;
it cannot narrow the root's 1,000-row response. Empty MBG results no longer
rescan all recent CGM readings on every poll. A partially consumed CAL10
cursor still remains uncached.

## First audit measurements (historical, before the deeper counterexamples)

All data is synthetic. HTTP authorization, uploads and background work are
included where noted; no user database or production resource was accessed.

| Workload | Before | After |
| --- | ---: | ---: |
| 5,000 device-status candidates: cold | 10,001 rows | 10,001 rows |
| Same candidates after legacy / API3 upload / unchanged repeat | 10,001 each | 0 data SQL rows each |
| 5,000 treatments with equal timestamps, latest one | 10,000 rows | 1 row |
| Matching treatment event category, latest one | 6,250 rows | 5 rows |
| Missing treatment event category | 5,001 rows | 3 rows |
| Same complete mixed HTTP workload, original stable 1.3.2 versus this patch | 2,345,216 rows | 18,155 rows |
| Mixed HTTP workload after the first device/REST fixes, before properties fixes | 1,615,825 rows | 18,155 rows |

The mixed fixture has 5,000 records in each history, twelve one-minute status
uploads, two treatment uploads and four readers making 192 real HTTP handler
requests over twelve simulated minutes. Each reader advances the clock by one
second; exact frozen-time keys cannot manufacture cache hits. Response contents,
current status and persisted counts are asserted. Its properties/cache phase
uses 186 row writes before and after. The new treatment indexes separately add
two index writes per treatment insertion, not per CGM entry or device status.

An isolated local archive of the original stable commit runs the same fixture
and passes the same response/freshness assertions. It reads 2,345,216 rows and
writes 182, versus 18,155 reads and 186 writes for the patch: 99.23% fewer reads.
The extra four writes are the two new indexes on each of the two treatment
uploads. The original read phases stay near 195,400 rows every minute, so this
reproduction is not just a cold-start spike. These twelve simulated minutes
are not a measured user's day or a promise about every load shape.

## Second audit measurements

The maintainer requested further investigation before any upgrade. The first
draft's 8 MiB cache and treatment UNION were challenged with oversized normal
prediction shapes, dense arrays, deep pagination, explicit sorts, cold wakes,
actual glucose history and continuous writes. These counterexamples are part
of the regression suite and retain original SQL/JavaScript result oracles.

| Reproduction | Before this additional fix | After |
| --- | ---: | ---: |
| Large prediction status, recent find, count 5 | 10,001 data reads | 13 data reads (20 including HTTP authorization) |
| The same filtered query after eviction | 10,001 data reads | 13 data reads |
| Dense array event category, latest one | 10,003 reads in first draft | 1 read |
| Scalar category, OFFSET 4,000 | 16,005 reads in first draft | 4,001 reads |
| Dense array category, OFFSET 4,000 | 22,003 reads in first draft | 4,001 reads |
| Explicit legacy date sorts | 10,000 reads | 1 read |
| API3 treatment identifier point query | 5,001 reads | 3 reads |
| Properties with 5,000 CGM history rows, unchanged warm poll | 862 reads in original 1.3.2 | 7 reads |
| Original twelve-minute mixed workload | 2,345,216 reads / 182 writes | 8,445 reads / 186 writes |

The corrected one-hour mixed fixture has 5,000 historical rows in each of
entries, treatments and device status, including four-by-48 prediction arrays;
four readers perform 1,200 real GET handler requests with moving clocks.
It also performs 60 status, 12 glucose and six treatment uploads. Uploaded
results, glucose values and timestamps, sensor selection and final persisted
collection counts are checked. Original 1.3.2 uses 11,939,172 reads / 1,159
writes. The final patch uses 36,096 reads / 1,171 writes in the same hour,
99.70% fewer reads. The extra twelve writes are the two treatment indexes on
six inserts. The final 24-hour replay makes 28,800 GETs, 1,440 status, 288
glucose and 144 treatment uploads, using 846,868 reads / 28,473 writes. Its
last hour uses 35,251 reads, matching the preceding hours. Before the final
raw-window completion fix, that same replay used 1,197,982 reads and rose to
386,365 reads in the last hour.

These are accelerated synthetic workloads in actual local workerd, not a
Cloudflare account bill. Fixture inserts, activation/index migration and
test-oracle SQL are excluded. Uploads exercise real DO methods but do not
include upload HTTP authorization. Periodic production alarms, reconnects,
unexpected evictions and unrelated objects in the same account are not
simulated. A full day of this fixture is not a guarantee for every daily load.

Direct SQL fixtures must clear activation's warmed empty caches; production
writes perform normal invalidation. This was confirmed with a layered raw-load
probe and corrected before final measurements. Real output-budget coverage
retains 860,219 status bytes and 341 treatments, reuses the complete raw window
on the second call, and recovers all 1,000 treatments after deleting that status.

The full-day replay exposed another shared defect in the first draft. Canonical
treatments gradually add nodes to the normalized response. Near the end of the
day, the existing 8,000-node output limit accepts 999 rather than 1,000 treatments.
The complete raw window still fits the 512 KiB cap (501,070 bytes), but stopping
the generator early previously prevented cache admission. Every properties
poll then repeated a 3,001-read SQL window. Cache size and LRU hypotheses were
disproved before changing the implementation. The fix keeps raw-window
completion independent of presentation truncation. The regression asserts the
same truncated output, a complete 1,000-row raw cache, and only six SQL window
loads in the last hour, matching the six treatment writes that invalidate it.
Cold window work remains 3,001 reads; response and cache limits are unchanged.

## One-minute SGV follow-up

The final source-review concern was reproduced in real workerd before changing
the entry cache. The fixture derives its body from an actual `putEntries`
upload, clears activation/fixture caches, and advances both clocks for each
root/ddata call. Only the precise SGV LIMIT 1000 key determines reuse.

| Canonical one-minute history | Previous repeated SGV query reads | New cold reads | New repeated reads | Complete cache size |
| --- | ---: | ---: | ---: | ---: |
| 727 entries | 2,908 each | 2,908 | 0 | 282,076 bytes |
| 1,000 entries | 2,915 each | 4,000 | 0 | 388,000 bytes |

Both previous shapes returned the same 726 SGVs under the existing 8,000-node
policy. The 727-row original cache representation fits at 453,648 bytes, but
the output cutoff prevented EOF/admission. At 1,000 rows, the full canonical
representation independently exceeds the 512 KiB cap at 624,000 bytes.

The fixed internal SGV/MBG/CAL consumers now cache only their thirteen used body
fields. SQL predicates, ordering, limits and point lookups still run against
the complete stored document. Public entry endpoints retain every field.
Missing values remain missing, and booleans/arrays/objects are not coerced.
Non-finite JSON numbers, negative zero, unsafe/deep/large selected values or
parse errors retain the original raw row. An independent full-body SQL loader
is the result/error oracle for root, ddata, properties and historical frames.
Frames remain uncached on their original cursor.

Within the same 512 KiB per-query serialized UTF-16 cap, the entry cache now
reads a complete bounded raw cursor to EOF before admission. Output limits
remain unchanged. Overflow streams the prefix and tail once; errors beyond
the consumer's original cutoff stay deferred. This trades an additional 1,085
cold reads in the 1,000-row fixture for eliminating repeated scans. It is not
a claim that cold reads always get cheaper.

Recent replay/correction writes also need to retain a full cache. A matching
changed row inside its original last-row boundary cannot expose a hidden
suffix, so it is replaced in place using the original time-DESC/ASCII-ID-ASC
order. Disappearance, classification/lower-bound removal or movement beyond
that boundary still invalidates. The update uses the same projected
representation as cold loads. Complete sorting oracles cover both sides of
time ties; a native SQLite diagnostic compares 800 changes and rollbacks with
2,400 fresh-query results, independently of Cloudflare billing measurements.

The one-minute 24-hour fixture makes 1,440 real new uploads, 144 replays
(72 corrections), and 4,320 internal root/ddata/properties reads. It uses
44,164 rows read / 38,946 written, loads the full SGV window once (4,003 reads
with an extra historical row behind LIMIT), and then performs 1,583 SGV point
queries. The last hour uses 1,592 reads, without a late cache cliff. Latest
values/times, all selected wire contents, the complete 1,000-row cache and
2,440 persisted entries are asserted. This is an entry-focused fixture with
internal readers, not the earlier mixed HTTP workload or an account bill;
it excludes fixture/oracle SQL and HTTP authorization and does not simulate
periodic production alarms, reconnects or unrelated account objects.

The same generic EOF fix also caches complete nonempty CAL10 results while
properties still displays only the original latest calibration. Real API3
creation, patch and deletion are checked against the full-body SQL oracle.
Cold/warm exact CAL10 query counts are one/zero.

## Large old stores and custom sorting follow-up

A separate real-workerd baseline covers 20,001 treatments and a second store
with 5,000 treatments plus 95,001 Food documents. Both correctly defer the
indivisible native index build. The first repeatedly reads 20,002 rows for an
absent category; the second reads 5,001. A latest-one query with 1,000 equal
raw timestamps reads 2,001 rows even without a category filter.

The old date index can solve the last case immediately: select the first
matching raw date key with the full original predicate, then reverse the
index within that exact key to find the original ascending-id winner. `IS`
preserves NULL and mixed raw keys. Both statements and the original query are
validated before execution; non-finite keys and expanded-query limits retain
the original path. The measured query uses two data reads, plus one progress
state read when a deferred side schema exists. This is limited to default
legacy order, count one and zero offset; identity lookups retain their path.

Large old stores now receive empty progressive index structures rather than a
full canonical-table `CREATE INDEX`. Three side indexes preserve raw date,
category and API3 time/server-modified/id order. Extracted keys have no SQLite
affinity. Triggers synchronize every canonical insert, update, id/collection
move and delete atomically, including writes behind the backfill cursor.
Malformed bodies retain their time/id key with guarded JSON extraction.

Backfill uses primary-key ranges of at most 64 source rows, at most once a
wall-clock minute and at most 5,000 source rows per UTC day. Cursor, daily
budget and completion share one synchronous transaction. Backwards clocks do
not reset allowance. Empty schema creation costs nine measured reads and eleven
writes; a 64-row batch costs 132 reads / 257 writes. A full 5,000-row day costs
20,079 side/index/checkpoint writes, separate from ordinary activity. Each new
treatment in a deferred store adds four side/index maintenance writes. Stores
with both native indexes receive no side tables or trigger write overhead.
These caps do not know the remaining account-wide platform quota.

Only public treatment/ddata/property readers drive optional progress. Private
snapshots, repository reads and canonical-write callbacks do not backfill.
An exact platform write-quota error rolls the optional batch back, cools it
down until UTC reset and permits the original read. Canonical write failures
still fail and roll back normally. Earlier local seal-32 histories lacking
both native and side indexes can initialize empty structures at a public read;
there is no package-version change. No partial side table serves a query,
and readiness is checked in SQL rather than cached across transactions.

After the complete 20,001-row backfill, the measured repository-only
absent-category legacy query reads one row including progress state. Private
auxiliary misses read three rows both before and after genuine uploads; a
repository category page with offset 17 reads 41. These exclude the public
progress driver's extra state checks, HTTP authorization and uploads.
The test advances a simulated clock through five eligible UTC day budgets;
it is not a continuous five-day runtime or an instant
fix for a history already exhausting quota. A bounded 17-key admission probe
also lets API3 use complete small category candidate sets without forcing a
dense common category into a large external sort. Existing raw-date indexes
continue to serve API3/custom date sorts whose tie direction already matches.

A separate 5,105-status fixture has a 15,591,254-byte original 5,000-row prefix,
which cannot fit in the existing 8 MiB budget. Queries now share bounded
prefixes of the complete top-level subtrees actually referenced by valid finds
and the last effective sort. The unchanged JavaScript helper selects rows;
canonical ids retrieve complete current bodies in the selected order. Cold
unsorted reads remain lazy, and cold selected bodies need no second lookup.
Raw/projected prefixes and active collection buffers share the same 8 MiB cap,
with at most 32 retained shapes. Transactions fork prefixes; unsafe boundary
changes, exact SQL ties, deletes and unknown suffixes invalidate conservatively.

| Repeated status query | Previous data reads | New warm data reads | New full HTTP reads |
| --- | ---: | ---: | ---: |
| created_at descending, count 5 | 10,001 | 10 | 17 |
| mixed battery values, count 7 | 10,001 | 14 | 21 |
| no matching result | 10,001 | 0 | 7 |

The same warm costs hold across the measured genuine uploads. Cold complete
sorts still read the original candidate window. If the referenced subtree
itself exceeds budget (for example the full OpenAPS root), the query continues
on its original uncached path. The original single-sort oracle also found an
actual correctness bug: the Worker sorted the query-aware RPC result again.
Mixed JavaScript values do not form a total comparator, so a second sort can
change order. The Worker now applies the helper only once; old-RPC fallback
still filters and sorts once.

Regression coverage includes 104 exact side-query comparisons, mixed raw
JSON keys/arrays, validity values 0/1/2/-1, custom and compound sorts, near-100
binding/100-kB fallback, canonical/side/schema rollback, real trigger failures,
write-quota cooldown, original full-body responses and shared cache limits.
Final validation passes without snapshot updates: the complete `npm test`
command includes 135 Vitest files / 1,145 tests, both existing full-day fixtures,
upstream compatibility and original report workflows. Final frozen-source
measurement capture separately passes all eight new files / 35 tests.
TypeScript, Worker dry-run, UI patch reversibility and 218 unchanged UI-asset
fingerprints pass. Evidence is in `large-store-sort-audit/final-evidence.json`;
the package remains local uncommitted 1.3.2 with no publication or deployment.

## Cold activation, large fields and extreme queries

The next audit reproduces sealed eviction, full OpenAPS parent queries, exact
time ties, dense arrays and near-limit SQL. Device candidate projections now
retain complete referenced dotted paths rather than an entire unrelated parent.
Arrays recurse with the same remaining path; missing parents, scalar blockers,
terminal objects and the original JavaScript comparator retain their semantics.
The selected response still comes from complete canonical bodies. Cached rows
are decoded only as consumed; a no-sort cold miss retains the current original
row and matched rows, rather than an association map of every missed body.
Full sorting still examines its complete required candidate window.

Private row caches can losslessly compress bounded UTF-16 bodies with a static
1,154-byte dictionary of common JSON key tokens. Lone surrogates, invalid JSON
text, property order and all original values roundtrip. Each compressed row
counts its exact buffer plus conservative metadata and an additional reference;
each containing entry counts 4 KiB of shared dictionary overhead. Bodies above
65,536 code units stay raw. No public or stored body is replaced. The candidate
cache additionally charges at least one byte per body code unit: its unchanged
8 MiB aggregate budget bounds a whole-prefix decode to at most 16 MiB of body
text. It still has 32 shapes and 5,000 candidates. There is no larger cache.

The ordinary treatment frame fixture previously occupied 543,816 budget bytes;
the same complete 1,000 rows occupy 507,778 after dictionary compression, inside
the original 512 KiB per-key cap. Actual workerd eviction tests show repeated
property context reads fall from 4,524 rows to zero, and HTTP properties from
2,908 to seven including its other work. Cold private-root reads increase from
12,073 to 13,509 because the status loader now completes its bounded raw window
before the output cutoff. The frame cold loader similarly reads 3,001 instead
of 2,901 once; subsequent reads reuse the complete window. Prefetch failures
are exposed only if the consumer reaches their original position, and failed
cursors/close operations do not leave a usable cache. Cold work and compression
CPU are costs, not free work or a general constant-cost guarantee. Ordinary
realtime status prefixes deliberately stay raw: a pressure run caught the CPU
regression from repeatedly decompressing small hot rows. Rising lower bounds
safely remove old suffixes, independently of output cutoffs; larger raw prefixes
retain a valid bounded prefix and stream the original tail when requested.

Optional v33 indexes cover status `(collection, sort_time DESC, updated_at
DESC)` and API3 treatment `(collection, sort_time DESC, srv_modified DESC, id
ASC)` order. Status deliberately omits an ID tie: its implicit rowid order
matches the measured former SQL prefix. A 5,000-row tied status query falls
from 10,000 data reads to five, plus one warm index-definition read through the
EntryStore; its next identical RPC costs zero. API3 default order retains all
nonzero validity values, NULL modification times, includeDeleted and malformed
body errors. Exact API3 treatment serialized responses share the existing
4 MiB/128-key/1 MiB-per-entry legacy result cache; mutations and rollback clear
both namespaces. This reduces repeated dense-array misses without a membership
index or additional persistent writes. The first miss remains expensive.

Index capabilities verify current key directions, BINARY collation, table and
exact collection predicate. Only a sqlite_master rowid address is remembered;
the current name and definition are read on every use, including after rollback
or address reuse. Repeated checks cost one row per index rather than scanning
the entire schema. A genuinely new locator can still scan the small schema.
Internal updated_at treatment windows keep their former time-index path; the
new API3 index's different secondary order otherwise regresses their cold plan.

Existing alarm turns may now perform the same optional bounded side-index batch
as a public read, after canonical work commits. No backfill alarm is created.
The existing 64 source rows/minute and 5,000/UTC-day budgets, atomic cursor/keys,
partial-state fallback and optional quota cooldown remain. Uploads/private
snapshots with no existing alarm and no public reads still cannot finish a
backfill by themselves.

The validity-bucket merge prototype is not enabled: it improves some cases but
regresses exact tuples and near-limit fallback. Complete array membership
indexes can eliminate missing-member reads, but the 5,000-row prototype costs
36,667 reads and 41,664 writes to build 13,888 distinct memberships. One legal
5,000-member array can add about 15,000 maintenance writes. Truncating members
would produce incorrect empty results, so this patch does not enable that
tradeoff. The original complete predicates and legal SQL fallback remain.

## Dense arrays and native custom order: first bounded version

The following describes the first bounded version. The next section supersedes
its membership source limit and mutation invalidation policy. It reuses the
existing treatment serialized-cache pool: 4 MiB,
128 keys, 1 MiB per entry, including keys charged as UTF-16. Exact responses,
complete membership views, ordered ID views and admission/rejection markers
compete within that same capacity. No table, index, migration, alarm or stored
row is added. The preceding optional native/side index write costs still apply.

A successful original SELECT with more than 512 actual rows read may record an
admission marker. The next query can build a view; an already cheap first query
keeps its original path. Both views require a complete bounded source. A
membership scan visits at most 5,001 canonical treatments. Native ordering first
probes the unfiltered source with the same 5,001-row ceiling; a limit on matching
output alone would not bound a rare/absent predicate over a much larger history.
Oversized or unsafe views retain a rejection marker until mutation or LRU
eviction. They never stand in for an authoritative empty result.

Membership uses SQLite's original eventType extraction, including duplicate JSON
path rules, and retains all first-level printable ASCII text members within its
limits. It does not treat the first 16/64 array elements as complete membership.
A complete absent category can answer changing dates/projections without another
data read. At most 64 matching IDs drive a non-flattened PK subquery, followed by
the entire original SQL predicate, SQLite order, LIMIT and OFFSET. Dense common
categories retain their preceding fast index path. Unsupported category strings,
more than 5,000 source rows, arrays over 1,024 elements or 128 distinct eligible
members per row, a fragment exceeding 64 KiB, bad JSON, unsafe IDs or the shared
byte cap fall back completely. SQL caps are checked before a cached empty answer;
an expanded statement that cannot fit falls back to the legal original SQL.

Custom order views apply only when the leading sort expression has a bound JSON
path and therefore requires a global native sort. The complete original filter
and order, including ID ties and SQLite mixed-value/BINARY behavior, determine
one vector of canonical IDs. Fields, page size and offset can reuse that vector;
changing a filter, including its time boundary, starts a different shape. A page
is sliced by ordinal, then a bounded json_each CROSS JOIN seeks its full canonical
bodies in native ordinal order. No JavaScript business-value comparator or
dynamic-filter chunk fallback is enabled. An indexed leading sort keeps its
existing lazy read/error boundary.

All treatment mutations clear the shared pool before/after their callbacks,
including rollback paths. Both builders guard cache generations, require real
EOF, and close unfinished iterators while preserving the original thrown value.
Quota/operational errors propagate. Full ordered vectors contain IDs, rather
than large sort values or clinical bodies.

Representative workerd measurements, including build costs:

| Scenario | Original/first data rows | Build | Subsequent data rows | Additional persistent writes |
| --- | ---: | ---: | ---: | ---: |
| Absent member in 4,900 dense-array treatments | 46,095 | 4,900 | 0 across changing dates | 0 |
| Sparse members beyond the 17th source array, complete SQL residual | full scan | shared complete membership | 10–15 | 0 |
| Fixed-filter custom sort, 5,000 sources, 7-row deep page | 8,764 | 13,779 for first shape/page | 21; empty page 0 | 0 |
| Second fixed-filter custom-sort shape, source proof retained | 8,763 | 8,778 | 21; empty page 0 | 0 |
| 12 real patches and 72 varying pages, including every cold probe/build | 631,174 total | included in total | 271,402 total | 0; business writes 193 in both runs |

These are local synthetic SQLite measurements, not account bills or HTTP auth
costs. Membership relearns after genuine uploads (observed 46,098/46,101 reads,
then 4,901/4,902 to rebuild); the subsequent sparse query costs 5/10 reads.
The first view build can cost more than one original request; only one or two
pages between mutations can cost more reads overall. Large/deferred sources,
rapid invalidations, continuously changing sort/filter shapes and
cache eviction can still be expensive. A prototype that removed time filters
and searched an ordered vector made dense misses worse (42,351 versus 37,959
reads; even a 64-ID probe followed by fallback cost 38,518), so it is not enabled.

Evidence and the two corrected test-fixture assumptions are preserved under
`output/diagnostics/read-budget-2026-10-18/dense-sort-audit/` in the collaboration
workspace. No upgrade, version bump, push, publication or deployment is included.

## Frequent mutations and larger treatment histories

Membership now stores a complete necessary superset by category: at most 64
canonical IDs per sparse category, or a conservative dense marker. It no longer
retains every historical ID and has no 5,000-row collection ceiling. The same
4 MiB / 128-key / 1 MiB pool still bounds retained strings. After the existing
cost admission, PK keyset scans consume at most 5,000 source rows plus one
lookahead per query. A partial cursor never answers an authoritative empty or
page. Each partial request still executes the original full SQL; total request
cost is not bounded by the 5,001-row cache-building step.

Before every canonical treatment write or permanent deletion, SQLite extracts
both old and new first-path eventType values from the already available bodies.
This is constant bound JSON, with zero source-row reads and zero writes in the
measured workloads. The membership lane only adds IDs/members. It never removes
old IDs/categories or demotes a dense marker. Old/deleted/rolled-back candidates
are safe extras because complete original SQL residuals still select the current
canonical body. The same superset remains valid before and after a failed write
or outer rollback. Partial scanning unions those overlays, including inserts or
changes behind the cursor, rather than overwriting them with a fresh snapshot.

Generation, mutation epoch and serialized-lane identity prevent a reentrant
write from being overwritten by an older cursor. If mutation history is lost to
LRU/clear/size refusal, a small sticky safety flag disables authoritative
membership rebuilding for that activation. A new Durable Object/cache can build
again. This conservative fallback prevents an uncommitted SQL snapshot from
forgetting categories later restored by rollback. Exact responses and native
order vectors still invalidate before/after mutation callbacks; they are never
restored from an uncommitted callback snapshot. This does not certify arbitrary
external private transactions that read exact/order caches after all known
callbacks, then independently roll back.

A whole-collection count proof can survive updates. It is an upper bound:
creates conservatively increment it before SQL (even failed creates), and deletes
never decrement it. Counts over 5,000 or malformed metadata cannot admit a global
order build. Scoped source proofs always invalidate on mutation. Legacy queries
with the already-proven canonical-ISO created_at lower bound can instead probe
and build over the same forced existing raw-date index. All arrays remain in that
necessary superset, including old raw arrays containing future date members.
The full original predicate/order then selects the complete native ID vector.
Thus a library larger than 5,000 can reuse order when its actual indexed source
fits, without assuming arbitrary API3 JSON date equals physical sort_time.

Optional source/index planning now happens after an in-memory candidate/view
miss. A known empty membership answer needs no verification of an index it will
not use. This removed the observed extra sqlite_master row from public hot
missing-category calls; query fields, sort, page and original SQL limits are
still validated first.

Representative local workerd measurements:

| Scenario | Measured result | Added persistent writes |
| --- | --- | ---: |
| 6,001 / 20,001 membership sources | bounded build steps total 6,002 / 20,005 source reads; complete warm miss 0, rare members 15 | 0 |
| Original miss / partial fallback for those libraries | 54,003 / 54,004 and 180,003 / 180,004 respectively; each partial request retains its full SQL cost | 0 |
| Public EntryStore, 6,001 sources, genuine creates and notes patches | missing category 0 after every write, selected category 4/8/12; no history rebuild | 0; ordinary uploads/patches retain business writes |
| 21,001 total, 1,024 indexed necessary candidates | first 2,071; build/page 3,111; warm 7-row page 21, empty page 0 | 0 |
| 12 patches, two pages per patch, replaying preceding full-clear policy | preceding 300,348 reads → current 245,348; both 192 writes | 0 |
| Same two-page workload, bare uncached SQL reference | 240,168 reads: current still costs 5,180 more, including one initial probe and page seeks | 0 |
| 12 patches, six varying pages per patch | preceding package 271,402 → current 216,402 reads; 193 writes unchanged; original SQL reference 631,174 | 0 |

The membership source fixtures grew after activation with native indexes
available. They do not replay deferred-index migration or certify a complete
old-library daily workload. Cold source steps, every partial fallback, eviction,
sticky refusal, growing stale candidate supersets and genuinely unindexed broad
queries can still be costly. Existing optional indexes and side-driver business
costs remain. No new table, index, migration, alarm or persistent state was added.

A two-expensive-page gate and native two-row binary insertion of changed IDs
were investigated separately. Production keeps the preceding one-page admission;
incremental order mutation is not enabled. These experimental results are not
included as deployed/runtime savings. Full body/order SQL oracles, public write
chains, failure/rollback/eviction tests and complete before/after costs are in
`output/diagnostics/read-budget-2026-10-18/mutation-large-view-audit/`.

## Cold prewarm, capacity admission and actual memory loss (2026-10-18)

The treatment serialized pool keeps its existing 128-key, 4 MiB total and 1 MiB
per-entry limits. Its monotone membership lane and global source-count upper
bound now have priority over optional exact results and order vectors. They
remain in the same charged Map. Admission plans any refusal before replacing
or evicting values; protected values can still be explicitly cleared, and an
oversized protected replacement can still fail. A failed create-count update
clears the pool rather than retaining an underestimated proof. No new table,
index, migration, alarm, persistent write or off-pool authoritative copy is added.

A successful expensive original query can also prove a complete native order
without another source probe/build: only offset zero and fewer output rows than
the effective positive limit qualify. Safe unique IDs, at most 5,000 outputs and
an unchanged pre-query generation are required. The full WHERE/native ORDER
and original SQL validation remain. A complete observed order is tried before
pending membership construction; a pending order never starts work at that
point. Full pages and offset pages cannot certify EOF. Mutation/failure still
clears exact responses and order vectors before/finally, while ordinary field
projections and later page sizes reuse the complete native ordinal.

When a bounded order build reaches real EOF but its complete IDs cannot fit,
those local IDs can answer the current canonical page without re-running the
same original SQL. Refusal prevents subsequent rebuilding until metadata is
lost. The temporary vector stays within the existing 5,000 source limit and
is not another retained cache. Oversized, malformed, partial or generation-
changed construction still uses the conservative path.

Membership prewarm stops as soon as the requested category becomes dense.
That prefix remains partial: it can neither prove missing categories nor
supply an authoritative page. Repeated dense reads do not scan the rest for
no benefit; another category can resume the canonical prefix later. If that
later query needs global completion, the remaining source cost is still paid.

Global membership that exceeds capacity can narrow to one explicit category.
The independent v3 representation names this scope. It keeps that category's
entire scanned prefix and mutation overlay, replays every member of the
current overflow row before advancing the cursor, and requires real EOF.
Only the named category can then return sparse IDs or empty; all other
categories use original SQL and cannot retarget the saved cursor. Focused
mutations continue unioning both old/new membership before canonical SQL;
rollback extras are removed by the original residual predicate. Global
mutation overflow, unsupported values and genuine lost mutation history still
refuse authority. LRU protection does not waive this safety rule.

Complete native workerd measurements (fixture/oracle setup excluded):

- Under key and byte churn, the same public 6,001-row fixture changes query
  reads from 180,150 to 12. Both policies pay 6,002 prewarm reads and 66 canonical
  business writes. The optional protection adds zero writes.
- Four fixed-filter custom-sort pages over 6,001 source rows change from
  29,033 to 6,023 reads for a seven-match bucket, including the same first
  6,008-read query. A missing bucket changes 29,009 to 6,002. With eventType
  filtering, corresponding totals are 47,085 to 18,028 and 47,017 to 18,007.
  These comparisons disable only observation for the preceding policy.
- At a deliberately small 4,096-byte entry cap, five full repository requests
  including two proof/build attempts and an explicit cache clear change
  80,000 to 60,042 reads. Each affected build request is 15,021 rather than
  25,000; it still pays 5,000 source-proof plus 10,000 native-order reads.
  Bare SQL alone remains cheaper for this intentionally uncacheable shape.
- A 4,900-row dense prewarm uses 66 source reads for the current request rather
  than an unconditional 4,900-row chunk. The complete current request is 67
  reads and its repeat is 2 with zero source reads. A later missing category
  still pays the remaining 4,835; all five requests total 19,604. This saves
  unhelpful immediate work, not every future complete scan.
- A 6,001-row global category table exceeds 1 MiB on row 1,178. The requested
  category at the end of that exact overflow row remains in a 282-byte scoped
  proof after 6,002 source-build reads. Four target requests total 13,084,
  warm target costs 6, and an uncovered Rare category still pays 17,704.
  At a 512-byte entry cap, another fixture pays 769 / 256 / 0 across original,
  scoped EOF build and warm missing reads; the complete proof is 148 bytes.
- True object eviction still pays 36,096 on the first missing API3 read and
  6,002 to finish this fixture's membership; warm missing is zero. A separate
  complete-order fixture relearns after eviction and a genuine rank/filter
  mutation without publishing stale IDs. Activation occurs before the spy,
  so these figures do not certify activation or every public HTTP overhead.

All these read-only optimizations add zero persistent writes. Full results,
native mixed-value ordering, remaining expensive fallbacks and actual clear /
eviction / rollback checks are preserved in the focused evidence.

Actual Durable Object eviction loses these in-memory values. A fresh activation
can safely learn again, but its first request still reads SQL. A plain clear
within a mutation-history lifetime is not proof of a fresh activation and
retains sticky fallback. Measurements and failure/fixture decisions are in
`output/diagnostics/read-budget-2026-10-18/cold-capacity-loss-audit/`.

Final local validation for this package passes: 153 Vitest files / 1,263 tests,
both complete-day fixtures, upstream client/server/audit and original report
workflows. The final full run initializes or updates no snapshots and uses no
`-u`. The focused run passes 11 files / 61 tests; the three new membership gold
snapshots were initialized over its first/final runs. Existing snapshot gold
was not rewritten in this package. The two old loss fixtures now first assert
that capacity churn retains membership, then explicitly clear it to keep their
original rollback/sticky-loss assertions meaningful. One new 128-row fixture
failed because its successful query did not exceed the original 512-read
admission gate; a 256-row fixture now proves that gate before testing the same
512-byte cap. This fixture decision and the initial failure remain archived.
TypeScript, Worker dry-run, diff/UI reverse checks and all 218 unchanged public
assets pass. Independent native SQLite checks add 405 full-row/topology oracles;
the separate membership prototype is a semantic/capacity experiment, not
workerd billing. The package remains local uncommitted 1.3.2 with no version
bump, commit, push, upgrade, public reply or production deployment.

## True sealed activation and post-eviction rebuild (2026-10-18)

This package adds zero persistent writes, tables, indexes, migrations or alarms.
It addresses the work done after a real Durable Object eviction, rather than
simulating a cold instance by clearing one cache. Existing cache capacities and
mutation/rollback invalidation remain unchanged.

The activation measurement installs a shared native `SqlStorage.exec` prototype
spy before eviction. A real HTTP request activates the object; the original
authorization method marks the constructor/public-body boundary. Native cursor
counters are harvested inside the owning object after each response, before any
oracle or eviction, into primitive numbers. The harvester executes zero SQL.
A sealed v34 fixture pays six constructor SQL calls / eight reads / zero writes.
It does not prewarm clinical windows or replay completed migrations. This is a
sealed existing store, not a new tenant's first schema/index installation.

A canonical fixture contains 1,000 SGVs, 14 genuine sparse MBGs older than those
SGVs, 12 CALs and 1,000 nonempty AAPS status records. A first ddata body still
costs 6,151 reads; constructor plus first HTTP is 6,159. Properties can now peek
at the complete original 1,000-row MBG/CAL query caches before falling back to
its original LIMIT 10 queries. Its next HTTP costs 25 instead of 1,098 reads:
MBG 1,033 and CAL 40 are both avoided. The four-response sequence including
constructor changes 7,272 to 6,199 reads, with zero writes. This reuse is only
large-to-small with identical predicates/order/window: small-to-large still
executes original SQL. Reverse request order, backward clocks and historical
frames preserve the original results and costs. No additional LIMIT 10 key is
admitted on a large-cache hit. A peek may inspect up to 1,000 cached timestamps
and clone up to ten rows; this is not a measured steady-warm CPU speedup.

Successful expensive native/default treatment reads can now observe complete
EOF in the same way as custom orders. They only reuse an already successful
first page with offset zero, output smaller than its positive effective limit,
at most 5,000 safe unique IDs, and unchanged generation. Native queries do not
start an optional custom-sort source proof or build. Full pages, skipped pages,
new filters/validity flags and mutations cannot borrow an incomplete proof.
A complete empty native order answers repeated page-size/field variants before
pending membership prewarm. This avoids a second whole-library scan just to
rediscover the same missing category. The first different category may still
pay the deferred membership scan; the existing 4,900-row regression now
explicitly counts its 4,900 source + 15 residual reads and keeps the original
51,078-read total-sequence ceiling. Learning thresholds are unchanged.

A separate optional native JSON1 predicate handles positive string `eventType`
equality in arrays of at most eight first-level elements. It compares both
native text type and value at each of eight fixed paths, preserving scalar
handling, duplicate JSON-key behavior, escaping, NULL and nested-value rules.
Longer arrays use the original `EXISTS json_each` branch. The original SQL is
compiled and validated first. More than 16 filters, strings over 512 characters,
or an optional statement exceeding 100 bindings / 100,000 UTF-8 bytes retain
the legal original query; complex/non-equality predicates are unchanged.
Original SQL remains the order-cache identity and sparse candidate residual.
No textual-token prefilter or JS value comparator was enabled.

With 6,001 five-element array records, the independent native data query changes
36,006 to 6,001 row reads, including nested or escaped missing strings. A real
post-eviction public RPC's first business query changes 36,096 in the preceding
baseline to 6,087, and its next three page variants use zero reads, zero member
rebuild reads and zero writes. The 6,087 includes current business/catalog work;
activation runs before that particular spy and is not included. The earlier
intermediate 6,091 measurement preceded the catalog fix below. Eight-element
last-member queries change 24 to three reads; nine-element and 64-element
fixtures retain their original 27 and 8,320 reads. First requests with new shapes
or complete views that cannot fit still pay their source/residual costs.

Cold index-definition lookup now uses `LIMIT 1` on the unique index name. It
still checks the live full definition and keeps rowid hints; it does not cache
a capability boolean. In a catalog with 60 trailing tables, the old name scan
uses 133 reads, the current cold helper 70 and its warm rowid helper one, all
zero writes. DROP/recreate, a same-column wrong partial predicate and outer DDL
rollback still cause live checks and correct fallback.

Read quota and CPU are distinct. Independent native SQLite experiments found
that eight-slot evaluation can take roughly 2.3–2.7 times the original CPU for
small missing-array bodies, while a separate 256 KiB body fixture improved.
These are native process CPU measurements, not workerd CPU or Cloudflare bills.
Long-array fallback has no general CPU improvement. Full-body results, native
ordering, malformed/lazy error timing, SQL limits and zero-write assertions are
checked in the new real-eviction tests; native spelling/value oracles add 18,511
short-array comparisons with no mismatches. No guarantee is made for arbitrary
queries or unlimited actual evictions within a finite daily read quota.

Evidence, actual counters, before-source copies, instrumentation failure
explanations and the reviewed exact-cost expectation changes are retained in
`output/diagnostics/read-budget-2026-10-18/real-cold-rebuild-audit/`.

Final local validation passes: 157 Vitest files / 1,281 tests, both existing
complete-day fixtures, upstream compatibility and the original report workflows.
The final run initializes or updates no snapshots and uses no `-u`. Focused
validation passes 16 files / 85 tests. One new raw comparison snapshot was
initialized earlier in this package; eight existing cost/diagnostic test files
received explicitly reviewed manual gold or phase/fixture adjustments. No
runtime learning threshold, capacity, result, write or overall read budget was
relaxed. TypeScript, Worker dry-run, diff/UI reverse checks and all 218 unchanged
public assets pass. The final archive contains 167 source/test/doc files. The
package remains local uncommitted 1.3.2, with no version bump, push, upgrade,
public reply or production deployment.


## Long arrays and SQL CPU follow-up (2026-10-18)

The short-array predicate now uses searched `CASE WHEN` conditions rather than
an eight-slot OR as a CASE result. This lets SQLite stop at the first successful
text match and avoid extracting non-text nested values. The ninth element's
native type proves the boundary: a missing path is SQL NULL; an existing JSON
null has type `null` and still belongs to the longer-array fallback. There is
no separate full-array length enumeration. The outer array type is already
known, so the fallback does not repeat that type check before `json_each`.

Only text bodies use the slot shortcut. Binary JSON stays on the original
native iterator. A deliberately damaged JSONB tail showed a valid early match
with the original iterator but an earlier error with whole-array extraction
on native SQLite 3.53. Wrapping the complete original scalar/array OR in a CASE
also changed laziness. The final type gate stays inside the array branch; the
scalar WHERE expression keeps its original position. Native versions differ:
the local workerd length probe did not reproduce the native 3.53 error, and
later traversal of the deliberately corrupt tail stalled. Both owning test
processes were stopped precisely. Permanent tests compare valid scalar, short,
long and nested JSONB against the original SQL; the corrupt-prefix proof is
isolated in a hard-timeout subprocess. No unsupported corrupt-tail outcome is
promised and no native-version error golden is imported into workerd.

The scalar bucket of the category UNION now retains its complete original
predicate. Its fixed native text constraint cannot visit an array, so binding
the eight-slot shortcut there was wasted work. The array bucket retains the
optimized full predicate. A temporary per-query WeakMap pairs each optional
predicate with its original, including the same necessary legacy date bound;
it retains no data or authority between requests. Common legacy queries use
17 bindings instead of 25. Original validation, full residual predicates,
side aliases, native order/ties, page/sort binding order and optional legal-SQL
fallback are unchanged. No query capacity or learning threshold is increased.

Independent exact-helper CPU comparisons use nine cases, seven randomized
blocks, identical full source/WHERE/order/results and ten bindings per variant.
With statements cached, short-two missing queries use 0.649 times the preceding
CPU; without statement caching they use 0.752. Short-eight first-member queries
use 0.607 / 0.935; long-64 missing uses 0.943 / 0.971, and long-1,025 missing
0.963 / 0.967. These are local native SQLite process CPU measurements for the
final equality helper, not whole HTTP CPU or Cloudflare billing. The scalar
UNION pruning is an additional query-planning change validated separately.
The actual helper passes 18,511 original spelling/query comparisons plus
1,425 JSON5/text/BLOB/JSONB boundary comparisons; independent alternative
candidates and their failures remain archived.

A separate local workerd diagnostic compares the complete original query,
its production-selected plan captured through a non-optimized 513-character
query, the current production query, and an experimental numbered-binding
fold. Its default mode checks all 23 cases across four variants: complete
results, columns, fixed read counts and zero measured writes. It performs no
warmup or timing. The cases cover compact, large-body, nested, escaped,
prefix/suffix/missing and scalar values.

Timing requires the explicit standalone flag
`TREATMENT_ARRAY_CPU_BENCHMARK=1`. That one-file run keeps four warmups per
variant, batches of 16–256 calls, a 10 ms target and three randomized blocks.
`workerd-cpu-standalone-final.log` and `standalone-cpu-measurements.json` record
23 cases, 17 current bindings, no zero-resolution samples and zero measured
writes. There is no latency golden or threshold. The first standalone run
also passed, but its default reporter omitted console measurements; its log
is retained separately. The preceding timing-focused run is preserved as
`focused-benchmark-before-isolation.log`; final `focused-final.log` uses the
default functional mode.

Production clocks advance with I/O, so these local synchronous wall times
cannot be presented as deployment CPU. See the
[Workers performance documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/).
Binding, VM, cursor and scheduling work are all included; there is no claim
that every warm call recompiles SQL. The same-plan ratio compares with the
original query without the short-array optimization, not with the preceding
short-array helper. The native helper's improvement does not establish an
improvement for every workerd or HTTP request.

The preceding default-concurrency full run passed 1,283 tests and failed one
mixed complete-day fixture at its unchanged 180-second timeout. That failure
and the CPU-isolation decision remain in `full-npm-test-contention.log` and
`FULL_TIMEOUT_CPU_DECISION.zh-CN.txt`. Final full validation explicitly uses
`npm test -- --maxWorkers=2` to control local contention. It keeps all 159
files / 1,284 tests, the upstream/report workflows, the original timeout and
all clinical/read/write budgets. No permanent worker-count setting changes.
The original 167-file before archive is preserved; the separately saved
original `vitest.config.ts` makes the baseline 168 files. Two new tests make
the final archive 170 files, with eight files changed in this package.

Several broader shortcuts were rejected:

- Bare-token negative screening is conservative only with the necessary text/
  escape guards. Scanning an unrelated large body can be slower: one 64-member
  64 KiB fixture uses 3.192 times the original CPU. Even body-size caps have
  smaller-array regressions. A dense-64 / 2 KiB guard improves some missing
  queries but makes a first-member match 1.275 times the current CPU and adds
  a binding, potentially losing the existing near-100-binding optimization.
- Unrestricted flat quoted-token acceptance is incorrect: searching for the
  quoted comma in `["x","y"]` can match a closing quote, separator and opening
  quote. A restricted ASCII-alphanumeric-first variant has a narrower proof,
  but its three-binding fallback loses the preceding nested-short-array read
  reduction. Fragment factoring also has large nested-body CPU regressions
  and the binary-tail laziness problem. None was enabled.
- Numbered parameter reuse works in a zero-read/zero-write probe, but the
  diagnostic excludes the JavaScript rewrite cost and shows mixed timings.
  A generic statement rewrite was not added to production.

The original scalar/array comparison, SQL limits, full results, writes and
existing short-array read savings remain. Longer arrays still pay their
original native iterator reads, and SQL CPU can remain above the unoptimized
query in some small-body cases. This package adds zero persistent writes,
indexes, tables, migrations, alarms or retained cache capacity. It remains
local uncommitted 1.3.2, with no upgrade, push, publication or deployment.
Evidence and failure/fixture decisions are in
`output/diagnostics/read-budget-2026-10-18/array-cpu-audit/`.

Final validation uses `npm test -- --maxWorkers=2`: 159 Vitest files / 1,284
tests pass, including both unchanged complete-day fixtures and the upstream/
original report workflows. Default focused validation passes 18 files / 88
tests. Its 23-case / four-variant SQL diagnostic checks complete results and
read/write contracts with no warmup or timing. Timing is opt-in only:
`TREATMENT_ARRAY_CPU_BENCHMARK=1` passes a separate one-file / one-test run;
`workerd-cpu-standalone-final.log` and `standalone-cpu-measurements.json` prove
23 cases, four warmups per variant, batches of 16–256 calls, three randomized
blocks, 17 current bindings, no zero-resolution samples and zero measured
writes. There are no latency thresholds. The preceding default-concurrency
full run failed with 1,283 passes and one unchanged 180-second mixed-load
timeout; `full-npm-test-contention.log` and `FULL_TIMEOUT_CPU_DECISION.zh-CN.txt`
preserve that failure. The original timeout and clinical/read/write budgets
were not raised. Final full/focused runs use no `-u` and initialize or update
no snapshots. Reviewed diagnostic changes are six SQL strings, twenty plan
addresses and two optimization-detection regexes. TypeScript, Worker dry-run,
diff/UI reverse checks and 218 unchanged public assets pass. The preceding
167-file archive remains intact; the separately fingerprinted original
`vitest.config.ts` makes a 168-file baseline. Two new tests make the final
170-file archive, with eight files in this package's patch.

## Long-array row reads and bounded membership learning

The long-array SQL prototypes were measured and rejected. No recursive CTE,
expanded 16/32-slot predicate, target-binding shortcut or new SQL index was
enabled. `document-repository.ts` remains byte-for-byte unchanged from the
preceding array-CPU package. The runtime change is confined to the existing
membership view's admission and bounded construction work.

A temporary workerd admission test compared the complete original typed
`scalar OR json_each` query with recursive 8/16-slot chunks and bounded
16/32-slot target predicates. All variants used the same raw native-order
source, full results, limit and offset. Its 15 TEXT fixtures produced 30
samples with zero measured query writes. At limit 1 / offset 0, the measured
charged reads were:

| Missing-member fixture | Original | Recursive 8 | Recursive 16 | Bounded 16 |
| --- | ---: | ---: | ---: | ---: |
| 2 rows, 9 members | 20 | 12 | 8 | 2 |
| 2 rows, 64 members | 130 | 36 | 20 | 130 |
| 2 rows, 1,025 members | 2,052 | 520 | 264 | 2,052 |
| 16 rows, 64 members | 1,040 | 288 | 160 | 1,040 |

A 1,025-member suffix match measured 1,025 / 259 / 131 reads for original /
recursive 8 / recursive 16. These are actual workerd row charges, not inferred
from native SQLite timings. The separate production-query capture was only a
reference; it did not share the prototypes' source plan. The temporary test
passed and was archived as `workerd-row-admission.test.ts` outside the default
test directory, with its source fingerprint. It is not a permanent production
regression or part of the final permanent-test count.

Fewer charged rows did not justify the CPU cost. Independent native SQLite
process-CPU measurements, relative to the preceding short-eight helper, put
recursive-eight 1,025-member misses at 23.03 times with statement caching and
36.41 times without it. Bounded-sixteen short-two misses used 1.42 / 1.66 times;
a 64 KiB unrelated-body sixteen-member miss used 2.34 / 2.28 times. These are
local native CPU measurements, not workerd CPU, whole HTTP CPU or Cloudflare
bills. Ten native candidates each passed 2,076 original spelling/query
comparisons and 900 additional representation comparisons, including valid
JSONB. That semantic experiment does not certify an enabled runtime path.
No corrupt JSONB tail was probed again. The JSON-null counterexample remains:
`json_extract(next) IS NULL` cannot prove array EOF when a later member can
follow a JSON null.

The enabled change removes only the membership parser's separate 1,024-item
rejection. SQLite still extracts the original first `eventType` field before
JavaScript examines complete first-level members, preserving duplicate-key
behavior. Repeated and non-text elements consume no additional retained
membership space. The original SQL-fragment 64 KiB and UTF-16-fragment 64 KiB
limits, 128 distinct eligible members per row, 64 candidate IDs per category,
1 MiB entry and shared 4 MiB / 128-key limits remain. Unsupported or overflowing
values retain the complete original SQL fallback; no array is truncated into
a plausible empty result. An independent native single-row audit covers 15
fixtures and 117 original JSON1 text comparisons, with nine newly admitted
fixtures. It is not a full HTTP or billed-read baseline.

Only newly admitted arrays longer than 1,024 elements contribute to a build's
32,768-element soft work budget. The builder stops before requesting another
row, closes the iterator and saves the processed canonical prefix as partial.
True cursor EOF is still required for completion. The existing UTF-16 fragment
limit allows at most 16,383 compact primitive elements in one row, so this
new long-array JavaScript walk can overshoot to at most 49,150 elements. This
does not cap all JSON parsing, an entire HTTP request or old short-array work:
arrays of at most 1,024 elements retain the existing 5,000-source-row batch.
A mutation examines at most its old and new bodies, each under the same
fragment limits; a large business batch can still accumulate CPU across many
mutations. Monotone supersets, generation, rollback, iterator closing, focused
views, protected shared capacity and sticky refusal keep their existing rules.

The real 77-row repository fixture first spends 77,977 reads. Two partial
learning requests each spend 78,010 reads, including the original fallback;
the final completion request spends 13. Total learning cost is 234,010 reads,
not merely the 79 source-build reads. Native cursor lookahead accounts for
33 / 33 / 13 charged source reads over 77 canonical rows. The completed view
uses 574 bytes, and a different new missing category then needs zero reads.
All read phases write zero rows. A sparse `Rare` query still spends 2,060 reads
in the original residual; dense candidates, partial learning, new shapes,
overflow, eviction and lost-history refusal remain costly. Mutation metadata
adds zero reads or writes; the fixture's business update keeps its 15 existing
writes. Rollback extras are filtered by the original SQL, and lost history
falls back at 2,051 reads. The focused five-file / 27-test run has passed;
complete final validation is recorded only after it finishes.

This package adds zero persistent writes, tables, indexes, migrations, alarms
or retained cache capacity. It remains local uncommitted 1.3.2, without an
upgrade, commit, push, publication or deployment. Evidence is in
`output/diagnostics/read-budget-2026-10-18/long-array-read-audit/`.

<!-- long-array-read-audit-final-validation -->

Final validation: `npm test -- --maxWorkers=2` passes 160 files / 1,287 tests, including both unchanged complete-day fixtures and the upstream/original report workflows. The focused run passes 5 files / 27 tests. No snapshots were initialized or updated; the existing 180-second mixed-load timeout and clinical/read/write budgets remain unchanged. TypeScript, Worker dry-run, diff and UI patch reverse checks pass, and all 218 public assets are unchanged. The preceding 170-file baseline is preserved; the final archive contains 171 source files with three files in this package's patch. The archived temporary SQL experiment is excluded from the permanent suite. Worker: 2136821 bytes, SHA-256 `afefe1b8ee831f1ed92268fbb4f866f474f56d6583b9d95407c2dc9583119f01`. Full evidence is in `final-evidence.json`.


## Activation and remaining boundaries

Migration 31 assesses its two optional treatment indexes; migration 33 assesses
the two additional cold-order indexes. Activation seal 34 proves those
assessments completed, not that all indexes exist. Native builds are indivisible.
The v33 assessment allows at most 20,000 newly indexed keys across both new
indexes, prefers treatment order when only one fits, and defers new builds above
100,000 canonical documents. Existing indexes continue working as history grows.
These limits are independent of v31 and cannot know the tenant's remaining daily
quota. A successful build adds one persistent index write per matching status
or treatment row; backfill and normal business activity have their own costs.

Sealed v28, v30 and prior local v32 activation retains canonical data, revisions,
clocks, sessions and the stored realtime baseline. Failed native DDL/marker work
rolls back together. A failed final seal retries without rebuilding committed
indexes. Unknown same-name index definitions are preserved and use the original
read path.

Eviction, overflowing or incompressible bodies, new query shapes, deep offsets,
arbitrary unindexed predicates and unfinished deferred indexes still execute
SQL. Dense array misses can reuse a complete byte-bounded membership superset;
partial construction, unsupported/overflowing values and sticky refusal keep
their original SQL costs. Large values in required entry fields can still exceed the entry
cache cap; frames and necessary boundary invalidations keep their original
behavior. Simple Activity loaders and roles retain their original broad-read contract.
Profile/current requires a complete native-and-JavaScript validity proof.
Read-only activations retain the existing bounded proof; active uploads use
the synchronous per-request proof described in the latest audit above.
Cold partial scans, unsupported bodies and refused capacity retain the old path. No list was silently truncated.
Candidate API-secret verification now verifies the candidate independently of
the existing Bearer JWT, as described in the authorization audit above.

The earlier mixed day uses five-minute glucose uploads; the separate one-minute
fixture does not certify every mixed environment. Optional read optimization
adds some persistent writes and cold compression CPU. No rate limit, stale
clinical response, lost upload or silent result truncation was introduced.
Explicit API3 JSON-field optimizations retain the preceding canonical-JSON
assumption; default API3 time reads preserve malformed rows and parse errors.
These measured fixes do not identify the reporting user's unique root cause or
promise that arbitrary workloads can never exhaust a finite quota.

Evidence and before-source copies are in
`output/diagnostics/read-budget-2026-10-18/cold-extreme-audit/`; prior audit
packages remain preserved. The package is local uncommitted 1.3.2. No version
bump, commit, push, public reply, user upgrade or production deployment occurred.

Final cold-audit validation passes without snapshot updates: `npm test` includes
143 Vitest files / 1,206 tests, both complete-day fixtures, the CPU short audit,
upstream/client/server contracts and the original report workflows. TypeScript,
Worker dry-run, UI patch reversibility and all 218 unchanged UI asset hashes pass.
The mixed fixture records 813,677 reads / 30,057 writes over 28,800 requests;
this is 33,191 fewer reads and 1,584 additional writes than the preceding local
patch, not a user bill. Its test hang guard is now 180 seconds, matching the
existing one-minute endurance test; two earlier 120-second failures and the
CPU evidence/decision remain archived. No SQL/data budget was relaxed. Details,
frozen code and hashes are in `cold-extreme-audit/final-evidence.json`.
