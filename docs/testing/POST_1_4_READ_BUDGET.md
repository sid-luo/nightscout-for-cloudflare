# Post-1.4.0 device-status and diagnostic hardening

This local follow-up starts from stable `4547581` (1.4.0). It addresses two
reproduced amplification paths: repeated API3 device-status queries, and the
internal device-status reads used by enabled plugin alerts. No release,
deployment, data retention change or client heartbeat change is part of this
package. Local code adds optional, lazily initialized SQL checkpoints for
bounded device-status query inputs; final cold-recovery validation is recorded
below.

Cloudflare's SQLite Durable Objects Free allowance currently separates
5,000,000 row reads per day from 100,000 row writes per day. They are not a
combined allowance or an HTTP-request counter. Native cursor measurements in
this document include application SQL and its index work; they exclude fixture
setup and the separately billed KV/alarm APIs. See the
[official pricing and accounting rules](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## API3 native query reuse

API3 device-status searches retain their original native SQL predicates,
ordering, pagination, validity and public materialization. The cache holds raw
selected rows; it does not substitute the legacy interface's 5,000-candidate
prefix for API3 history, and it does not implement JSON/array filtering in
JavaScript.

Each object retains at most 16 plans, 4 MiB in total, 1 MiB and 128 selected
rows per plan. Query text, bindings, narrowing metadata and native identifiers
are included in admission accounting. Empty results can also satisfy a proven
forward narrowing of the same date/created_at lower bound. Other changes to
the predicate retain exact-plan or native-SQL behavior.

A moving lower bound that has become nonempty can also reuse a prefix after
one bounded native query over its selected primary keys. Reuse requires that
all selected rows survive, or that the old page already proved EOF. Losing a
row from a full prefix requires the original query to discover its unseen
suffix. OFFSET retains the original fallback. Clock-only narrowing does not
enroll and persist a different plan on every poll.

Mutations clear query authority before canonical DML. A successful wrapped
create or suitable update checks the changed primary key using the original
SQL predicate, then reranks only the prior selected identifiers plus that key.
The forced primary-key source and `LIMIT -1` barrier prevent SQLite from
turning maintenance into a whole-history scan. Each mutation has a shared
256-source-row maintenance budget. Selected updates on a full prefix, OFFSET
changes, deletes and unsupported mutation paths fall back to the original
query rather than inventing an unseen suffix. Transaction forks restore the
committed cache on rollback, including when a callback read uncommitted data.

An optional native maintenance limit discards cached authority; it does not
reject an otherwise valid upload. Quota errors still propagate. Canonical
write failures are never swallowed by this optional SELECT boundary.

The earlier memory-only candidate established the native data-query behavior
below with 12,000 synthetic statuses. These exclude the durable checkpoint
metadata introduced afterwards; zero here is not a final total-SQL claim:

| Query | Cold reads | Repeated reads |
| --- | ---: | ---: |
| Missing device, limit 1 | 12,001 | 0 |
| Arbitrary JSON rank sort | 24,000 | 0 |
| Missing device and forward date lower bound | 12,001 | 0 |

The same three queries remained at zero data-query reads across ten subsequent
uploads (30 polls). Maintaining one warmed sort plan changed a matched upload
from 11 reads / 16 writes to 21 reads / 16 writes. This is a local comparison
before persistence, not the final read/write total or a production-account bill.
Final durable costs are recorded below.

The first genuinely cold arbitrary query can still scan history. Unsupported
or oversized results, exhausted memory admission, selected-prefix invalidation
and nonempty changing predicates retain their original correct SQL path.

Memory reuse alone is insufficient across Cloudflare object hibernation.
Eligible objects can lose memory after ten idle seconds, so a 15-second alarm
or a slower client can construct the object again on every event. Cold-recovery
tests therefore evict the actual object before each event and include its
constructor SQL. See [Cloudflare's lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## Alert input reuse

Device-status alert production requires the corresponding plugin and alert
flag, such as `ENABLE=upbat` plus `UPBAT_ENABLE_ALERTS=true`. Enabling a plugin
alone does not establish that this path is active.

The cache retains the original filtered, ordered, raw latest-1,000 SQL prefix.
It uses bounded lossless row compression; a SQL LIMIT is never treated as EOF
for the entire history. Normalization, response byte/node budgets, current
settings and alert decisions run again on every evaluation. The final alert
result is not cached. Mutation forks, predicate changes, backwards clocks,
future activation, ambiguous ordering and refused capacity retain conservative
invalidation or SQL fallback.

The original earliest-future selection has a separate bounded exact proof:
it may be reused only until its matching timestamp enters, time moves
backwards, the predicate changes, or a device-status mutation invalidates it.
An absent result is a complete absence proof for forward time only. Large
future rows that cannot be retained use the original SQL query.

These are input-loading changes. They do not change the configured 15/60-second
alert cadence, suppress alert producers or delay upload confirmation. Pure
Engine.IO heartbeats still use their existing attachment/deadline path;
durable POST leases and outbound queues remain authoritative.

## Cold-safe raw checkpoints

The participating readers lazily initialize one private singleton SQL row and
three device-status mutation triggers. This does not scan or backfill clinical
history. API3 and alert inputs have independent valid bits and payloads, each
limited to 512 KiB including its compressed JSON envelope. Decompression is
limited to 16 MiB, checks the zlib checksum and exact length, and validates the
component's version, raw rows and query proof before admitting it. API3
recompiles query parameters with the current native SQL compiler; stored SQL
is never executed as authority.

An actual workerd codec probe found a valid 116,848-byte stream failed with
both an exact output cap and one extra byte. A cap rounded to the next 16 KiB
buffer boundary plus one byte succeeded. The decoder permits that small
bounded allocation headroom and still requires exactly the declared length;
accepted data never exceeds 16 MiB. A regression checks this boundary and
rejects a valid stream whose declared length is wrong. This local result is
distinct from the related historical
[workerd exact-output-limit issue](https://github.com/cloudflare/workerd/issues/6286).

Every device-status INSERT, UPDATE or DELETE advances a source generation and
invalidates both components inside the canonical transaction. This remains
observable on a second write while the valid bits are already zero. Rollback
restores the source and checkpoint together; the EntryStore wrapper also
restores its in-memory cache/controller forks. A cold upload hydrates before
mutation, so maintaining a proof does not require another history scan after
each upload. Successful source writes stay successful if an optional cache
save fails. Failure of the canonical invalidation trigger remains a canonical
transaction failure rather than permission to serve stale data.

Restoration verifies the exact table/trigger definitions using four stored
`sqlite_master` row identities, plus the singleton generation. Missing or
changed definitions require atomic repair and invalidation. Cloudflare rejects
`PRAGMA schema_version`, so the implementation uses supported metadata queries;
their reads are included in cost tests. Application schema initialization
resets the controllers. Arbitrary privileged SQL that deliberately drops and
recreates identical triggers at identical schema identities around unobserved
source writes is outside this authority model.

Unchanged heartbeats and query hits do not rewrite the checkpoint. Each
component permits at most eight saves per UTC minute; this budget persists
across eviction and source invalidation. Time advancement alone does not dirty
an alert proof. New queries, changed source inputs and material future
boundaries can save new proofs within the budget. Refused capacity, budget
exhaustion, corruption or unsupported proofs retain the original SQL fallback.
The trigger adds a write per changed device-status row after initialization;
saving active components adds further bounded writes. This is a measured
read/write tradeoff, not a zero-write optimization or a Free-plan guarantee.

## Optional SQL cost attribution

Only the exact setting `READ_DIAGNOSTICS=1` enables the additional collection.
It adds no SQL queries, RPC round trips or persistent counters. Other setting
values run the original callbacks directly.

`nscf_storage_scope` identifies activation, RPC, alarm, WebSocket, background
and notification SQL work. Synchronous callbacks stay synchronous. Each SQL
cursor belongs to the innermost active storage scope; parent scopes exclude
children. Existing `nscf_read_request` measurements remain inclusive RPC-body
measurements. Write/realtime RPC measurements include background work awaited
inside that RPC, while activation and detached work remain excluded; their
scope label states this explicitly. **Do not add these two views together.**

Explicit mutation/realtime RPC allowlists use a single diagnostic dispatch.
Only an exact missing-method error can fall back to an older object's original
method; a normal error after a write is never retried. Capture, SQL shapes and
nesting depth are bounded; overflows and SQL errors mark the affected scope
incomplete. Late work is outside the completed callback's scope.

Logs contain finite labels, random identifiers, hashed query/SQL shapes and
counts. They exclude bindings, SQL literals, credentials, tenant names, raw
URLs, clinical bodies and original error messages. Logging failure preserves
the original result or error. `wallMs` is elapsed callback time, including
awaited child work; it is not CPU time or an exclusive timing measurement.

The counters describe native `SqlStorage.exec` work. KV/alarm APIs and platform
internals remain explicit exclusions; they are not reported as zero-cost
storage. Source-default head sampling remains 5%, and no production log
configuration is changed. Records state that the application emits all enabled
events but the platform may sample them. Use platform metrics to reconcile
account totals, rather than treating a sampled log sum or `complete=true` as a
complete account bill.

## Validation scope

Focused regressions compare cached output with the native uncached repository
or original alert loader, including arrays, missing/mixed values, projection,
soft deletion, ties, mutations, failed transactions, true object eviction and
capacity refusal. Separate native counters verify diagnostic attribution and
unchanged write counts. Combined HTTP/authentication, uploads, polling, alert
and cold-recovery coverage supplements the existing isolated suites.

Local synthetic measurements demonstrate these particular fixes. They do not
guarantee arbitrary clients and workloads will fit a Free account, or identify
the cause of a previously reported user's outage.

The final focused runs include the following native SQL totals. Setup of the
clinical fixture and independent inspection/oracles is excluded; activation,
canonical uploads and checkpoint SQL inside the measured workload are included.

| Workload | Before durable fix | Final reads / writes |
| --- | ---: | ---: |
| 4 min, simple status, 15 s alerts, 16 actual evictions, 4 uploads | 32,577 / 122 | 3,374 / 137 |
| Same cold lifecycle, AAPS-sized prediction bodies | Not separately measured | 1,454 / 137 |
| 1 h, AAPS-sized bodies, 15 s evaluation and 1 min uploads | 25,616 / 1,263 | 6,984 / 1,388 |
| 1 h, AAPS-sized bodies, 60 s evaluation and 1 min uploads | 11,036 / 1,263 | 5,364 / 1,388 |
| 12,000 statuses, 3 learned API3 queries per wake, 16 actual evictions | Repeated cold native scans | 448 / 0 |

Each four-minute alert case evaluated 16 times and matched the original native
clinical/alert oracle. It saved five checkpoints; unchanged ticks performed
zero checkpoint writes and zero DDL. The hour comparison's additional 125 writes
include initialization, per-source invalidation and refreshed snapshots.
Physical database size naturally includes the derived table; clinical inputs
and decisions are compared separately from that expected storage-size change.

The three API3 plans initially cost 12,537 / 24,019 / 12,020 total reads
(native source work 12,001 / 24,000 / 12,001). Afterwards each cold three-query
round costs 27–31 reads, including authority checks and bounded native PK
narrowing, and no writes. Four cold uploads cost 298 reads / 69 writes total;
an equivalent-store comparison isolates two additional checkpoint writes for
an ordinary upload with API3 plans active. Enrollment and source updates have
different costs from unchanged polling.

An unchanged pre-existing 24-hour mixed CGM test passed once in isolation in
141.848 seconds under its original 180-second guard, with 28,800 requests,
813,677 reads and 30,057 writes. Earlier release-time failures remain recorded;
this isolated pass does not explain their cause.

The frozen final source then passed the full Workers suite once with
`--maxWorkers=1`: **182 files / 1,384 tests**, 313.19 seconds, no `-u` and no
changes to pre-existing assertions, snapshots or the 180-second endurance
guard. The original endurance case took 87.204 seconds and retained the same
813,677 reads / 30,057 writes. Source/test/config hashes before and after the
full run match exactly.

In that full run, the eight-minute combination with 32 actual evictions,
authenticated HTTP uploads/API3 queries, 32 native alert oracles, two polling
clients and lease completion cost **55,308 reads / 362 writes**. Initial query
enrollment accounted for the large first scans; the remaining restored ticks
cost 92–297 reads each. The separate two-eviction combination retained 26
genuinely due ping/pong cycles and cost **55,293 reads / 355 writes**. The forced
every-tick-cold fixture uses bounded noop polls and accepted control POSTs;
these prove lease completion, not delivery of an overdue server heartbeat.
