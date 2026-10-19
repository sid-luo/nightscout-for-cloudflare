![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

**English** | [简体中文](README.zh-CN.md)

> ## 🚀 [Install Nightscout now (recommended)](https://nscf.sidluo.com/)
>
> **No GitHub. No command line.** Follow the installer to deploy to your own Cloudflare account.
>
> Already installed? [Upgrade your existing instance](https://nscf.sidluo.com/upgrade/).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

This repository provides a fast, low-cost way to deploy
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) on Cloudflare,
without renting a separate server or MongoDB service.
It is an independent, unofficial port, not an official Nightscout release.
Actual costs depend on your Cloudflare plan and usage.

Nightscout for Cloudflare version: **1.4.0**

Upstream Nightscout version: **15.0.8**

## Video tutorial

[![Nightscout for Cloudflare video tutorial — click to watch](https://i.ytimg.com/vi/O_8lD6l6-nQ/hqdefault.jpg)](https://www.youtube.com/watch?v=O_8lD6l6-nQ)

[▶ Watch the full video tutorial](https://www.youtube.com/watch?v=O_8lD6l6-nQ)

## Why this project exists

Nightscout is a great project. As a long-time user, I hope more people can deploy and use Nightscout easily, quickly and at low cost.

## What works today

- Use the Nightscout home page, glucose chart, trend arrows, status information, clock, reports and settings.
- Synchronize data through common v1, v2 and v3 APIs and real-time connections, including common AAPS / NSClientV3 upload workflows.
- Preview and clean up glucose, treatment and device-status records, and manage Profiles in Admin Tools.
- Enable data sources and Webhooks as needed. Newly added integrations are disabled by default; real third-party compatibility is still being validated.

## What is new in 1.4.0

- Reduce repeated database reads during ongoing synchronization, browser refreshes and access by multiple clients.
- Improve cold starts, cache rebuilding, large databases, array filters and custom sorting.
- Fix read-quota failures being reported as an incorrect API key, and prevent an existing login from interfering with verification of a newly entered key.
- Add optional, default-off read diagnostics that exclude sensitive data and help investigate database costs.

See the [changelog](CHANGELOG.md) for the complete version history, test results and release availability.

## How to use

### 1. First installation

- **Method 1: use the [web installer](https://nscf.sidluo.com/) (recommended).** Follow the on-screen instructions to complete installation.
- **Method 2: use the one-click installer on GitHub.** See the [first-time deployment guide](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started) for details.

### 2. Upgrading

This upgrade path supports recognized instances deployed through the **web installer**.
Open the [English upgrade page](https://nscf.sidluo.com/upgrade/), connect the original Cloudflare account, select the instance and confirm the version before upgrading.

Upgrades preserve your data, address, password and settings. Do not use a new installation as an upgrade; it creates a separate instance.
Instances deployed through the GitHub button are not currently supported by this upgrade path.

### 3. API key

Installations and upgrades use a plain-text `API_SECRET` that can be viewed and edited in the Cloudflare dashboard. Upgrades preserve the original key.
If an older instance uses a Cloudflare Secret, the upgrade page asks you to save the **same original value** as plain text before checking again.
The site continues to use HTTPS, and client authentication remains unchanged. Do not include the key in public source code.

## Nightscout and Nightscout for Cloudflare

Nightscout for Cloudflare is an independent, unofficial Cloudflare port of
Nightscout. It keeps the upstream Nightscout version and the port version
separate:

- Nightscout upstream version: **15.0.8**
- Nightscout for Cloudflare version: **1.4.0**

The upstream Admin Tools still provide their corresponding functions, but this
port stores records in SQLite Durable Objects instead of MongoDB. Some visible
names are therefore adjusted to avoid implying that a MongoDB database is
present.

| Original Nightscout name | Nightscout for Cloudflare name |
| --- | --- |
| Clean Mongo status database | Device status maintenance |
| Clean Mongo treatments database | Treatment records maintenance |
| Clean Mongo entries (glucose entries) database | Glucose entries maintenance |
| Remove future items from mongo database | Future-dated records maintenance |

## Technical documentation

- [Configuration and advanced features](docs/CONFIGURATION.md)
- [Cloudflare architecture](docs/ARCHITECTURE.md)
- [Upstream compatibility matrix](docs/UPSTREAM_COMPATIBILITY.md)

## Safety information

Nightscout for Cloudflare is an independent, unofficial, open-source community
project. It is not an official Nightscout release, does not come with guaranteed
technical or medical support, and has not been officially approved or regulated
for diabetes therapy or treatment. Anyone who deploys it is responsible for
building, configuring, securing, maintaining and operating it, and does so at
their own risk.

Nightscout for Cloudflare requires a working internet connection and the
availability of Cloudflare services. Do not rely on it as your only way to know
your blood glucose values or trends, or as the basis for diagnosis, treatment or
insulin dosing. Be ready for unexpected failures and always keep an independent
way to check your blood glucose levels.

These precautions follow the [official Nightscout safety guidance](https://nightscout.github.io/).

## License and attribution

This project is licensed under `AGPL-3.0-only`. Nightscout contributors retain
all rights in upstream work. See `LICENSE`, `NOTICE.md`, and the preserved
`vendor/nightscout/COPYRIGHT` and `vendor/nightscout/LICENSE`.
