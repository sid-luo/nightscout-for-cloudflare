# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

This log covers Nightscout for Cloudflare changes. The upstream Nightscout
version is tracked separately. Existing users should follow the
[upgrade instructions](README.md#2-upgrading). Upgrades currently support only instances deployed with the quick installer.

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
