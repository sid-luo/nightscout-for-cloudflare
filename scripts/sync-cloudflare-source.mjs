#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OFFICIAL_REPOSITORY_URL =
  "https://github.com/sid-luo/nightscout-for-cloudflare.git";
const DEFAULT_BRANCH = "main";
const REQUIRED_SOURCE_PATHS = [
  "package.json",
  "wrangler.jsonc",
  "scripts/build-cloudflare.mjs",
  "src/index.ts",
];
const PRESERVED_ROOT_ENTRIES = new Set([".git", ".wrangler", "node_modules"]);
const DEPLOYMENT_ARRAY_KEYS = new Map([
  ["d1_databases", "binding"],
  ["kv_namespaces", "binding"],
  ["r2_buckets", "binding"],
  ["hyperdrive", "binding"],
  ["vectorize", "binding"],
  ["services", "binding"],
  ["dispatch_namespaces", "binding"],
  ["mtls_certificates", "binding"],
  ["pipelines", "binding"],
  ["secrets_store_secrets", "binding"],
  ["workflows", "binding"],
]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout ?? 120_000,
  }).trim();
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function readJsonc(file) {
  return JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
}

function mergeDeploymentArray(upstreamItems, currentItems, identityKey) {
  if (!Array.isArray(upstreamItems)) {
    return currentItems;
  }
  if (!Array.isArray(currentItems)) {
    return upstreamItems;
  }

  const currentByIdentity = new Map(
    currentItems
      .filter((item) => item && item[identityKey])
      .map((item) => [item[identityKey], item]),
  );
  const upstreamIdentities = new Set();
  const merged = upstreamItems.map((item) => {
    const identity = item?.[identityKey];
    if (!identity) {
      return item;
    }
    upstreamIdentities.add(identity);
    return { ...item, ...(currentByIdentity.get(identity) ?? {}) };
  });

  for (const item of currentItems) {
    const identity = item?.[identityKey];
    if (identity && !upstreamIdentities.has(identity)) {
      merged.push(item);
    }
  }

  return merged;
}

export function mergeWranglerConfigs(upstream, current) {
  const merged = { ...current, ...upstream };

  if (current.name) {
    merged.name = current.name;
  }
  if (upstream.vars || current.vars) {
    merged.vars = { ...(upstream.vars ?? {}), ...(current.vars ?? {}) };
  }

  for (const [key, identityKey] of DEPLOYMENT_ARRAY_KEYS) {
    const value = mergeDeploymentArray(
      upstream[key],
      current[key],
      identityKey,
    );
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  if (upstream.durable_objects || current.durable_objects) {
    merged.durable_objects = {
      ...(current.durable_objects ?? {}),
      ...(upstream.durable_objects ?? {}),
      bindings: mergeDeploymentArray(
        upstream.durable_objects?.bindings,
        current.durable_objects?.bindings,
        "name",
      ),
    };
  }

  if (upstream.env || current.env) {
    merged.env = {};
    const environmentNames = new Set([
      ...Object.keys(current.env ?? {}),
      ...Object.keys(upstream.env ?? {}),
    ]);
    for (const name of environmentNames) {
      merged.env[name] = mergeWranglerConfigs(
        upstream.env?.[name] ?? {},
        current.env?.[name] ?? {},
      );
    }
  }

  return merged;
}

function shouldPreserveRootEntry(name) {
  return (
    PRESERVED_ROOT_ENTRIES.has(name) ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars.") ||
    name === ".env" ||
    name.startsWith(".env.")
  );
}

function normalizeRepositoryUrl(url) {
  return url
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function shouldAutoUpdate({
  projectRoot,
  env = process.env,
  officialRepositoryUrl = OFFICIAL_REPOSITORY_URL,
}) {
  // A test checkout must never be replaced by the stable channel during a build.
  const packagePath = path.join(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (typeof version === "string" && /^\d+\.\d+\.\d+-/.test(version)) return false;
  }
  if (env.NSCF_AUTO_UPDATE === "0") {
    return false;
  }
  if (
    env.WORKERS_CI !== "1" ||
    !env.WORKERS_CI_BUILD_UUID ||
    !env.WORKERS_CI_COMMIT_SHA
  ) {
    return false;
  }

  let origin;
  try {
    origin = run("git", ["remote", "get-url", "origin"], { cwd: projectRoot });
  } catch {
    return false;
  }
  if (
    normalizeRepositoryUrl(origin) ===
    normalizeRepositoryUrl(officialRepositoryUrl)
  ) {
    return false;
  }

  if (env.NSCF_AUTO_UPDATE === "1") {
    return true;
  }

  try {
    const commitCount = Number(
      run("git", ["rev-list", "--count", "HEAD"], {
        cwd: projectRoot,
      }),
    );
    const commitSubject = run("git", ["log", "-1", "--format=%s"], {
      cwd: projectRoot,
    });
    return commitCount === 1 && commitSubject === "source repo import";
  } catch {
    return false;
  }
}

export function syncOfficialSource({
  projectRoot,
  upstreamUrl = OFFICIAL_REPOSITORY_URL,
  upstreamBranch = DEFAULT_BRANCH,
}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nscf-source-"));
  const checkout = path.join(temporaryRoot, "official");

  try {
    run(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        upstreamBranch,
        upstreamUrl,
        checkout,
      ],
      { timeout: 180_000 },
    );

    for (const relativePath of REQUIRED_SOURCE_PATHS) {
      if (!existsSync(path.join(checkout, relativePath))) {
        throw new Error(
          `Official update is missing required path: ${relativePath}`,
        );
      }
    }

    const upstreamSha = run("git", ["rev-parse", "HEAD"], { cwd: checkout });
    const currentConfig = readJsonc(path.join(projectRoot, "wrangler.jsonc"));
    const upstreamConfig = readJsonc(path.join(checkout, "wrangler.jsonc"));
    const mergedConfig = mergeWranglerConfigs(upstreamConfig, currentConfig);

    for (const name of readdirSync(projectRoot)) {
      if (!shouldPreserveRootEntry(name)) {
        rmSync(path.join(projectRoot, name), { recursive: true, force: true });
      }
    }

    for (const name of readdirSync(checkout)) {
      if (name === ".git" || name === "node_modules") {
        continue;
      }
      cpSync(path.join(checkout, name), path.join(projectRoot, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    writeFileSync(
      path.join(projectRoot, "wrangler.jsonc"),
      `${JSON.stringify(mergedConfig, null, 2)}\n`,
    );

    return upstreamSha;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");
  const upstreamSha = syncOfficialSource({
    projectRoot,
    upstreamUrl: process.env.NSCF_UPSTREAM_URL ?? OFFICIAL_REPOSITORY_URL,
    upstreamBranch: process.env.NSCF_UPSTREAM_BRANCH ?? DEFAULT_BRANCH,
  });
  console.log(`Prepared official Nightscout for Cloudflare source ${upstreamSha}.`);
}
