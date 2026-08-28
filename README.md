![Nightscout for Cloudflare](docs/assets/nightscout-for-cloudflare.png)

# Nightscout for Cloudflare

**English** | [简体中文](README.zh-CN.md)

> ### 🚀 [Open the web installer](https://nscf.sidluo.com/)
>
> No GitHub. No command line. Deploy directly to your own Cloudflare account.

Nickname: **The Instant Noodle Edition**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sid-luo/nightscout-for-cloudflare)

This repository provides a fast and free way to deploy
[Nightscout](https://github.com/nightscout/cgm-remote-monitor) on Cloudflare.
It runs within Cloudflare's free-plan limits without a paid server or MongoDB
service. It is an independent, unofficial port—not an official Nightscout
release.

Current Nightscout for Cloudflare release: **1.1.1-beta**

Upstream Nightscout version: **15.0.7**

This project preserves the official Nightscout pages, layout, charts, plugins,
translations and calculations, adding only the Cloudflare platform adapter.

## Why this project exists

Nightscout is a great project. We used to be able to deploy it on Heroku for
free, but that was a long time ago. Cloudflare, meanwhile, is something of a
cyber philanthropist, but it does not support MongoDB.

Nightscout has already provided excellent instant noodles, but without a fork
or hot water (it used to have them). This project provides the fork and puts
the hot water (Cloudflare) right in front of you. Just click a few times and,
in the time it takes to make instant noodles, you can get a Nightscout.

## What works today

- Most commonly used Nightscout features are implemented
- The home page, glucose chart, trend arrow, status information and settings
  pages work
- The common read and write APIs used through v1, v2 and v3 are implemented

## How to use

- [Open the web installer](https://nscf.sidluo.com/)
- [First-time deployment guide](https://github.com/sid-luo/nightscout-for-cloudflare/tree/main/docs/getting-started)

## Nightscout and Nightscout for Cloudflare

Nightscout for Cloudflare is an independent, unofficial Cloudflare port of
Nightscout. It keeps the upstream Nightscout version and the port version
separate:

- Nightscout upstream version: **15.0.7**
- Nightscout for Cloudflare version: **1.1.1-beta**

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
- [Deployment and first use](docs/DEPLOYMENT.md)
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
