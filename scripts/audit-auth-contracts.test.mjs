import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const LOCKED_COMMIT = "92d0834219aa771b5837dbcbf1baeb839a200cf6";
const LOCKED_FILES = new Map([
  ["vendor/nightscout/lib/authorization/storage.js", "035f43cf90b1c6bfda176c098a278c2fb84b5b3d47ed55888face5dfb8fa81d5"],
  ["vendor/nightscout/lib/authorization/index.js", "aad771fc9f72edba6bc05916beada477a41775cb1cb88ec48495e52413348e22"],
  ["vendor/nightscout/lib/authorization/endpoints.js", "d6554af412833b0e3bf689dd0a6ea43a18b7ef8d4af9443dee8fda05c5c0d32a"],
  ["vendor/nightscout/lib/authorization/delaylist.js", "532ac0827177912e4cb06c003869affceb97216bc4a583f1cb2cc0bc4438f80b"],
  ["vendor/nightscout/lib/api/verifyauth.js", "adb5b9edbce174fd02c3431fdf9d386270e286662bb80db1f673f6e6e349ff73"],
  ["vendor/nightscout/lib/server/enclave.js", "3c0c512e595a7a1cb24a1d109238459e9f1aa2a00fd0dc977db439367bfff13d"],
  ["vendor/nightscout/tests/api.security.test.js", "ccb58765fb0ad38e9b0ada9e6722b37a7c116d3b926c1749a9fe74c24436df25"],
  ["vendor/nightscout/tests/api.verifyauth.test.js", "d54c3042c51b28a52deb12e16b1e829a241a820755c6620845ddf7c6205f769d"],
  ["vendor/nightscout/tests/hashauth.modern.test.js", "2cd8e69fa0a86e7e7a9cab21432dad36a6baab83e551af4fe66259bbee1531c2"],
  ["vendor/nightscout/tests/identity-matrix.test.js", "f1189c3e7673ab3db5af85ef45be429f2867cfe2d1e09f9751e52f8b927c3215"],
  ["vendor/nightscout/tests/security.test.js", "6bc8a191c39116915a36dc818b93dd772ce03c190bc26fcb665fff14e8613e61"],
  ["vendor/nightscout/tests/verifyauth.test.js", "715dc67da0ed94ecf3cea629cf7b42f7a545a6d25323e0d28dfe8a8a888da003"],
]);

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function loadLockedStorage() {
  const module = { exports: {} };
  const upstreamRequire = createRequire(join(REPO_ROOT, "vendor/nightscout/package.json"));
  const lodash = {
    last(values) {
      return values.at(-1);
    },
    find(values, predicate) {
      if (typeof predicate === "function") return values.find(predicate);
      return values.find((value) => Object.entries(predicate).every(
        ([key, expected]) => value[key] === expected,
      ));
    },
  };
  const require = (specifier) => {
    if (specifier === "lodash") return lodash;
    if (specifier === "crypto" || specifier === "node:crypto") return { createHash };
    if (specifier === "../utils") return () => upstreamRequire("./lib/utils")({
      moment: upstreamRequire("moment-timezone"), settings: {}, language: { translate: (text) => text },
    });
    if (specifier === "shiro-trie") return { new: () => ({ add() {} }) };
    if (specifier === "mongodb") return { ObjectId: class ObjectId {} };
    if (specifier === "../storage/run-with-callback") {
      return (operation) => operation();
    }
    if (specifier === "../server/query") return () => ({});
    throw new Error(`unexpected locked storage dependency: ${specifier}`);
  };
  vm.runInNewContext(
    `(function (require, module, exports) {\n${source("vendor/nightscout/lib/authorization/storage.js")}\n})(require, module, module.exports);`,
    { require, module },
    { filename: "vendor/nightscout/lib/authorization/storage.js" },
  );
  const init = module.exports;
  return init(
    { authentication_collections_prefix: "", enclave: {} },
    { store: { collection: () => ({}) } },
  );
}

function lockedJavascriptFiles(relativeDirectory) {
  const results = [];
  function visit(relativePath) {
    for (const entry of readdirSync(join(REPO_ROOT, relativePath), { withFileTypes: true })) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith(".js")) results.push(child);
    }
  }
  visit(relativeDirectory);
  return results;
}

function loadLockedDelayList(now) {
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier === "lodash") {
      return {
        get(value, path, fallback) {
          const found = path.split(".").reduce(
            (current, key) => current == null ? undefined : current[key],
            value,
          );
          return found === undefined ? fallback : found;
        },
      };
    }
    throw new Error(`unexpected locked delay-list dependency: ${specifier}`);
  };
  vm.runInNewContext(
    `(function (require, module, exports) {\n${source("vendor/nightscout/lib/authorization/delaylist.js")}\n})(require, module, module.exports);`,
    {
      require,
      module,
      Date: { now: () => now.value },
      setTimeout: () => 0,
    },
    { filename: "vendor/nightscout/lib/authorization/delaylist.js" },
  );
  return module.exports({ settings: { authFailDelay: 50 } });
}

test("authorization audit is pinned to the exact v15.0.8 commit and source/test bytes", () => {
  const manifest = JSON.parse(source("upstream/manifest.json"));
  assert.equal(manifest.release, "v15.0.8");
  assert.equal(manifest.commit, LOCKED_COMMIT);
  for (const [relativePath, expected] of LOCKED_FILES) {
    const actual = createHash("sha256").update(source(relativePath)).digest("hex");
    assert.equal(actual, expected, relativePath);
  }
});

test("locked storage produces the reviewed subject derivation vector", () => {
  const storage = loadLockedStorage();
  const apiSecret = "this is my long pass phrase";
  const subjectId = "0123456789abcdef01234567";
  const apiSecretDigest = storage.getSHA1(apiSecret);
  const digest = storage.getSHA1(`${apiSecretDigest}${subjectId}`);
  const accessToken = `phone1-${digest.slice(0, 16)}`;
  assert.deepEqual(
    { apiSecretDigest, digest, accessToken, accessTokenDigest: storage.getSHA1(accessToken) },
    {
      apiSecretDigest: "b723e97aa97846eb92d5264f084b2823f57c4aa1",
      digest: "25b05783401c1be264c17d3ad6556eb6fb9a38f9",
      accessToken: "phone1-25b05783401c1be2",
      accessTokenDigest: "4abeabb5ba9d6c69f4cccb8cb96e47dc268fac18",
    },
  );
  assert.equal(sha1(accessToken), storage.getSHA1(accessToken));
});

test("locked storage accepts its exact prefix/alias vectors in presented order", () => {
  const storage = loadLockedStorage();
  const subject = {
    _id: "0123456789abcdef01234567",
    name: "Phone #1!",
    digest: "25b05783401c1be264c17d3ad6556eb6fb9a38f9",
    accessToken: "phone1-25b05783401c1be2",
    accessTokenDigest: "4abeabb5ba9d6c69f4cccb8cb96e47dc268fac18",
    roles: ["readable"],
  };
  storage.subjects = [subject];
  assert.equal(storage.findSubject(subject.accessToken), subject);
  assert.equal(storage.findSubject("cosmetic-prefix-25b05783401c1be2"), subject);
  assert.equal(storage.findSubject("4abeabb5ba9d6c69"), subject);
  assert.equal(storage.findSubject("25b05783401c1be"), null);
  assert.equal(storage.findSubject("cosmetic-prefix-25B05783401C1BE2"), null);
  assert.equal(storage.findSubject(["not-valid", "alias-25b05783401c1be2"]), subject);
});

test("locked sources retain request priority, body deletion, hash case, and mutation timestamps", () => {
  const authorization = source("vendor/nightscout/lib/authorization/index.js");
  const enclave = source("vendor/nightscout/lib/server/enclave.js");
  const storage = source("vendor/nightscout/lib/authorization/storage.js");
  const verifyauth = source("vendor/nightscout/lib/api/verifyauth.js");

  assert.ok(authorization.indexOf("req.header('Authorization')") < authorization.indexOf("req.query.token"));
  assert.match(authorization, /req\.query && req\.query\.secret \? req\.query\.secret : req\.header\('api-secret'\)/);
  assert.match(authorization, /delete req\.body\[0\]\.token/);
  assert.match(authorization, /delete req\.body\.secret/);
  assert.ok(authorization.indexOf("authorizeAdminSecret(data.api_secret)") < authorization.indexOf("verifyJWT(data.token)"));
  assert.match(enclave, /keyValue\.toLowerCase\(\) == secrets\[apiKeySHA1\] \|\| keyValue == secrets\[apiKeySHA512\]/);
  assert.match(storage, /hasOwnProperty\.call\(obj, 'created_at'\)/);
  assert.match(storage, /if \(!obj\.created_at\)/);
  assert.match(verifyauth, /permissions: result\.defaults \? 'DEFAULT' : 'ROLE'/);
  assert.match(verifyauth, /rolefound: result\.subject \? 'FOUND' : 'NOTFOUND'/);
});

test("Worker seenPermissions is exactly generated from locked static isPermitted guards", () => {
  const locked = new Set();
  for (const relativePath of lockedJavascriptFiles("vendor/nightscout/lib")) {
    for (const match of source(relativePath).matchAll(/\.isPermitted\(\s*['"]([^'"]+)['"]/g)) {
      locked.add(match[1]);
    }
  }
  const worker = source("src/index.ts");
  const registry = /const SEEN_PERMISSIONS = \[([\s\S]*?)\] as const;/.exec(worker);
  assert.ok(registry, "Worker seen-permission registry missing");
  const adapted = Array.from(
    registry[1].matchAll(/"([^"]+)"/g),
    (match) => match[1],
  );
  assert.deepEqual(adapted, [...locked].sort());
});

test("locked delay-list accumulates failures, resets elapsed entries, and clears success", () => {
  const now = { value: 1_000 };
  const delayList = loadLockedDelayList(now);
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), false);
  delayList.addFailedRequest("198.51.100.1");
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), 50);
  now.value = 1_025;
  delayList.addFailedRequest("198.51.100.1");
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), 75);
  now.value = 1_100;
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), false);
  delayList.addFailedRequest("198.51.100.1");
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), 50);
  delayList.requestSucceeded("198.51.100.1");
  assert.equal(delayList.shouldDelayRequest("198.51.100.1"), false);
});
