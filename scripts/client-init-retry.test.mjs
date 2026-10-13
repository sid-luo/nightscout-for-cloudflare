import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const clientPath = new URL("../vendor/nightscout/lib/client/index.js", import.meta.url);
const clientSource = readFileSync(clientPath, "utf8");

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

test("six offline failures issue one request per five seconds and preserve the callback", () => {
  const h = setup();
  const callback = () => {};
  h.client.init(callback);
  for (let index = 0; index < 6; index++) {
    h.requests[index].fail({ readyState: 0, status: 0 });
    assert.equal(h.requests.length, index + 1);
    assert.equal(h.timers.size, 1);
    h.advance(4999);
    assert.equal(h.requests.length, index + 1);
    h.advance(1);
    assert.equal(h.requests.length, index + 2);
    assert.equal(h.timers.size, 0);
  }
  assert.deepEqual(h.requests.map((request) => request.at), [0, 5000, 10000, 15000, 20000, 25000, 30000]);
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

test("HTTP 503 requests authentication once and retries only after its callback and delay", () => {
  const h = setup();
  const callback = () => {};
  h.client.init(callback);
  h.requests[0].fail({ readyState: 4, status: 503 });
  assert.equal(h.authentication.length, 1);
  assert.equal(h.client.settingsFailed, true);
  assert.equal(h.timers.size, 0);
  h.advance(15000);
  assert.equal(h.requests.length, 1);
  h.authentication[0]();
  h.authentication[0]();
  assert.equal(h.timers.size, 1, "repeated authentication callbacks share one retry");
  h.advance(4999);
  assert.equal(h.requests.length, 1);
  h.advance(1);
  h.requests[1].fail({ readyState: 4, status: 503 });
  assert.equal(h.authentication.length, 1);
  assert.equal(h.timers.size, 0);
  h.advance(15000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.loads.length, 0);
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
  const sourceIndex = sourceMap.sources.findIndex((source) => source.endsWith("/lib/client/index.js"));
  assert.notEqual(sourceIndex, -1);
  assert.equal(sourceMap.sourcesContent[sourceIndex], clientSource, "the generated bundle must include the current retry source");
  const digest = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
  const url = `/bundle/js/bundle.app.js?${digest}`;
  const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.ok(index.includes(`src="${url}"`));
  assert.ok(serviceWorker.includes(`'${url}'`));
  assert.ok(serviceWorker.match(/var CACHE = '([^']+)';/)[1].endsWith(`-${digest}`));
  assert.ok(!index.includes('src="/bundle/js/bundle.app.js"'));
});
