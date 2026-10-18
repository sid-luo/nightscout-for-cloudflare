import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const clientPath = new URL("../vendor/nightscout/lib/client/index.js", import.meta.url);
const clientSource = readFileSync(clientPath, "utf8");
const authPath = new URL("../vendor/nightscout/lib/client/hashauth.js", import.meta.url);

function loadRequestErrors(DateImpl = Date) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL("../vendor/nightscout/lib/client/request-errors.js", import.meta.url), "utf8"),
    { module, exports: module.exports, Date: DateImpl }, { filename: "request-errors.js" });
  return module.exports;
}

// Execute the complete shipped source module. Only browser/dependency boundaries
// are stubbed; init, its callback closures and all retry scheduling are real.
function setup({ token, secret, storedSecret, authorized } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const authentication = [];
  const loads = [];
  const messages = [];
  const module = { exports: {} };
  const language = { languages: [{ code: "en" }], set() {}, translate: (text) => text };
  const storage = { localStorage: { get: (key) => key === "apisecrethash" ? storedSecret : undefined } };
  const hashauth = {
    apisecrethash: secret,
    hash: () => "synthetic-hash",
    requestAuthentication(callback) { authentication.push(callback); },
  };
  const $ = () => ({ html(value) { messages.push(value); }, hide() {}, show() {} });
  $.ajax = (options) => {
    const request = { options, at: now };
    requests.push(request);
    return {
      done(callback) { request.succeed = callback; return this; },
      fail(callback) { request.fail = callback; return this; },
    };
  };
  const window = {
    moment: { tz: { names: () => [] } },
    setTimeout(callback, delay) {
      assert.equal(typeof callback, "function", "a retry must defer a function");
      const id = nextTimer++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const dependencies = {
    "d3": {},
    "shiro-trie": {},
    "js-storage": storage,
    "../language": () => language,
    "../sandbox": () => ({}),
    "../units": () => ({}),
    "../levels": {},
    "../times": {},
    "./receiveddata": () => {},
    "./hashauth": { init: () => hashauth },
    "./browser-utils": () => ({ queryParms: () => ({ token }) }),
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  vm.runInNewContext(clientSource, {
    module,
    global: { $, d3: {} },
    window,
    navigator: { language: "en-US" },
    console: { log() {} },
    Date: ClockDate,
    require(name) {
      if (name === "./request-errors") return loadRequestErrors(ClockDate);
      assert.ok(Object.hasOwn(dependencies, name), `unexpected client dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: clientPath.pathname });
  const client = module.exports;
  window.Nightscout = { client };
  client.authorized = authorized;
  client.loadLanguage = (settings, callback) => loads.push({ settings, callback });

  function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due;
      timers.delete(id);
      timer.callback();
    }
    now = until;
  }
  return { client, timers, requests, authentication, loads, messages, advance };
}

test("six offline failures back off to one request per minute and preserve the callback", () => {
  const h = setup();
  const callback = () => {};
  h.client.init(callback);
  const delays = [5000, 10000, 20000, 40000, 60000, 60000];
  for (let index = 0; index < delays.length; index++) {
    h.requests[index].fail({ readyState: 0, status: 0 });
    assert.equal(h.requests.length, index + 1);
    assert.equal(h.timers.size, 1);
    h.advance(delays[index] - 1);
    assert.equal(h.requests.length, index + 1);
    h.advance(1);
    assert.equal(h.requests.length, index + 2);
    assert.equal(h.timers.size, 0);
  }
  assert.deepEqual(h.requests.map((request) => request.at), [0, 5000, 15000, 35000, 75000, 135000, 195000]);
  assert.equal(h.authentication.length, 0);
  h.requests[6].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads[0].callback, callback);
  h.advance(60000);
  assert.equal(h.requests.length, 7);
});

test("server startup waits five seconds and retains the original callback", () => {
  const h = setup();
  const callback = () => {};
  h.client.init(callback);
  h.requests[0].succeed({ runtimeState: "loading" });
  h.advance(4999);
  assert.equal(h.requests.length, 1);
  assert.equal(h.loads.length, 0);
  h.advance(1);
  h.requests[1].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads[0].callback, callback);
  assert.equal(h.timers.size, 0);
});

test("read quota 503 preserves credentials, honors Retry-After and resumes without authentication", () => {
  const h = setup();
  const callback = () => {};
  h.client.hashauth.apisecrethash = "synthetic-valid-secret";
  h.client.init(callback);
  h.requests[0].fail({ readyState: 4, status: 503,
    responseJSON: { error: { code: "storage_read_quota_exceeded", message: "private upstream detail" } },
    getResponseHeader: (name) => name === "Retry-After" ? "3600" : null });
  assert.equal(h.authentication.length, 0);
  assert.equal(h.client.hashauth.apisecrethash, "synthetic-valid-secret");
  assert.equal(h.timers.size, 1);
  assert.ok(h.messages.some((message) => /storage read quota/i.test(message)));
  assert.ok(h.messages.every((message) => !message.includes("private upstream detail")));
  h.advance(3599999);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  h.requests[1].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads[0].callback, callback);
  assert.equal(h.timers.size, 0);
});

test("temporary HTTP failures back off, keep retrying and never request authentication", () => {
  const h = setup();
  h.client.init();
  const delays = [5000, 10000, 20000, 40000, 60000, 60000];
  for (let index = 0; index < delays.length; index++) {
    h.requests[index].fail({ readyState: 4, status: index % 2 ? 500 : 503 });
    assert.equal(h.timers.size, 1);
    h.advance(delays[index] - 1);
    assert.equal(h.requests.length, index + 1);
    h.advance(1);
    assert.equal(h.requests.length, index + 2);
  }
  assert.equal(h.authentication.length, 0);
  h.requests.at(-1).succeed({ runtimeState: "loaded" });
  h.client.init();
  h.requests.at(-1).fail({ readyState: 4, status: 502 });
  h.advance(5000);
  assert.equal(h.requests.at(-1).at, 200000);
});

test("403 still requests authentication and a late callback cannot create duplicate retries", () => {
  const h = setup();
  h.client.init();
  h.requests[0].fail({ readyState: 4, status: 403 });
  assert.equal(h.authentication.length, 1);
  h.authentication[0]();
  h.authentication[0]();
  assert.equal(h.timers.size, 1);
  h.advance(5000);
  h.requests[1].succeed({ runtimeState: "loaded" });
  h.authentication[0]();
  assert.equal(h.timers.size, 0);
});

test("HTTP-date Retry-After is honored and invalid or past values use bounded backoff", () => {
  for (const [header, wait] of [[new Date(90000).toUTCString(), 90000], ["invalid", 5000],
    [new Date(-1000).toUTCString(), 5000], ["0", 5000], ["-1", 5000]]) {
    const h = setup();
    h.client.init();
    h.requests[0].fail({ readyState: 4, status: 503, getResponseHeader: () => header });
    assert.equal(h.authentication.length, 0);
    h.advance(wait - 1);
    assert.equal(h.requests.length, 1);
    h.advance(1);
    assert.equal(h.requests.length, 2);
  }
});

test("quota without Retry-After waits for UTC reset and huge headers cannot overflow the browser timer", () => {
  const h = setup();
  h.client.init();
  h.requests[0].fail({ readyState: 4, status: 503,
    responseJSON: { error: { code: "storage_read_quota_exceeded" } } });
  assert.equal([...h.timers.values()][0].due, 86400000);
  h.advance(86400000);
  h.requests[1].succeed({ runtimeState: "loaded" });
  const other = setup();
  other.client.init();
  other.requests[0].fail({ readyState: 4, status: 429, getResponseHeader: () => "9999999999" });
  assert.equal([...other.timers.values()][0].due, 2147483647);
  assert.equal(other.authentication.length, 0);
});

// Exercise the real hashauth module: credentials, permissions, callbacks and
// retries share the same paths as the browser, with only HTTP/DOM stubbed.
function setupAuthentication({ deferHash = false } = {}) {
  let now = 0;
  let nextTimer = 0;
  let reloads = 0;
  const timers = new Map();
  const requests = [];
  const alerts = [];
  const messages = [];
  const digests = [];
  const stored = new Map([["apisecrethash", "synthetic-saved-digest"]]);
  const module = { exports: {} };
  const $ = () => ({ html(value) { messages.push(value); return this; }, hide() {}, show() {} });
  $.ajax = (options) => {
    const request = { options, at: now };
    requests.push(request);
    return { done(fn) { request.succeed = fn; return this; }, fail(fn) { request.fail = fn; return this; } };
  };
  const client = { translate: (text) => text,
    headers: () => client.authorized ? { Authorization: `Bearer ${client.authorized.token}` } : { "api-secret": client.hashauth.hash() },
    browserUtils: { reload: () => { reloads++; } } };
  const window = {
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, alert: (message) => alerts.push(message),
  };
  if (deferHash) window.crypto = { subtle: { digest: (_algorithm, encoded) => new Promise((resolve, reject) => {
    digests.push({ resolve, reject, encoded });
  }) } };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  vm.runInNewContext(readFileSync(authPath, "utf8"), {
    module, window, TextEncoder, Date: ClockDate, alert: window.alert, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === "js-storage") return { localStorage: { get: (key) => stored.get(key),
        set: (key, value) => stored.set(key, value), remove: (key) => stored.delete(key) } };
      if (name === "../utils/html") return { textAsHtml: (text) => text };
      if (name === "./request-errors") return loadRequestErrors(ClockDate);
      throw new Error(`unexpected authentication dependency: ${name}`);
    },
  }, { filename: authPath.pathname });
  client.hashauth = module.exports.init(client, $);
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due; timers.delete(id); timer.callback();
    }
    now = until;
  }
  return { auth: client.hashauth, client, requests, timers, alerts, messages, stored, advance, digests,
    get reloads() { return reloads; } };
}

const verifiedAdmin = { message: { message: "OK", canRead: true, canWrite: true, isAdmin: true,
  permissions: "ROLE", rolefound: "NOTFOUND" } };
const verifiedReader = { message: { message: "OK", canRead: true, canWrite: false, isAdmin: false,
  permissions: "ROLE", rolefound: "FOUND" } };

function startVerifiedSession(h, response, token = "synthetic-reader-jwt") {
  h.auth.apisecrethash = "synthetic-saved-digest";
  h.client.authorized = { token, exp: 1, iat: 0, lat: 0 };
  h.auth.verifyAuthentication(() => {});
  h.requests.at(-1).succeed(response);
  return h.client.authorized;
}

// Compile these unchanged shipped functions with only their UI/HTTP boundaries
// supplied. Their closures are nested in the full chart setup, which this
// authentication test intentionally does not initialize.
function startBackgroundRefresh(h, { queryToken } = {}) {
  const begin = clientSource.indexOf("  function refreshAuthIfNeeded () {");
  const end = clientSource.indexOf("\n  function updateClock () {", begin);
  assert.ok(begin >= 0 && end > begin);
  const requests = [];
  const $ = { ajax: (url, options) => { requests.push({ url, options }); } };
  h.client.now = 1_000_000;
  h.client.browserUtils.queryParms = () => ({ token: queryToken });
  const refresh = vm.runInNewContext(`(${clientSource.slice(begin, end)})`, {
    client: h.client, $, times: { mins: (n) => ({ msecs: n * 60000, secs: n * 60 }) },
    console: { info() {} },
  });
  refresh();
  return requests;
}

function renderPermissionActions(h) {
  const begin = clientSource.indexOf("  client.afterAuth = function afterAuth (");
  const end = clientSource.indexOf("\n  client.hashauth.initAuthentication(", begin);
  assert.ok(begin >= 0 && end > begin);
  const actions = new Map();
  const element = (name) => ({ click() { return this; }, toggle(value) { actions.set(name, value); return this; } });
  h.client.settings = { showPlugins: "careportal boluscalc", editMode: true };
  h.client.notifies = { updateAdminNotifies() {} };
  vm.runInNewContext(clientSource.slice(begin, end), { client: h.client, $: element, editButton: element("edit") });
  h.client.afterAuth(h.auth.isAuthenticated());
  return actions;
}

test("an invalid candidate is verified independently of the active JWT and cannot replace or remember it", async () => {
  for (const outcome of [401, 403, "UNAUTHORIZED", "FOUND_WITHOUT_READ"]) {
    const h = setupAuthentication();
    const jwt = startVerifiedSession(h, verifiedReader);
    const results = [];
    const secret = "synthetic-wrong-candidate-secret";
    await h.auth.processSecret(secret, true, (result) => results.push(result));
    const request = h.requests[1];
    assert.deepEqual(Object.keys(request.options.headers), ["api-secret"]);
    assert.equal(request.options.headers["api-secret"], createHash("sha1").update(secret).digest("hex"));
    assert.equal(h.auth.hash(), "synthetic-saved-digest", "an unverified candidate is never an active credential");
    assert.equal(h.client.headers().Authorization, `Bearer ${jwt.token}`);
    if (typeof outcome === "number") request.fail({ readyState: 4, status: outcome });
    else request.succeed({ message: { message: "UNAUTHORIZED", canRead: false, canWrite: false,
      isAdmin: false, permissions: "NONE", rolefound: outcome === "FOUND_WITHOUT_READ" ? "FOUND" : "NOTFOUND" } });
    assert.deepEqual(results, [false]);
    assert.equal(h.client.authorized, jwt);
    assert.equal(h.auth.hash(), "synthetic-saved-digest");
    assert.equal(h.auth.tokenauthenticated, true);
    assert.equal(h.auth.hasReadPermission, true);
    assert.equal(h.auth.hasWritePermission, false);
    assert.equal(h.auth.isAdmin, false);
    assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
    assert.equal(h.timers.size, 0);
    assert.equal(h.reloads, 0);
  }
});

test("a verified candidate switches reader JWT to admin and late background refresh cannot restore the old JWT", async () => {
  const h = setupAuthentication();
  startVerifiedSession(h, verifiedReader);
  const refresh = startBackgroundRefresh(h);
  assert.equal(refresh.length, 1);
  const results = [];
  const secret = "synthetic-verified-admin-candidate";
  await h.auth.processSecret(secret, true, (result) => results.push(result));
  assert.equal(h.auth.hasWritePermission, false);
  h.requests[1].succeed(verifiedAdmin);
  const digest = createHash("sha1").update(secret).digest("hex");
  assert.equal(h.client.authorized, null);
  assert.equal(h.client.headers()["api-secret"], digest);
  assert.equal(h.auth.isAdmin, true);
  assert.equal(h.auth.hasWritePermission, true);
  assert.equal(h.stored.get("apisecrethash"), digest);
  assert.deepEqual(results, [true]);
  refresh[0].options.success({ token: "synthetic-late-reader-refresh" });
  assert.equal(h.client.authorized, null);
  assert.equal(h.client.headers()["api-secret"], digest);
  assert.equal(renderPermissionActions(h).get("#treatmentDrawerToggle"), true);
});

test("a verified reader candidate replaces admin permissions and unchecked Remember clears the preceding stored identity", async () => {
  const h = setupAuthentication();
  startVerifiedSession(h, verifiedAdmin, "synthetic-admin-jwt");
  const results = [];
  await h.auth.processSecret("synthetic-valid-reader-candidate", false, (result) => results.push(result));
  assert.equal(h.auth.isAdmin, true, "the active admin session remains while the candidate is pending");
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  h.requests[1].succeed(verifiedReader);
  assert.deepEqual(results, [true]);
  assert.equal(h.client.authorized, null);
  assert.equal(h.auth.isAuthenticated(), true);
  assert.equal(h.auth.tokenauthenticated, true);
  assert.equal(h.auth.hasReadPermission, true);
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.auth.isAdmin, false);
  assert.equal(h.stored.has("apisecrethash"), false);
  const actions = renderPermissionActions(h);
  assert.equal(actions.get("#treatmentDrawerToggle"), false);
  assert.equal(actions.get("#boluscalcDrawerToggle"), false);
  assert.equal(actions.get("edit"), false);
  assert.equal(actions.get("#lockedToggle"), true);
});

test("candidate quota retries preserve the active session through JWT refresh and keep verifying only that candidate", async () => {
  const h = setupAuthentication();
  const jwt = startVerifiedSession(h, verifiedReader);
  const results = [];
  const secret = "synthetic-candidate-waiting-for-quota";
  await h.auth.processSecret(secret, true, (result) => results.push(result));
  const digest = createHash("sha1").update(secret).digest("hex");
  h.requests[1].fail({ readyState: 4, status: 503, getResponseHeader: () => "120",
    responseJSON: { error: { code: "storage_read_quota_exceeded", message: secret } } });
  assert.equal(h.client.authorized, jwt);
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  assert.equal(h.auth.hasReadPermission, true);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, []);
  assert.deepEqual(h.alerts, []);
  assert.ok(h.messages.every((message) => !message.includes(secret) && !message.includes(digest)));
  const refreshed = { token: "synthetic-current-reader-refresh" };
  h.client.authorized = refreshed;
  h.advance(119999);
  assert.equal(h.requests.length, 2);
  h.advance(1);
  assert.deepEqual(Object.keys(h.requests[2].options.headers), ["api-secret"]);
  assert.equal(h.requests[2].options.headers["api-secret"], digest);
  h.requests[2].succeed(verifiedAdmin);
  assert.equal(h.client.authorized, null);
  assert.equal(h.auth.hash(), digest);
  assert.equal(h.auth.isAdmin, true);
  assert.equal(h.stored.get("apisecrethash"), digest);
  assert.deepEqual(results, [true]);
  assert.equal(h.timers.size, 0);
});

test("superseded candidate responses and hashes cannot change the active session or Remember choice", async () => {
  const h = setupAuthentication({ deferHash: true });
  const jwt = startVerifiedSession(h, verifiedReader);
  const results = [];
  const old = h.auth.processSecret("synthetic-old-pending-candidate", true, (result) => results.push({ old: result }));
  const current = h.auth.processSecret("synthetic-current-pending-candidate", false, (result) => results.push({ current: result }));
  h.digests[1].resolve(Uint8Array.from(createHash("sha1").update(h.digests[1].encoded).digest()).buffer);
  await current;
  h.digests[0].resolve(Uint8Array.from(createHash("sha1").update(h.digests[0].encoded).digest()).buffer);
  await old;
  assert.equal(h.requests.length, 2);
  assert.equal(h.client.authorized, jwt);
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  h.requests[1].fail({ readyState: 4, status: 503 });
  await h.auth.processSecret("short", true, (result) => results.push({ short: result }));
  h.requests[1].succeed(verifiedAdmin);
  h.advance(60000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.client.authorized, jwt);
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, [{ short: false }]);
});

test("late candidate success or denial cannot overwrite a newer successful reader switch", async () => {
  for (const lateStatus of [200, 401, 403]) {
    const h = setupAuthentication();
    startVerifiedSession(h, verifiedAdmin, "synthetic-admin-jwt");
    const results = [];
    await h.auth.processSecret("synthetic-old-admin-candidate", true, (result) => results.push({ old: result }));
    await h.auth.processSecret("synthetic-new-reader-candidate", false, (result) => results.push({ current: result }));
    const digest = h.requests[2].options.headers["api-secret"];
    h.requests[2].succeed(verifiedReader);
    if (lateStatus === 200) h.requests[1].succeed(verifiedAdmin);
    else h.requests[1].fail({ readyState: 4, status: lateStatus });
    assert.deepEqual(results, [{ current: true }]);
    assert.equal(h.auth.hash(), digest);
    assert.equal(h.client.authorized, null);
    assert.equal(h.auth.hasReadPermission, true);
    assert.equal(h.auth.hasWritePermission, false);
    assert.equal(h.auth.isAdmin, false);
    assert.equal(h.stored.has("apisecrethash"), false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.reloads, 0);
  }
});

test("logout cancels a pending candidate retry and its late success cannot restore either identity", async () => {
  const h = setupAuthentication();
  startVerifiedSession(h, verifiedReader);
  const results = [];
  await h.auth.processSecret("synthetic-candidate-after-logout", true, (result) => results.push(result));
  h.requests[1].fail({ readyState: 4, status: 503, getResponseHeader: () => "120" });
  h.auth.removeAuthentication();
  h.requests[1].succeed(verifiedAdmin);
  h.advance(120000);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(results, []);
  assert.equal(h.auth.hash(), null);
  assert.equal(h.client.authorized, null);
  assert.equal(h.auth.isAuthenticated(), false);
  assert.equal(h.stored.has("apisecrethash"), false);
  assert.equal(h.timers.size, 0);
});

test("a JWT refresh during candidate hashing cannot become the candidate verification credential", async () => {
  const h = setupAuthentication({ deferHash: true });
  startVerifiedSession(h, verifiedReader);
  const refresh = startBackgroundRefresh(h);
  const results = [];
  const secret = "synthetic-candidate-during-crypto";
  const pending = h.auth.processSecret(secret, true, (result) => results.push(result));
  const jwt = { token: "synthetic-refreshed-during-crypto" };
  refresh[0].options.success(jwt);
  assert.equal(h.client.authorized, jwt, "a refresh of the unchanged active session can still complete");
  h.digests[0].resolve(Uint8Array.from(createHash("sha1").update(h.digests[0].encoded).digest()).buffer);
  await pending;
  assert.deepEqual(Object.keys(h.requests[1].options.headers), ["api-secret"]);
  assert.equal(h.requests[1].options.headers["api-secret"], createHash("sha1").update(secret).digest("hex"));
  h.requests[1].succeed(verifiedAdmin);
  assert.deepEqual(results, [true]);
  assert.equal(h.client.authorized, null);
  assert.equal(h.auth.hasWritePermission, true);
});

test("background refresh publishes only while its original JWT and active hash are both current", () => {
  for (const change of ["none", "jwt", "hash"]) {
    const h = setupAuthentication();
    const original = startVerifiedSession(h, verifiedReader);
    const refresh = startBackgroundRefresh(h);
    const replacement = { token: "synthetic-independent-new-jwt" };
    if (change === "jwt") h.client.authorized = replacement;
    if (change === "hash") h.auth.apisecrethash = "synthetic-independent-new-digest";
    const renewed = { token: "synthetic-refresh-result" };
    refresh[0].options.success(renewed);
    assert.equal(h.client.authorized, change === "none" ? renewed : change === "jwt" ? replacement : original);
  }
});

test("background renewal uses the active JWT ahead of a token left in the page URL", () => {
  const h = setupAuthentication();
  const jwt = startVerifiedSession(h, verifiedReader, "synthetic-current-verified-jwt");
  const refresh = startBackgroundRefresh(h, { queryToken: "synthetic-previous-url-identity" });
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].url, `/api/v2/authorization/request/${jwt.token}`);
});

test("malformed candidate verification retries without clearing the verified session or remembering its input", async () => {
  const h = setupAuthentication();
  const jwt = startVerifiedSession(h, verifiedAdmin, "synthetic-admin-jwt");
  const results = [];
  await h.auth.processSecret("synthetic-malformed-response-candidate", true, (result) => results.push(result));
  const digest = h.requests[1].options.headers["api-secret"];
  h.requests[1].succeed({});
  assert.equal(h.client.authorized, jwt);
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  assert.equal(h.auth.isAdmin, true);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, []);
  assert.deepEqual(h.alerts, []);
  h.advance(5000);
  assert.equal(h.requests[2].options.headers["api-secret"], digest);
  h.requests[2].succeed(verifiedReader);
  assert.equal(h.client.authorized, null);
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.auth.isAdmin, false);
  assert.equal(h.stored.get("apisecrethash"), digest);
  assert.deepEqual(results, [true]);
});

test("verification quota failure preserves remembered credentials and retries before completing authentication", async () => {
  const h = setupAuthentication();
  const results = [];
  await h.auth.processSecret("synthetic-secret-never-log", true, (result) => results.push(result));
  h.requests[0].fail({ readyState: 4, status: 503,
    responseJSON: { error: { code: "storage_write_quota_exceeded", message: "private upstream detail" } },
    getResponseHeader: () => "120" });
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.equal(h.auth.hash(), null, "a pending candidate is not the active credential");
  assert.equal(h.requests[0].options.headers["api-secret"], createHash("sha1").update("synthetic-secret-never-log").digest("hex"));
  assert.equal(h.auth.isAuthenticated(), false, "an outage cannot authenticate an unverified secret");
  assert.equal(h.reloads, 0);
  assert.deepEqual(results, []);
  assert.deepEqual(h.alerts, []);
  assert.ok(h.messages.some((message) => /storage write quota/i.test(message)));
  assert.ok(h.messages.every((message) => !message.includes("private upstream detail") && !message.includes("synthetic-secret-never-log")));
  h.advance(119999);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  h.requests[1].succeed(verifiedAdmin);
  assert.deepEqual(results, [true]);
  assert.equal(h.auth.isAuthenticated(), true);
  assert.equal(h.stored.get("apisecrethash"), h.auth.hash());
  assert.equal(h.timers.size, 0);
});

test("verification outages retain prior verified state but a later denial revokes all permissions", () => {
  const h = setupAuthentication();
  h.auth.apisecrethash = "synthetic-saved-digest";
  h.auth.verifyAuthentication(() => {});
  h.requests[0].succeed(verifiedAdmin);
  const results = [];
  h.auth.verifyAuthentication((result) => results.push(result));
  h.requests[1].fail({ readyState: 0, status: 0 });
  assert.equal(h.auth.isAuthenticated(), true);
  assert.equal(h.auth.isAdmin, true);
  assert.equal(h.timers.size, 1);
  h.advance(5000);
  h.requests[2].fail({ readyState: 4, status: 403 });
  assert.deepEqual(results, [false]);
  assert.equal(h.auth.isAuthenticated(), false);
  assert.equal(h.auth.tokenauthenticated, false);
  assert.equal(h.auth.hasReadPermission, false);
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.auth.isAdmin, false);
  assert.equal(h.stored.has("apisecrethash"), false);
  assert.equal(h.timers.size, 0);
});

test("verification retries and stale responses cannot restore a removed or replaced credential", () => {
  const h = setupAuthentication();
  const results = [];
  h.auth.verifyAuthentication((result) => results.push(result));
  h.requests[0].fail({ readyState: 4, status: 503 });
  assert.equal(h.timers.size, 1);
  h.auth.removeAuthentication();
  h.advance(60000);
  h.requests[0].succeed(verifiedAdmin);
  assert.equal(h.requests.length, 1);
  assert.equal(h.auth.isAuthenticated(), false);
  assert.deepEqual(results, []);
  h.auth.verifyAuthentication((result) => results.push(result));
  h.auth.verifyAuthentication((result) => results.push(result));
  h.requests[2].succeed(verifiedAdmin);
  h.requests[1].fail({ readyState: 4, status: 401 });
  assert.equal(h.auth.isAuthenticated(), true);
  assert.deepEqual(results, [true]);
});

test("successful verification refreshes reduced permissions and explicit denial remains an API secret failure", async () => {
  const h = setupAuthentication();
  h.auth.verifyAuthentication(() => {});
  h.requests[0].succeed(verifiedAdmin);
  h.auth.verifyAuthentication(() => {});
  h.requests[1].succeed({ message: { message: "OK", canRead: true, canWrite: false, isAdmin: false,
    permissions: "ROLE", rolefound: "FOUND" } });
  assert.equal(h.auth.tokenauthenticated, true);
  assert.equal(h.auth.authenticated, false);
  assert.equal(h.auth.isAdmin, false);
  assert.equal(h.auth.hasWritePermission, false);
  const results = [];
  await h.auth.processSecret("synthetic-invalid-secret", false, (result) => results.push(result));
  h.requests[2].succeed({ message: { message: "UNAUTHORIZED", rolefound: "NOTFOUND" } });
  assert.deepEqual(results, [false]);
  assert.deepEqual(h.alerts, ["Wrong API secret"]);
  assert.equal(h.auth.isAuthenticated(), true, "denying a candidate preserves the verified reader session");
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.auth.isAdmin, false);
});

test("HTTP authorization denials remain distinct from unavailable verification", async () => {
  for (const [status, expected] of [[401, "Wrong API secret"], [403, "Access denied for this secret or token"]]) {
    const h = setupAuthentication();
    const results = [];
    await h.auth.processSecret("synthetic-invalid-secret", false, (result) => results.push(result));
    h.requests[0].fail({ readyState: 4, status });
    assert.deepEqual(results, [false]);
    assert.deepEqual(h.alerts, [expected]);
    assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
    assert.equal(h.timers.size, 0);
  }
});

test("a pending replacement keeps the active verified credential without publishing the candidate", async () => {
  const h = setupAuthentication();
  h.auth.apisecrethash = "synthetic-saved-digest";
  h.auth.verifyAuthentication(() => {});
  h.requests[0].succeed(verifiedAdmin);
  await h.auth.processSecret("synthetic-replacement-secret", true, () => {});
  h.requests[1].fail({ readyState: 4, status: 503 });
  assert.equal(h.auth.isAuthenticated(), true);
  assert.equal(h.auth.isAdmin, true);
  assert.equal(h.auth.hash(), "synthetic-saved-digest");
  assert.equal(h.client.headers()["api-secret"], "synthetic-saved-digest");
  assert.notEqual(h.requests[1].options.headers["api-secret"], h.auth.hash());
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  h.advance(5000);
  h.requests[2].succeed(verifiedAdmin);
  assert.equal(h.auth.isAuthenticated(), true);
  assert.equal(h.stored.get("apisecrethash"), h.auth.hash());
});

test("malformed verification responses retry without declaring the secret wrong", () => {
  const h = setupAuthentication();
  const results = [];
  h.auth.initAuthentication((result) => results.push(result));
  h.requests[0].succeed({});
  assert.deepEqual(results, []);
  assert.deepEqual(h.alerts, []);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  h.advance(5000);
  h.requests[1].succeed(verifiedAdmin);
  assert.deepEqual(results, [true]);
});

test("a stale verification 401 cannot clear a refreshed JWT or remembered secret", () => {
  const h = setupAuthentication();
  const results = [];
  h.client.authorized = { token: "synthetic-old-jwt" };
  h.auth.verifyAuthentication((result) => results.push(result));
  const refreshed = { token: "synthetic-refreshed-jwt" };
  h.client.authorized = refreshed;
  h.requests[0].fail({ readyState: 4, status: 401 });
  assert.equal(h.client.authorized, refreshed);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, []);
  assert.equal(h.timers.size, 1);
  h.advance(4999);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  assert.equal(h.requests[1].options.headers.Authorization, "Bearer synthetic-refreshed-jwt");
  h.requests[1].succeed(verifiedAdmin);
  assert.deepEqual(results, [true]);
});

test("a stale successful verification cannot grant old permissions after JWT refresh", () => {
  const h = setupAuthentication();
  h.client.authorized = { token: "synthetic-admin-jwt" };
  h.auth.verifyAuthentication(() => {});
  h.requests[0].succeed(verifiedAdmin);
  const results = [];
  h.auth.verifyAuthentication((result) => results.push(result));
  h.client.authorized = { token: "synthetic-reader-jwt" };
  h.requests[1].succeed(verifiedAdmin);
  assert.deepEqual(results, []);
  assert.equal(h.auth.isAuthenticated(), false);
  assert.equal(h.auth.isAdmin, false);
  assert.equal(h.auth.hasWritePermission, false);
  h.advance(5000);
  h.requests[2].succeed({ message: { message: "OK", canRead: true, canWrite: false, isAdmin: false,
    permissions: "ROLE", rolefound: "FOUND" } });
  assert.deepEqual(results, [true]);
  assert.equal(h.auth.hasReadPermission, true);
  assert.equal(h.auth.hasWritePermission, false);
  assert.equal(h.auth.isAdmin, false);
});

test("repeated JWT refreshes during verification use one bounded backoff timer", () => {
  const h = setupAuthentication();
  h.client.authorized = { token: "synthetic-jwt-0" };
  h.auth.verifyAuthentication(() => {});
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000, 60000].entries()) {
    h.client.authorized = { token: `synthetic-jwt-${index + 1}` };
    h.requests[index].fail({ readyState: 4, status: 403 });
    assert.equal(h.timers.size, 1);
    h.advance(delay - 1);
    assert.equal(h.requests.length, index + 1);
    h.advance(1);
    assert.equal(h.requests.length, index + 2);
    assert.equal(h.requests[index + 1].options.headers.Authorization, `Bearer synthetic-jwt-${index + 1}`);
  }
  h.requests.at(-1).succeed(verifiedAdmin);
  assert.equal(h.timers.size, 0);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
});

test("status responses for replaced credentials cannot prompt authentication or load stale settings", () => {
  for (const status of [200, 401, 403]) {
    const h = setup({ secret: "synthetic-old-secret" });
    const callback = () => {};
    h.client.init(callback);
    h.client.hashauth.apisecrethash = "synthetic-new-secret";
    if (status === 200) h.requests[0].succeed({ runtimeState: "loaded" });
    else h.requests[0].fail({ readyState: 4, status });
    assert.equal(h.loads.length, 0);
    assert.equal(h.authentication.length, 0);
    assert.equal(h.timers.size, 1);
    h.advance(5000);
    assert.ok(h.requests[1].options.url.includes("secret=synthetic-new-secret"));
    h.requests[1].succeed({ runtimeState: "loaded" });
    assert.equal(h.loads[0].callback, callback);
  }
});

test("a locally rejected replacement cannot remember or authenticate an earlier in-flight secret", async () => {
  const h = setupAuthentication();
  const results = [];
  await h.auth.processSecret("synthetic-valid-do-not-remember", false, (result) => results.push({ attempt: "old", result }));
  await h.auth.processSecret("short", true, (result) => results.push({ attempt: "new", result }));
  h.requests[0].succeed(verifiedAdmin);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.equal(h.auth.isAuthenticated(), false);
  assert.deepEqual(results, [{ attempt: "new", result: false }]);
  assert.deepEqual(h.alerts, ["Too short API secret"]);
});

test("a locally rejected replacement cancels an earlier outage retry and preserves the saved credential", async () => {
  const h = setupAuthentication();
  const results = [];
  await h.auth.processSecret("synthetic-valid-pending-retry", false, (result) => results.push({ attempt: "old", result }));
  h.requests[0].fail({ readyState: 4, status: 503, getResponseHeader: () => "120" });
  assert.equal(h.timers.size, 1);
  await h.auth.processSecret("short", true, (result) => results.push({ attempt: "new", result }));
  assert.equal(h.timers.size, 0);
  h.advance(120000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, [{ attempt: "new", result: false }]);
});

test("remembering a verified secret uses its captured choice and digest", async () => {
  const h = setupAuthentication();
  await h.auth.processSecret("synthetic-current-remembered-secret", true, () => {});
  const sentDigest = h.requests[0].options.headers["api-secret"];
  // Public module fields can also change from another form/initialization.
  h.auth.storeapisecret = false;
  h.requests[0].succeed(verifiedAdmin);
  assert.equal(h.stored.get("apisecrethash"), sentDigest);
});

test("a short replacement also invalidates a pending WebCrypto hash before any HTTP request", async () => {
  const h = setupAuthentication({ deferHash: true });
  const results = [];
  const pending = h.auth.processSecret("synthetic-old-secret-in-crypto", false, (result) => results.push({ attempt: "old", result }));
  assert.equal(h.digests.length, 1);
  await h.auth.processSecret("short", true, (result) => results.push({ attempt: "new", result }));
  h.digests[0].resolve(Uint8Array.from(createHash("sha1").update(h.digests[0].encoded).digest()).buffer);
  await pending;
  assert.equal(h.requests.length, 0);
  assert.equal(h.stored.get("apisecrethash"), "synthetic-saved-digest");
  assert.deepEqual(results, [{ attempt: "new", result: false }]);
});

test("out-of-order WebCrypto completions authenticate only the latest submission with its own remember choice", async () => {
  const h = setupAuthentication({ deferHash: true });
  const results = [];
  const old = h.auth.processSecret("synthetic-old-crypto-submission", true, (result) => results.push({ attempt: "old", result }));
  const current = h.auth.processSecret("synthetic-current-crypto-submission", false, (result) => results.push({ attempt: "current", result }));
  h.digests[1].resolve(Uint8Array.from(createHash("sha1").update(h.digests[1].encoded).digest()).buffer);
  await current;
  h.digests[0].resolve(Uint8Array.from(createHash("sha1").update(h.digests[0].encoded).digest()).buffer);
  await old;
  assert.equal(h.requests.length, 1);
  const expectedDigest = createHash("sha1").update("synthetic-current-crypto-submission").digest("hex");
  assert.equal(h.requests[0].options.headers["api-secret"], expectedDigest);
  h.requests[0].succeed(verifiedAdmin);
  assert.equal(h.stored.has("apisecrethash"), false, "a successful unchecked switch cannot reload an older saved identity");
  assert.deepEqual(results, [{ attempt: "current", result: true }]);
});

test("authentication retry preserves callback and successful status resets first-failure state", () => {
  const h = setup();
  const callback = () => {};
  h.client.init(callback);
  h.requests[0].fail({ readyState: 4, status: 401 });
  h.authentication[0]();
  h.advance(5000);
  h.requests[1].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads[0].callback, callback);
  assert.equal(h.client.settingsFailed, false);
  h.client.init();
  h.requests[2].fail({ readyState: 4, status: 401 });
  assert.equal(h.authentication.length, 2);
});

test("overlapping initialization failures cannot accumulate timers or restore an older callback", () => {
  const h = setup();
  const oldCallback = () => {};
  const currentCallback = () => {};
  h.client.init(oldCallback);
  h.client.init(currentCallback);
  h.requests[1].fail({ readyState: 0, status: 0 });
  h.requests[0].fail({ readyState: 0, status: 0 });
  assert.equal(h.timers.size, 1);
  h.advance(5000);
  assert.equal(h.requests.length, 3);
  h.requests[2].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].callback, currentCallback);
});

test("explicit initialization replaces a pending retry and success leaves no obsolete retry", () => {
  const h = setup();
  h.client.init();
  h.requests[0].fail({ readyState: 0, status: 0 });
  assert.equal(h.timers.size, 1);
  h.advance(1000);
  h.client.init();
  assert.equal(h.timers.size, 0);
  h.requests[1].succeed({ runtimeState: "loaded" });
  h.advance(15000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.loads.length, 1);
});

test("a late failure or authentication callback cannot restart an initialization that already succeeded", () => {
  const h = setup();
  h.client.init();
  h.requests[0].fail({ readyState: 4, status: 401 });
  h.client.init();
  h.client.init();
  h.requests[2].succeed({ runtimeState: "loaded" });
  h.requests[1].fail({ readyState: 0, status: 0 });
  h.authentication[0]();
  assert.equal(h.timers.size, 0);
  assert.equal(h.loads.length, 1);
  assert.equal(h.client.settingsFailed, false);
  h.advance(15000);
  assert.equal(h.requests.length, 3);
});

test("an obsolete successful response cannot load settings or cancel the current retry", () => {
  const h = setup();
  h.client.init();
  h.client.init();
  h.requests[1].fail({ readyState: 0, status: 0 });
  h.requests[0].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads.length, 0);
  assert.equal(h.timers.size, 1);
  h.advance(5000);
  h.requests[2].succeed({ runtimeState: "loaded" });
  assert.equal(h.loads.length, 1);
});

test("retry requests re-read credentials while keeping existing secret/token/header precedence", () => {
  const h = setup({ token: "synthetic-token", storedSecret: "synthetic-stored-secret" });
  h.client.init();
  assert.equal(h.requests[0].options.url, "/api/v1/status.json?t=0&secret=synthetic-stored-secret");
  assert.equal(h.requests[0].options.headers["api-secret"], "synthetic-hash");
  h.requests[0].fail({ readyState: 0, status: 0 });
  h.client.hashauth.apisecrethash = "synthetic-new-secret";
  h.client.authorized = { token: "synthetic-bearer" };
  h.advance(5000);
  assert.equal(h.requests[1].options.url, "/api/v1/status.json?t=5000&secret=synthetic-new-secret");
  assert.equal(h.requests[1].options.headers.Authorization, "Bearer synthetic-bearer");

  const tokenOnly = setup({ token: "synthetic-token" });
  tokenOnly.client.init();
  assert.equal(tokenOnly.requests[0].options.url, "/api/v1/status.json?t=0&token=synthetic-token");
});

test("the rebuilt app bundle has matching content-versioned page and service worker URLs", () => {
  const bundle = readFileSync(new URL("../public/bundle/js/bundle.app.js", import.meta.url));
  const sourceMap = JSON.parse(readFileSync(new URL("../public/bundle/js/bundle.app.js.map", import.meta.url), "utf8"));
  for (const file of ["index.js", "hashauth.js", "request-errors.js"]) {
    const sourceIndex = sourceMap.sources.findIndex((source) => source.endsWith(`/lib/client/${file}`));
    assert.notEqual(sourceIndex, -1, `${file} must be present in the generated bundle`);
    assert.equal(sourceMap.sourcesContent[sourceIndex], readFileSync(new URL(`../vendor/nightscout/lib/client/${file}`, import.meta.url), "utf8"),
      `the generated bundle must include the current ${file} source`);
  }
  const digest = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
  const url = `/bundle/js/bundle.app.js?${digest}`;
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.ok(index.includes(`src="${url}"`));
  assert.ok(serviceWorker.includes(`'${url}'`));
  assert.ok(serviceWorker.match(/var CACHE = '([^']+)';/)[1].endsWith(`-${digest}`));
  assert.ok(!index.includes('src="/bundle/js/bundle.app.js"'));
});
