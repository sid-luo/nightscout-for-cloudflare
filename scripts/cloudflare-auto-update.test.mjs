import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  mergeWranglerConfigs,
  shouldAutoUpdate,
  syncOfficialSource,
} from "./sync-cloudflare-source.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function configureRepository(cwd) {
  git(cwd, "config", "user.name", "Cloudflare Import Test");
  git(cwd, "config", "user.email", "cloudflare-import@example.invalid");
}

function commitAll(cwd, message) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
}

function writeFixtureSource(root, config, marker) {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: {} }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  writeFileSync(path.join(root, "scripts", "build-cloudflare.mjs"), marker);
  writeFileSync(path.join(root, "src", "index.ts"), marker);
  writeFileSync(path.join(root, "release.txt"), marker);
}

test("Cloudflare build entrypoint replaces the filtered GitHub workflow", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.scripts.build, "node scripts/build-cloudflare.mjs");
  assert.equal(
    packageJson.scripts["test:auto-update"],
    "node --test scripts/cloudflare-auto-update.test.mjs",
  );
  assert.equal(
    existsSync(
      path.join(
        projectRoot,
        ".github",
        "workflows",
        "update-nightscout-for-cloudflare.yml",
      ),
    ),
    false,
  );
});

test("Wrangler merge preserves deployment values and adopts platform changes", () => {
  const merged = mergeWranglerConfigs(
    {
      name: "official-name",
      vars: { API_SECRET: "" },
      durable_objects: {
        bindings: [
          { name: "ENTRY_STORE", class_name: "EntryStore" },
          {
            name: "DEXCOM_SHARE_CONNECTOR",
            class_name: "DexcomShareConnector",
          },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["EntryStore"] },
        {
          tag: "v2",
          new_sqlite_classes: ["DexcomShareConnector"],
        },
      ],
      d1_databases: [{ binding: "DB", database_name: "official" }],
      observability: { enabled: true, logs: { head_sampling_rate: 0.05 } },
    },
    {
      name: "user-worker",
      vars: { API_SECRET: "user-value", USER_SETTING: "kept" },
      durable_objects: {
        bindings: [{ name: "ENTRY_STORE", class_name: "EntryStore" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["EntryStore"] }],
      d1_databases: [
        {
          binding: "DB",
          database_name: "user-database",
          database_id: "generated-id",
        },
      ],
      routes: [{ pattern: "example.com/*", zone_name: "example.com" }],
      observability: { enabled: true, logs: { head_sampling_rate: 1 } },
    },
  );

  assert.equal(merged.name, "user-worker");
  assert.deepEqual(merged.vars, {
    API_SECRET: "user-value",
    USER_SETTING: "kept",
  });
  assert.deepEqual(merged.durable_objects.bindings, [
    { name: "ENTRY_STORE", class_name: "EntryStore" },
    {
      name: "DEXCOM_SHARE_CONNECTOR",
      class_name: "DexcomShareConnector",
    },
  ]);
  assert.equal(merged.migrations.at(-1).tag, "v2");
  assert.equal(merged.d1_databases[0].database_id, "generated-id");
  assert.equal(merged.d1_databases[0].database_name, "user-database");
  assert.deepEqual(merged.routes, [
    { pattern: "example.com/*", zone_name: "example.com" },
  ]);
  assert.equal(merged.observability.logs.head_sampling_rate, 0.05);
});

test("source-import retry refreshes code without changing the repository or local secrets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nscf-cloudflare-update-"));

  try {
    const upstream = path.join(root, "upstream");
    const deployment = path.join(root, "deployment");
    mkdirSync(upstream);
    mkdirSync(deployment);

    const upstreamConfig = {
      name: "official-name",
      main: "src/index.ts",
      vars: { API_SECRET: "" },
      durable_objects: {
        bindings: [
          { name: "ENTRY_STORE", class_name: "EntryStore" },
          {
            name: "DEXCOM_SHARE_CONNECTOR",
            class_name: "DexcomShareConnector",
          },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["EntryStore"] },
        {
          tag: "v2",
          new_sqlite_classes: ["DexcomShareConnector"],
        },
      ],
    };
    const deployedConfig = {
      name: "user-worker",
      main: "src/index.ts",
      vars: { API_SECRET: "deployment-secret" },
      durable_objects: {
        bindings: [{ name: "ENTRY_STORE", class_name: "EntryStore" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["EntryStore"] }],
    };

    writeFixtureSource(upstream, upstreamConfig, "official update\n");
    git(upstream, "init", "-b", "main");
    configureRepository(upstream);
    commitAll(upstream, "Official update");

    writeFixtureSource(deployment, deployedConfig, "old deployment\n");
    writeFileSync(path.join(deployment, "stale.txt"), "remove me\n");
    mkdirSync(path.join(deployment, "node_modules"), { recursive: true });
    writeFileSync(
      path.join(deployment, "node_modules", "cache.txt"),
      "preserved\n",
    );
    writeFileSync(
      path.join(deployment, ".dev.vars"),
      "API_SECRET=local-only\n",
    );
    git(deployment, "init", "-b", "main");
    configureRepository(deployment);
    git(
      deployment,
      "remote",
      "add",
      "origin",
      "https://github.com/example/deployed-copy.git",
    );
    commitAll(deployment, "source repo import");
    const deploymentHead = git(deployment, "rev-parse", "HEAD");

    const workersEnvironment = {
      WORKERS_CI: "1",
      WORKERS_CI_BUILD_UUID: "test-build",
      WORKERS_CI_COMMIT_SHA: deploymentHead,
    };
    assert.equal(
      shouldAutoUpdate({
        projectRoot: deployment,
        env: workersEnvironment,
      }),
      true,
    );
    assert.equal(
      shouldAutoUpdate({
        projectRoot: deployment,
        env: {
          ...workersEnvironment,
          WORKERS_CI_COMMIT_SHA: "null",
        },
      }),
      true,
      "manual Retry build may expose a non-SHA placeholder",
    );

    const upstreamSha = syncOfficialSource({
      projectRoot: deployment,
      upstreamUrl: upstream,
      upstreamBranch: "main",
    });
    assert.equal(upstreamSha, git(upstream, "rev-parse", "HEAD"));
    assert.equal(
      readFileSync(path.join(deployment, "release.txt"), "utf8"),
      "official update\n",
    );
    assert.equal(existsSync(path.join(deployment, "stale.txt")), false);
    assert.equal(
      readFileSync(
        path.join(deployment, "node_modules", "cache.txt"),
        "utf8",
      ),
      "preserved\n",
    );
    assert.equal(
      readFileSync(path.join(deployment, ".dev.vars"), "utf8"),
      "API_SECRET=local-only\n",
    );
    assert.equal(git(deployment, "rev-parse", "HEAD"), deploymentHead);

    const mergedConfig = JSON.parse(
      readFileSync(path.join(deployment, "wrangler.jsonc"), "utf8"),
    );
    assert.equal(mergedConfig.name, "user-worker");
    assert.equal(mergedConfig.vars.API_SECRET, "deployment-secret");
    assert.equal(
      mergedConfig.durable_objects.bindings[1].name,
      "DEXCOM_SHARE_CONNECTOR",
    );
    assert.equal(mergedConfig.migrations.at(-1).tag, "v2");

    writeFileSync(path.join(deployment, "custom.txt"), "user change\n");
    commitAll(deployment, "User customization");
    assert.equal(
      shouldAutoUpdate({
        projectRoot: deployment,
        env: {
          ...workersEnvironment,
          WORKERS_CI_COMMIT_SHA: git(deployment, "rev-parse", "HEAD"),
        },
      }),
      false,
    );
    assert.equal(
      shouldAutoUpdate({
        projectRoot: deployment,
        env: {
          ...workersEnvironment,
          WORKERS_CI_COMMIT_SHA: git(deployment, "rev-parse", "HEAD"),
          NSCF_AUTO_UPDATE: "1",
        },
      }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a one-commit repository not created by Cloudflare is not replaced", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nscf-custom-source-"));

  try {
    writeFixtureSource(
      root,
      {
        name: "custom-worker",
        main: "src/index.ts",
        vars: { API_SECRET: "plaintext-value" },
      },
      "custom source\n",
    );
    git(root, "init", "-b", "main");
    configureRepository(root);
    git(
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/example/custom-source.git",
    );
    commitAll(root, "My first release");
    const head = git(root, "rev-parse", "HEAD");

    assert.equal(
      shouldAutoUpdate({
        projectRoot: root,
        env: {
          WORKERS_CI: "1",
          WORKERS_CI_BUILD_UUID: "test-build",
          WORKERS_CI_COMMIT_SHA: head,
        },
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("prerelease checkouts cannot refresh themselves from the stable channel", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nscf-beta-build-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.3.0-beta.1" }));
    assert.equal(shouldAutoUpdate({ projectRoot: root, env: {
      NSCF_AUTO_UPDATE: "1", WORKERS_CI: "1", WORKERS_CI_BUILD_UUID: "fixture", WORKERS_CI_COMMIT_SHA: "fixture",
    } }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
