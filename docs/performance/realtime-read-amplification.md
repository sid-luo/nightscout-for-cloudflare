# Realtime read amplification repair

A device-status upload previously rebuilt the root realtime snapshot by querying
all recent glucose and device-status rows again. The repair keeps the existing
snapshot transformations, output budgets, delta calculation and delivery queues.
It reuses raw query results inside the tenant's Durable Object:

- Unchanged SGV, calibration and meter queries reuse complete, bounded results.
  Entries mutations invalidate those results. Advancing windows filter expired
  rows; historical frames and backwards-moving windows query SQLite again.
- API3 device-status creates/upserts merge the canonical changed row into a
  transaction-local cache fork. Only a successful repository transaction retains
  the fork. Exceptions restore the committed cache; other mutation paths clear it.
- A raw device-status prefix stopped by the existing output budget is reusable.
  If a later request needs more rows, the loader resumes from SQLite rather than
  treating that prefix as complete. Ambiguous sort ties trigger a fresh query.
- Caches are tenant-local, bounded in memory, and disposable on eviction. There
  are no new persistent tables, indexes, delayed acknowledgements or skipped
  history records. Snapshot normalization, necessary events and delivery rules
  are unchanged.
- Exact Cloudflare read-quota failures propagate through API3 and return HTTP 503
  with a daily-reset Retry-After instead of an unexplained HTTP 500. This does not
  increase the platform quota or guarantee a client obeys Retry-After.

## Local measurements

Measured with the Cloudflare local Workers runtime and SQLite cursor counters.
All fixtures are synthetic. Numbers are not production billing measurements.

| Scenario | Before: rows read | After: rows read | After: rows written |
| --- | ---: | ---: | ---: |
| One status upload, no browser | 14 | 14 | 14 |
| Initial browser subscription, 10,000 stored statuses and 288 entries | 2,165 | 2,165 | 37 |
| One status upload with the subscribed browser | 2,060 | 41 | 15 |
| 10,000 consecutive historical status uploads, subscribed browser | Not measured | 410,098 | 150,001 |

The measured warm upload uses about 2% of its former reads (98% fewer). This is
not a claim about the whole account's daily use. The complete backfill starts
with 288 glucose records, uses nested AAPS-shaped synthetic status records,
checks every upload, verifies all 10,000 distinct records remain stored, and
compares the resulting snapshot with fresh SQL. Its synthetic clock is fixed to
measure a continuous burst independently of machine speed; actual connection
heartbeat/reconnection behavior is covered separately by the realtime suites.
Seeding and initial browser authorization are outside the backfill counter.

The full backfill also exceeds the current free daily **write** allowance of
100,000 rows, despite staying below the 5,000,000-row read allowance. The local
runtime does not enforce account daily limits. It therefore cannot prove that
10,000 new records can all be uploaded to a free production account in one day.
Daily use, other clients, repeated cold starts, larger datasets and enabled
background plugins still need production measurement.

## Validation

Tests cover advancing/backwards windows, explicit frames, empty-cache inserts,
history, replacements, type changes, permanent deletion, failed transactions,
object eviction, incomplete prefixes, ambiguous ties and memory limits. Cached
snapshots are compared directly against fresh SQL results. Existing realtime,
API3, plugin and HTTP contracts remain part of the complete regression suite.

Reproduce with:

```sh
npx vitest run test/read-amplification.test.ts test/read-backfill-budget.test.ts
```

No user measurements, tokens or account identifiers are included in the fixtures
or measurement output. Updating the repository alone does not update an existing
user deployment or the quick installer's embedded release.
