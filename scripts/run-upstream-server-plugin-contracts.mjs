import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = join(repositoryRoot, "vendor", "nightscout");
const mocha = join(upstreamRoot, "node_modules", ".bin", "mocha");
const files = [
  "./tests/dataloader.test.js",
  "./tests/dbsize.test.js",
  "./tests/timeago.test.js",
  "./tests/cannulaage.test.js",
  "./tests/insulinage.test.js",
  "./tests/sensorage.test.js",
  "./tests/data.treatmenttocurve.test.js",
  "./tests/iob.test.js",
  "./tests/cob.test.js",
  "./tests/openaps.test.js",
  "./tests/openaps.missingPill.test.js",
  "./tests/loop-server.test.js",
  "./tests/pump.test.js",
  "./tests/basalprofileplugin.test.js",
  "./tests/treatmentnotify.test.js",
  "./tests/simplealarms.test.js",
  "./tests/notifications.test.js",
  "./tests/adminnotifies.test.js",
  "./tests/cache-objectid-compat.test.js",
  "./tests/env.test.js",
  "./tests/mongo-pool-config.test.js",
  "./tests/expressextensions.test.js",
  "./tests/ar2.test.js",
];

const result = spawnSync(
  mocha,
  ["--timeout", "5000", "--exit", ...files],
  {
    cwd: upstreamRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("Locked upstream server/data-plugin files passed unchanged (counts above).");
