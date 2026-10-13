# 1.3.2-beta.1 request and read optimization

Testing branch: `codex/request-budget`. Stable remains `1.3.1`.

## What changes

- Count-only legacy device-status reads apply the requested bound in SQL instead
  of loading 5,000 candidates first. Queries with filters or sorting retain the
  original candidate window and JavaScript semantics.
- Exact serialized device-status and treatment query results, including empty
  results, are reused until the relevant collection changes or the object
  restarts. Each collection has an LRU cache bounded to 128 keys / 4 MiB;
  responses larger than 1 MiB are not cached. Sizes include key and value UTF-16
  strings. Writes and failed transactions invalidate the corresponding cache.
- Default legacy treatment ordering can use the existing partial index. There
  is no schema migration or new index.
- REST authorization runs within one Durable Object RPC. Credential, JWT and
  role reads are reused only within that request. Failure delays still happen
  before credential and role resolution, so revocations during the delay apply.
- Exact `/entries` freshness and query data share one RPC, as do plugin context
  and status. Missing new RPC methods on an old object fall back to the previous
  methods; ordinary storage failures are not retried through that fallback.
- Failed browser initialization waits five seconds before retrying and retains
  only one pending retry. A newer initialization supersedes stale responses and
  authentication callbacks. New client code receives a different asset URL and
  service-worker cache key.

## Local measurements

These are synthetic fixtures executed through the real Worker handler and
EntryStore code. Internal `this.method()` calls are not counted as RPCs.

| Workload | Before | After |
| --- | ---: | ---: |
| Anonymous / admin-secret status or treatments GET | 3 RPC | 2 RPC |
| Anonymous / admin-secret entries or properties GET | 4 RPC | 2 RPC |
| Valid bearer-token ordinary REST GET | 6–7 RPC | 2 RPC |
| Valid query-token status GET | 11 RPC | 2 RPC |
| 5,000 device-status records; `count=5`, whole HTTP request | about 10,008 rows read each time | 18 cold / 7 repeated |
| Matching category treatment query, data SQL only | 6,250 rows read | 9 cold / 0 repeated |
| Browser: six consecutive connection failures at unchanged fake time | 7 AJAX attempts | 1 AJAX attempt; subsequent attempts at 5-second intervals |

Request counts and database rows are different quantities. Combining RPCs
reduces internal Durable Object calls; it does not change how often an external
client polls the Worker. Read caching reduces SQL work and does not increase
Cloudflare's allowances.

## Regression scope and limits

Tests cover successful and denied authorization, current role resolution,
status query credentials versus headers, token precedence, failure delay,
conditional entries responses, plugin output, old-method fallback, read bounds,
complex filtering and sort ties, empty results, writes, rollback, eviction and
browser retry timing. The full test command also runs upstream client,
server-plugin and compatibility checks. The application regression suite contains
1,029 tests across 106 files. Ten dedicated browser tests execute the shipped
initializer and verify its built bundle and cache keys; upstream client checks
include 351 passing cases and four golden cases, with two existing pending
cases retained. Type checking and Worker package construction are also checked.

Complex device-status filters may still load up to 5,000 candidates on a cold
read. A missing treatment category or many equal timestamps can still require
more SQL work. Caches are per object instance and bounded; there is no promise
that a given response stays resident or that daily account usage falls by a
particular percentage. Socket polling and background scheduling are unchanged.

The original reported quota exhaustion occurred outside the supplied
Cloudflare log window. These changes fix reproduced NSCF amplification; they
do not establish which quota was exhausted in that incident and are not
specific to xDrip4iOS.

## Upgrade

Supported web-installer instances can choose **1.3.2-beta.1** on the
[English upgrade page](https://nscf.sidluo.com/upgrade/) or
[Chinese upgrade page](https://ns.sidluo.com/sj/), then confirm the testing
upgrade. Each upgrade job pins a reviewed package rather than following a
moving Git branch. Stable and older pinned package assets remain available.
Existing instances are not upgraded automatically.

## 中文说明

本分支同时处理两类开销：减少每个 REST 请求产生的内部 DO 调用，以及减少重复查询
读取的数据库行数。网页连接失败后的立即重试也已修复。这些是 NSCF 通用路径，
并非 xDrip4iOS 专属问题。

上表中的 5,000 条是本地合成数据，不是用户实际数据库大小。只要 5 条状态时，
简单查询直接在 SQL 中限制数量；带过滤或排序的查询保留原有候选范围和语义。
返回值缓存有容量上限，写入、回滚和实例重启后会重新读取。不会删除历史数据，
也不会减少必要的上传确认。

已确认的内部放大得到修复，但现有附件不覆盖原故障现场，因此仍不能把原个案
确定归因于某一额度。新版本作为 **1.3.2-beta.1** 测试升级提供，默认稳定版仍为
**1.3.1**；需要用户在升级页选择测试版并确认。
