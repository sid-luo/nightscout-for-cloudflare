# Attribution and project status

NSCF (Nightscout for Cloudflare) is an independent, unofficial downstream
port of the Nightscout project (`nightscout/cgm-remote-monitor`). Nightscout
and its contributors are the upstream authors of the API and product concepts
that this project seeks to preserve.

NSCF is not endorsed by, affiliated with, or an official release of the
Nightscout Foundation or the upstream maintainers. Sugar AI may support the
project as an initiator or maintainer, but NSCF has no runtime or account
dependency on Sugar AI.

Upstream project: https://github.com/nightscout/cgm-remote-monitor

Upstream copyright notice:
https://github.com/nightscout/cgm-remote-monitor/blob/master/COPYRIGHT

NSCF is not a medical device and must not be used for diagnosis, dosing,
insulin advice, or any other medical decision.

The official Nightscout v15.0.8 source snapshot is vendored under
`vendor/nightscout` and retains its upstream COPYRIGHT and LICENSE. Its UI,
charts, plugins, translations and client calculations are built without an NSCF
redesign. NSCF-authored code supplies only the Cloudflare platform adaptation.

## Runtime dependency notices

The Cloudflare adapter bundles these third-party runtime packages. Versions are
locked in `package-lock.json`; their authors retain their respective copyright
and license rights.

| Package | Version | License |
| --- | --- | --- |
| accepts | 1.3.8 | MIT |
| negotiator | 0.6.3 | MIT |
| mime-types | 2.1.35 | MIT |
| mime-db | 1.52.0 | MIT |
| csv-stringify | 5.6.5 | MIT |
| easyxml | 2.0.1 | BSD-3-Clause OR GPL-2.0 |
| elementtree | 0.1.7 | Apache-2.0 |
| inflect | 0.3.0 | MIT |
| sax | 1.1.4 | ISC / W3C notice |
| mime | 2.6.0 | MIT |
| shiro-trie | 0.4.10 | MIT |

The corresponding package metadata and license texts are distributed with the
installed packages. Source and license links are recorded by the npm package
metadata and lockfile. EasyXML's npm artifact declares its dual license in
`package.json` but does not include a standalone `LICENSE` file; this notice
preserves that declaration explicitly.

The 15.0.8 storage purifier and XML field-name normalization are adapted from
Nightscout's AGPL-3.0-only implementation. sanitize-html (MIT), entities (BSD-2-Clause)
and their dependencies retain their npm license metadata and notices.
