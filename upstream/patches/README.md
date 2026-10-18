# Local changes to the locked Nightscout snapshot

The baseline remains Nightscout v15.0.8 at the commit and archive digest in
`upstream/manifest.json`. These patches are already applied to the checked-in
vendor source; the build must not apply them a second time. Keep the patches
alongside their source changes so the deviation from the baseline is reviewable.

- `0001-client-init-retry.patch`: defer browser initialization retries for five
  seconds, retain the caller's callback, keep at most one pending retry, and
  ignore responses and authentication callbacks from superseded initialization
  attempts. This first patch retains upstream's HTTP-error authentication
  flow; the later quota patch below replaces that classification. Covered by the real client module
  tests in `scripts/client-init-retry.test.mjs`, included in
  `npm run test:upstream-client`.
- `0002-storage-quota-ui.patch`: distinguish explicit authorization denial
  from storage quota, network and server failures. Temporary failures preserve
  credentials, display a local safe message and retry with one pending timer,
  exponential backoff and `Retry-After`. Delayed responses cannot invalidate
  replacement credentials or restore an older permission set. This patch is
  based on the already-applied first patch and includes the shared
  `request-errors.js` helper. The same real-module test script covers quota
  recovery, timer bounds, revocation, permissions and credential refresh races.
  Dialog submissions verify their own candidate digest without the active
  Bearer header; rejection and temporary failures leave the verified session
  intact. Success alone replaces the active credential and its permissions.
  Remember stores that verified candidate, or clears the preceding stored
  identity when unchecked. Late refreshes cannot restore a superseded JWT,
  and renewal prefers the active JWT over a token left in the page URL.
  Secret-based write controls use the verified write permission.

`scripts/build-upstream-ui.mjs` copies the rebuilt browser bundle unchanged,
versions its URL by content, and uses that same URL in the generated service
worker cache list. This makes a patched browser bundle replace the previous
cached asset without changing the locked upstream release number.
