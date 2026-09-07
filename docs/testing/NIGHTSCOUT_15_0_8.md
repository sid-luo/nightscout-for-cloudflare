# Nightscout 15.0.8 testing track

Development branch: `codex/nightscout-15.0.8-beta`.

This branch starts from NSCF 1.2.0. It is an incremental port of Nightscout
15.0.8; the locked upstream snapshot remains 15.0.7 until the client and
server compatibility work is complete. It is not a stable release.

## Completed changes

- BWP notifications now require positive IOB before snoozing a high alarm,
  and ignore calculations containing errors, matching upstream PR #8558.
  Four new regression cases fail before the change and pass afterward.
  Existing positive-IOB snooze and warning/urgent behavior remain covered.

## Validation

2026-09-07: TypeScript passed. Full Workers run: 874 passed and five failed;
four failures were missing generated UI assets in the new checkout and one
was an alarm-timing assertion. After restoring the generated 1.2.0 assets,
all four affected test files passed (83 tests, including BWP). No runtime
change was made to work around the alarm timing failure.

## Deployment isolation

Use a separate Worker name and its own Durable Object namespaces, and a
separate Pages project if used. A preview URL alone does not isolate data.
Set the build environment variable `NSCF_AUTO_UPDATE=0` to build the checked-out
testing commit. Do not deploy this branch with the existing production name
or use the production installer to distribute it.

A Cloudflare test account and instance have not yet been selected. There is
no deployed 15.0.8 test URL at this stage. New connectors and webhook support
are outside this upgrade's scope.
