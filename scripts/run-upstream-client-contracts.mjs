import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = join(repositoryRoot, "vendor", "nightscout");
const upstreamBundle = join(
  upstreamRoot,
  "node_modules",
  ".cache",
  "_ns_cache",
  "public",
  "js",
  "bundle.app.js",
);
const deployedAsset = join(repositoryRoot, "public", "bundle", "js", "bundle.app.js");

const upstreamBytes = readFileSync(upstreamBundle);
const deployedBytes = readFileSync(deployedAsset);
if (!upstreamBytes.equals(deployedBytes)) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  throw new Error(
    `Official client bundle mismatch: upstream=${digest(upstreamBytes)} public=${digest(deployedBytes)}`,
  );
}

const envCommand = join(upstreamRoot, "node_modules", ".bin", "env-cmd");
const mochaCommand = join(upstreamRoot, "node_modules", ".bin", "mocha");
const requiredFiles = [...readFileSync(fileURLToPath(import.meta.url), "utf8").matchAll(/"(\.\/tests\/[^"*]+\.test\.js)"/g)].map((match) => match[1]);
for (const file of requiredFiles) {
  if (!existsSync(join(upstreamRoot, file))) throw new Error(`Missing upstream client test ${file}`);
}
// Upstream goldens include host-local dates captured in Pacific time. Keep
// those four fixtures unchanged and execute them in their recorded zone.
const coreFiles = readdirSync(join(upstreamRoot, "tests/client-core"))
  .filter((name) => name.endsWith(".test.js") && name !== "pill-goldens.test.js")
  .sort().map((name) => `./tests/client-core/${name}`);
const result = spawnSync(
  envCommand,
  [
    "-f",
    "./tests/ci.test.env",
    mochaCommand,
    "--timeout",
    "5000",
    "--require",
    "./tests/hooks.js",
    "--exit",
    "./tests/pluginbase.modern.test.js",
    "./tests/client.renderer.test.js",
    "./tests/errorcodes.test.js",
    "./tests/utils.test.js",
    "./tests/careportal.test.js",
    "./tests/boluswizardpreview.test.js",
    "./tests/profileeditor.test.js",
    "./tests/hashauth.modern.test.js",
    "./tests/admintools.modern.test.js",
    "./tests/reportstorage.test.js",
    "./tests/reports.test.js",
    "./tests/browser-settings.test.js",
    "./tests/clock-client.test.js",
    "./tests/daterangedelete.test.js",
    "./tests/profile-sinks.test.js",
    "./tests/stored-output-sinks.test.js",
    "./tests/profileeditor.records.test.js",
    "./tests/utils.deepMerge.test.js",
    ...coreFiles,
  ],
  {
    cwd: upstreamRoot,
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const goldens = spawnSync(envCommand, [
  "-f", "./tests/ci.test.env", mochaCommand, "--timeout", "5000",
  "--require", "./tests/hooks.js", "--exit", "./tests/client-core/pill-goldens.test.js",
], { cwd: upstreamRoot, env: { ...process.env, TZ: "America/Los_Angeles" }, stdio: "inherit" });
if (goldens.error) throw goldens.error;
if (goldens.status !== 0) process.exit(goldens.status ?? 1);

console.log(
  "Locked upstream client and client-core suites passed unchanged against the byte-identical NSCF client bundle (counts above).",
);
