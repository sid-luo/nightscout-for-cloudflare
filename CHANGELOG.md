# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

This log covers Nightscout for Cloudflare changes. The upstream Nightscout
version is tracked separately. Existing users should follow the
[upgrade instructions](docs/DEPLOYMENT.md#updating-an-existing-deployment)
for their original installation method.

## 2026-09-06 — Reduce repeated reads during AAPS synchronization

**Availability: merged into GitHub `main`; no separate version release yet.**
The project version remains `1.1.1-beta`, so that version string alone does not
identify whether an existing instance includes this fix. See the
[read optimization commit](https://github.com/sid-luo/nightscout-for-cloudflare/commit/df9a894a0c7263fff0cb86a779f3cadf38f1b0a5).

### Changes

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

### Getting the update

- **Installed through the GitHub Deploy to Cloudflare button:** deployments with
  the build updater that meet its activation conditions can rebuild using the
  [upgrade instructions](docs/DEPLOYMENT.md#updating-an-existing-deployment).
- **Installed through the web installer:** there is currently no web upgrade
  flow for existing instances. A GitHub change does not update your instance;
  running the installer again creates a separate instance.
- **Deployed from the command line:** follow the local update procedure in the
  deployment guide, targeting the existing instance.

This GitHub push did not update the web installer's bundled release or existing
user deployments automatically.
