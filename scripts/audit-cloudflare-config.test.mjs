import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const nodeVersionUrl = new URL("../.node-version", import.meta.url);

test("deployment uses one visible API_SECRET variable without adding products", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));

  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.vars, { API_SECRET: "" });
  assert.equal(config.secrets, undefined);
  assert.equal(config.kv_namespaces, undefined);
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.queues, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.assets?.binding, "ASSETS");
  assert.deepEqual(config.durable_objects?.bindings, [
    { name: "ENTRY_STORE", class_name: "EntryStore" },
    { name: "DEXCOM_SHARE_CONNECTOR", class_name: "DexcomShareConnector" },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["EntryStore"] },
    { tag: "v2", new_sqlite_classes: ["DexcomShareConnector"] },
  ]);
});

test("Deploy to Cloudflare template requests one plaintext value and a clean-source build", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  const readme = await readFile(readmeUrl, "utf8");
  const nodeVersion = (await readFile(nodeVersionUrl, "utf8")).trim();

  assert.equal(
    packageJson.cloudflare?.bindings?.API_SECRET?.description,
    "This string will be used for authorization later. Please remember it.",
  );
  assert.deepEqual(Object.keys(packageJson.cloudflare?.bindings ?? {}), ["API_SECRET"]);
  assert.equal(packageJson.scripts?.build, "node scripts/build-cloudflare.mjs");
  assert.equal(
    packageJson.scripts?.["build:source"],
    "npm run upstream:install && npm run upstream:bundle && npm run build:ui",
  );
  assert.equal(
    packageJson.scripts?.["test:auto-update"],
    "node --test scripts/cloudflare-auto-update.test.mjs",
  );
  assert.equal(packageJson.scripts?.deploy, "wrangler deploy");
  assert.equal(packageJson.version, "1.3.0-beta.1");
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/sid-luo/nightscout-for-cloudflare.git",
  );
  assert.equal(
    packageJson.homepage,
    "https://github.com/sid-luo/nightscout-for-cloudflare#readme",
  );
  assert.equal(
    packageJson.bugs?.url,
    "https://github.com/sid-luo/nightscout-for-cloudflare/issues",
  );
  assert.match(
    readme,
    /\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/sid-luo\/nightscout-for-cloudflare\)/,
  );
  assert.equal(nodeVersion, "22.16.0");
});
