# Nightscout for Cloudflare: Deployment and First Use

**English** | [简体中文](DEPLOYMENT.zh-CN.md)

This guide covers how to deploy and verify the current release, along with its
known limitations. Development history and individual release changes belong
in Git history rather than the user guide.

## Current release status

- Nightscout for Cloudflare version: `1.1.1-beta`
- Upstream Nightscout version: `15.0.7`
- Platform: Cloudflare Workers Free
- Storage: SQLite Durable Objects
- Interface: official Nightscout pages
- Data: a new instance starts empty and must be connected to your own data source
- Release status: suitable for testing new instances; full upstream equivalence
  and production readiness are not yet claimed

Source deployment, Profile saving, Admin authentication, test-data writes, the
official home-page chart, and remote API/realtime protocol checks have been
verified on a fresh Cloudflare account. A complete ordinary-user test of the
public Deploy button is still required, as are real AAPS and Loop tests by
users.

## Nightscout Admin Tools name mapping

Nightscout for Cloudflare uses SQLite Durable Objects instead of MongoDB. The
corresponding upstream Admin Tools remain available, but they operate on SQLite
data. Only the following four visible labels are changed. The original names
are retained here so that upstream Nightscout guides remain easy to follow:

| Original Nightscout name | Nightscout for Cloudflare name |
| --- | --- |
| Clean Mongo status database | Device status maintenance |
| Clean Mongo treatments database | Treatment records maintenance |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance |
| Remove future items from mongo database | Future-dated records maintenance |

These tools delete real records. Confirm the data type and time range, and keep
any required backup, before using them.

## What Cloudflare creates

One NSCF deployment uses only:

1. one Cloudflare Worker;
2. one Workers Static Assets bundle;
3. two SQLite Durable Object namespaces: `EntryStore` for primary data and
   realtime protocols, plus a separate Dexcom Share Connector that is disabled
   by default;
4. one plain-text Worker variable: `API_SECRET`.

It does not create D1, R2, KV, Queues, a custom domain, or a Cloudflare Zone
route.

## One-click deployment

Cloudflare's Deploy to Cloudflare feature requires a public source repository.
Click the button at the top of the project README:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

The deployment page asks for one value:

### `API_SECRET`

Choose a value you will remember. It is used for authorization after
deployment. Enter the same value in the Nightscout website, AAPS, or any other
data source that connects to this instance.

You may adjust the copied GitHub repository name, Worker name, and resource
names on the deployment page. After authorization, Cloudflare builds the
source, creates the declared resources, and deploys the Worker.

Cloudflare documentation:

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Deploy buttons support environment variables and secrets](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/)

## Updating an existing deployment

Check the [changelog](../CHANGELOG.md), then identify your original installation
method. Updating the GitHub source does not automatically upgrade every user's
instance.

| Original installation method | Current upgrade path |
| --- | --- |
| Deploy to Cloudflare button on GitHub | Eligible source deployments can rebuild as described below |
| Web installer | No existing-instance upgrade flow yet; installing again creates a new instance |
| Local Git/Wrangler deployment | Follow the local update procedure near the end of this guide |

### Instances installed using the Deploy to Cloudflare button

The Deploy to Cloudflare button creates an independent Git repository in your
account, not a GitHub fork. It therefore has no `Sync fork` button, and GitHub
Actions update workflows from this project are not retained during import.
New deployments use Cloudflare's own build history for updates:

1. Open the existing Worker in the Cloudflare dashboard.
2. Open **Deployments**, then select **View build history**.
3. Open the latest successful build.
4. Select **Retry build**.

`npm run build` detects the `WORKERS_CI` environment provided by Workers Builds
and the single-commit source copy created by Cloudflare. It then refreshes the
official `main` branch inside the temporary build directory. The build uses the
latest official source while preserving the copied repository's Worker name,
plain-text `API_SECRET`, and Cloudflare-generated resource identifiers. The
update occurs only inside Cloudflare's disposable build workspace; it does not
write to your GitHub repository.

If downloading, dependency installation, building, or Wrangler deployment
fails, the new version does not become active. The current Worker and Durable
Object data continue running on the previous version.

To avoid overwriting a user's development work, automatic source refresh is
enabled by default only for deployment copies containing a single
`source repo import` commit. If you add custom Git commits, the build uses your
own source. Add the build variable `NSCF_AUTO_UPDATE=1` only if Cloudflare
builds may ignore those custom commits.

Copies created before this build updater was introduced require one final
redeployment or a manual bootstrap. Once the updater is present,
**Retry build** is the normal update path.

### Instances installed using the web installer

The web installer uploads a release bundle directly, without the Git source-build
workflow above. The **Retry build** procedure therefore does not apply to these
installations. The installer currently creates new instances and has no flow for
upgrading an existing one.

Running it again creates a separate instance: it does not upgrade the original
Worker or migrate its database. Keep the existing instance and data. Availability
and instructions for a future web upgrade flow will be documented in the
[changelog](../CHANGELOG.md).

## First launch

A new instance has no Profile. Redirecting to `/profile/` on the first visit is
normal Nightscout behavior.

1. Scroll to the bottom of the Profile Editor.
2. Select **(Authenticate)**.
3. Enter the `API_SECRET` chosen during deployment.
4. On your own device, select **Remember this device**.
5. Select **Authenticate**.
6. Change the profile name, time zone, and units if needed. You may also save
   the default `Default` profile and `UTC` time zone.
7. Select **Save**.
8. Confirm that the page shows `Status: success`, then return to the home page.

If closing the Profile Editor immediately returns you to the same page:

- check whether the bottom of the page still shows `Unauthorized`;
- confirm that you entered the original deployment password;
- confirm that the value has no leading or trailing spaces;
- select **Authenticate** again, then select **Save** after authentication
  succeeds.

This usually means that authentication was not completed. It does not normally
mean that a required Profile field is missing or that the Cloudflare Durable
Object cannot save data.

## Changing `API_SECRET`

You can change the value later:

1. Open the Cloudflare dashboard.
2. Open **Workers & Pages**.
3. Select your NSCF Worker.
4. Open **Settings → Variables and Secrets**.
5. Edit `API_SECRET` and keep its type set to **Text**.
6. Save it and wait for the new version to finish deploying.
7. Update the Nightscout website, AAPS, and every other uploader to use the
   same value.

For display, authentication, API, and plugin variables, see
[Configuration and advanced features](CONFIGURATION.md).

## Dexcom Share (Beta, advanced users)

This feature is disabled by default and does not affect an ordinary
deployment. To enable it, manually add the following values under
**Settings → Variables and Secrets** in the Cloudflare dashboard:

- `ENABLE`: retain the existing value and add `connect`
- `CONNECT_SOURCE`: `dexcomshare`
- `CONNECT_SHARE_ACCOUNT_NAME`: your Dexcom Share account
- `CONNECT_SHARE_PASSWORD`: your Dexcom Share password
- `CONNECT_SHARE_REGION`: `us`

For Dexcom Share accounts outside the United States, set
`CONNECT_SHARE_REGION` to `ous`. Protocol and simulated-service tests are
complete; community acceptance with real accounts is not yet complete.

After saving the variables and waiting for deployment to finish, open the
Nightscout home page or `/admin/` once to start the Connector. It then uses a
separate Durable Object alarm to fetch data periodically.

See [Configuration and advanced features](CONFIGURATION.md) for the complete
variable list, Secret types, and status checks.

## Local or command-line deployment

Node.js 22 LTS or newer is recommended.

```sh
git clone https://github.com/sid-luo/nightscout-for-cloudflare.git
cd nightscout-for-cloudflare
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
```

Log in to Cloudflare:

```sh
npx wrangler login
```

After deployment, add a plain-text `API_SECRET` under
**Settings → Variables and Secrets** in the Cloudflare dashboard.

Deploy after all local checks pass:

```sh
npm run deploy
```

For local development, create `.dev.vars`:

```sh
touch .dev.vars
```

Add a local test password:

```dotenv
API_SECRET=choose-your-own-password
```

Start the development server:

```sh
npm run dev
```

Open <http://localhost:8787/>.

## Post-deployment checks

### Pages

- `/healthz` reports a healthy status and Nightscout `v15.0.7`
- `/profile/` can authenticate and save a Profile
- `/admin/` loads Subjects, Roles, and data-maintenance tools after
  authentication is remembered
- the four data-maintenance labels in `/admin/` no longer refer to MongoDB
- the data-maintenance tools operate on SQLite Durable Objects without MongoDB
- `/food/` opens and can create and delete a test record
- `/report/` opens the Reports page
- after connecting your own data source, the home page shows current glucose,
  the trend arrow, and the chart

### APIs and realtime connections

- v1 Status and Entries reads work
- v2 Status, Properties, and Summary reads work
- v3 can obtain a JWT and perform authorized reads and writes for the required
  collections
- EIO3/EIO4 polling, WebSocket, and realtime `dataUpdate` work

The repository includes a remote check command:

```sh
npm run smoke:public -- https://your-worker.workers.dev
```

Do not treat “the page opens” as complete compatibility evidence. APIs,
authorization, realtime connections, and persistence must be checked
separately.

## AAPS or Loop acceptance

The current code covers common AAPS, AndroidAPS, and Loop data shapes and
protocol contracts. Before a formal release, users still need to complete
real-client acceptance tests in their own test environments.

Start with a minimal test:

1. Enter the new NSCF address and your `API_SECRET` in the client.
2. Enable data upload only; do not immediately change existing treatment or
   closed-loop settings.
3. Confirm that current glucose, Device Status, and Treatments appear in NSCF.
4. Confirm that time, time zone, units, Profile, and trend values are correct.
5. Confirm that uploads resume after a network interruption without losing or
   incorrectly duplicating ordinary records.
6. After observation, decide whether to continue with more complete
   closed-loop compatibility testing.

NSCF does not add a dosing algorithm or modify client-side treatment logic.

## Current limitations

- no one-click migration for years of historical MongoDB data
- arbitrary Mongo queries and unlimited reads are not guaranteed compatible
- APIs and batch writes have explicit limits appropriate for Workers Free
- Engine.IO binary packets are not yet adapted
- a small number of dynamic Node.js server plugins and third-party
  integrations remain to be adapted
- the public Deploy button and real closed-loop devices still require final
  user acceptance
- `1.1.1-beta` must not be used for live medical data

See [UPSTREAM_COMPATIBILITY.md](UPSTREAM_COMPATIBILITY.md) for the complete
compatibility gap.

## Deleting and starting over

Deleting a Worker does not necessarily mean that all data in its associated
Durable Object namespaces has been explicitly deleted. The simplest reliable
ways to verify a completely clean new-user flow are:

- use a new Cloudflare test account; or
- use new Worker and Durable Object namespace names.

Deleting a class namespace through a Durable Object migration permanently
deletes its data. Do this only after confirming that none of the data is still
needed. See
[Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## Updating a local clone

Back up or preserve the existing instance before updating the code:

```sh
git pull
npm ci
npm run build
npm run check
npm test
npm run deploy:dry
npm run deploy
```

Repeat the page and API checks after deployment.
