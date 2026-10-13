# Local changes to the locked Nightscout snapshot

The baseline remains Nightscout v15.0.8 at the commit and archive digest in
`upstream/manifest.json`. These patches are already applied to the checked-in
vendor source; the build must not apply them a second time. Keep the patches
alongside their source changes so the deviation from the baseline is reviewable.

- `0001-client-init-retry.patch`: defer browser initialization retries for five
  seconds, retain the caller's callback, keep at most one pending retry, and
  ignore responses and authentication callbacks from superseded initialization
  attempts. A completed HTTP error still follows upstream's one-time
  authentication flow; only an unreachable response (`readyState === 0`)
  enters the automatic offline retry path. Covered by the real client module
  tests in `scripts/client-init-retry.test.mjs`, included in
  `npm run test:upstream-client`.

`scripts/build-upstream-ui.mjs` copies the rebuilt browser bundle unchanged,
versions its URL by content, and uses that same URL in the generated service
worker cache list. This makes a patched browser bundle replace the previous
cached asset without changing the locked upstream release number.
