import assert from "node:assert/strict";

if (!process.argv[2]) throw new Error("Provide an explicit isolated test origin.");
const origin = process.argv[2].replace(/\/$/, "");
const tenant = `public-smoke-${Date.now()}`;
let assertions = 0;

function checked(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function endpoint(path, scoped = true) {
  const url = new URL(path, `${origin}/`);
  if (scoped) url.searchParams.set("tenant", tenant);
  return url;
}

function decodeEio3Polling(payload) {
  const packets = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const colon = payload.indexOf(":", cursor);
    checked(colon > cursor, "EIO3 length header");
    const lengthText = payload.slice(cursor, colon);
    checked(/^\d+$/.test(lengthText), "EIO3 decimal length");
    const length = Number(lengthText);
    const start = colon + 1;
    const end = start + length;
    checked(end <= payload.length, "EIO3 complete frame");
    packets.push(payload.slice(start, end));
    cursor = end;
  }
  return packets;
}

async function request(path, init = {}, scoped = true) {
  const response = await fetch(endpoint(path, scoped), init);
  checked(response.headers.get("Access-Control-Allow-Origin") === "*", `${path} CORS`);
  return response;
}

async function isolatedRequest(path, isolatedTenant, init = {}) {
  const url = new URL(path, `${origin}/`);
  url.searchParams.set("tenant", isolatedTenant);
  const response = await fetch(url, init);
  checked(response.headers.get("Access-Control-Allow-Origin") === "*", `${path} CORS`);
  return response;
}

function unwrapJsonp(body, index) {
  const head = `___eio[${index}](`;
  checked(body.startsWith(head) && body.endsWith(");"), `JSONP callback ${index}`);
  return JSON.parse(body.slice(head.length, -2));
}

class WebSocketInbox {
  constructor(socket) {
    this.messages = [];
    this.waiters = [];
    socket.addEventListener("message", (event) => {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.messages.push(event.data);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(event.data);
    });
  }

  next(timeoutMs = 5_000) {
    const queued = this.messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for public WebSocket frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

async function openWebSocket(url) {
  const socket = new WebSocket(url);
  const inbox = new WebSocketInbox(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("public WebSocket failed")), {
      once: true,
    });
  });
  return { socket, inbox };
}

const healthResponse = await request("/healthz", {}, false);
checked(healthResponse.status === 200, "health status");
equal(await healthResponse.json(), {
  status: "ok",
  upstream: "v15.0.8",
  storage: "sqlite-durable-object",
}, "health body");

const versionResponse = await request("/api/v3/version");
checked(versionResponse.status === 200, "API3 version status");
const version = await versionResponse.json();
checked(version.result?.version === "15.0.8", "Nightscout version");
checked(version.result?.apiVersion === "3.0.5", "API3 version");

const statusV1Response = await request("/api/v1/status.json");
const statusV2Response = await request("/api/v2/status.json");
checked(statusV1Response.status === 200 && statusV2Response.status === 200, "v1/v2 status");
const statusV1 = await statusV1Response.json();
const statusV2 = await statusV2Response.json();
equal(statusV1.settings, statusV2.settings, "v1/v2 settings parity");
equal(statusV1.extendedSettings, statusV2.extendedSettings, "v1/v2 extended settings parity");
checked(
  statusV1.extendedSettings?.dbsize?.max === 1_000_000_000 / (1024 * 1024),
  "Workers Free database quota mapping",
);
checked(
  !Object.hasOwn(statusV1.extendedSettings ?? {}, "upbat"),
  "UPBAT alerts remain unconfigured by default",
);

for (const [path, expected] of [
  ["/api/v1/entries.json?count=1", []],
  ["/api/v1/treatments.json?count=1", []],
  ["/api/v1/profile/current", null],
  ["/api/v1/food/quickpicks.json?count=1&find[name]=ignored", []],
  ["/api/v2/food/regular.json?count=1", []],
]) {
  const response = await request(path);
  checked(response.status === 200, `${path} status`);
  equal(await response.json(), expected, `${path} empty tenant`);
}

const treatmentEchoResponse = await request(
  "/api/v1/echo/treatments/Note.json?find[created_at][$gte]=2026-07-01T00:00:00Z&find[notes]=%2Fsmoke%2F",
);
checked(treatmentEchoResponse.status === 200, "v1 Treatment echo status");
equal(await treatmentEchoResponse.json(), {
  query: {
    created_at: { $gte: "2026-07-01T00:00:00.000Z" },
    notes: {},
    type: "Note",
  },
  input: {
    find: {
      created_at: { $gte: "2026-07-01T00:00:00Z" },
      notes: "/smoke/",
      type: "Note",
    },
  },
  params: { echo: "treatments", model: "Note" },
  storage: "treatments",
}, "v1 Treatment echo query shape");

const statusEchoResponse = await request(
  "/api/v2/echo/devicestatus/status.json?find[created_at][$gte]=2026-07-01T00:00:00Z",
);
checked(statusEchoResponse.status === 200, "v2 DeviceStatus echo status");
equal(await statusEchoResponse.json(), {
  query: { created_at: { $gte: "2026-07-01T00:00:00.000Z" }, type: "status" },
  input: { find: { created_at: { $gte: "2026-07-01T00:00:00Z" }, type: "status" } },
  params: { echo: "devicestatus", model: "status" },
  storage: "devicestatus",
}, "v2 DeviceStatus echo query shape");

for (const path of [
  "/api/v1/slice/treatments/enteredBy/note/loop-.json?count=5",
  "/api/v2/slice/devicestatus/device/status/openaps%3A%2F%2F.json?count=5",
]) {
  const response = await request(path);
  checked(response.status === 200, `${path} status`);
  equal(await response.json(), [], `${path} empty selected storage`);
}

for (const path of [
  "/api/v1/food/not-a-route",
  "/api/v2/profile/not-a-route",
  "/api/v1/profiles/current",
]) {
  const response = await request(path);
  checked(response.status === 404, `${path} remains an unknown upstream route`);
}

const pluralProfileMutation = await request("/api/v1/profiles/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ defaultProfile: "must-not-exist", store: {} }),
});
checked(pluralProfileMutation.status === 404, "plural Profile route remains read-only");

const pebbleResponse = await request("/pebble?count=2");
checked(pebbleResponse.status === 200, "Pebble status");
const pebble = await pebbleResponse.json();
checked(Array.isArray(pebble.status) && typeof pebble.status[0]?.now === "number", "Pebble clock");
equal(pebble.bgs, [], "Pebble empty-tenant SGVs");
equal(pebble.cals, [], "Pebble empty-tenant calibrations");

const ddataResponse = await request("/api/v2/ddata/at");
checked(ddataResponse.status === 200, "v2 ddata status");
const ddata = await ddataResponse.json();
checked(ddata.dbstats?.dataSize > 0, "SQLite databaseSize is published");
checked(ddata.dbstats?.indexSize === 0, "SQLite total is not double-counted");
equal(ddata.activity, [], "current ddata publishes the Activity bucket");
checked(!Object.hasOwn(ddata, "page"), "current ddata omits historical frame metadata");
equal(ddata.lastProfileFromSwitch, null, "fresh ddata has no active Profile Switch");
for (const bucket of [
  "sitechangeTreatments",
  "insulinchangeTreatments",
  "batteryTreatments",
  "sensorTreatments",
  "profileTreatments",
  "combobolusTreatments",
  "tempbasalTreatments",
  "tempTargetTreatments",
]) {
  equal(ddata[bucket], [], `fresh ddata publishes ${bucket}`);
}

const ddataFrameAt = Date.now() - 10 * 60_000;
const ddataFrameResponse = await request(`/api/v2/ddata/at/${ddataFrameAt}`);
checked(ddataFrameResponse.status === 200, "historical v2 ddata frame status");
const ddataFrame = await ddataFrameResponse.json();
equal(ddataFrame.activity, [], "historical ddata publishes the Activity bucket");
equal(
  ddataFrame.page,
  { frame: true, after: ddataFrameAt },
  "historical ddata exposes locked frame metadata",
);

const propertiesResponse = await request("/api/v2/properties/dbsize");
checked(propertiesResponse.status === 200, "dbsize property status");
const properties = await propertiesResponse.json();
checked(properties.dbsize?.details?.maxSize === 953.67, "dbsize MiB ceiling");
checked(properties.dbsize?.details?.dataSize > 0, "dbsize current bytes");
checked(properties.dbsize?.display === "0%", "dbsize display");
checked(properties.dbsize?.status === "current", "dbsize level");

const upbatResponse = await request("/api/v2/properties/upbat");
checked(upbatResponse.status === 200, "Uploader Battery property status");
const upbatProperties = await upbatResponse.json();
equal(upbatProperties.upbat, { display: "?%", devices: {} }, "empty Uploader Battery property");

const loopResponse = await request("/api/v2/properties/loop");
checked(loopResponse.status === 200, "disabled Loop property status");
equal(await loopResponse.json(), {}, "Loop remains opt-in");

const xdripJsResponse = await request("/api/v2/properties/sensorState");
checked(xdripJsResponse.status === 200, "disabled xDrip-js property status");
equal(await xdripJsResponse.json(), {}, "xDrip-js remains opt-in");

const insulinCarbResponse = await request("/api/v2/properties/iob,cob");
checked(insulinCarbResponse.status === 200, "IOB/COB property status");
const insulinCarbProperties = await insulinCarbResponse.json();

const openApsPumpResponse = await request("/api/v2/properties/openaps,pump");
checked(openApsPumpResponse.status === 200, "OpenAPS/Pump property status");
const openApsPumpProperties = await openApsPumpResponse.json();

const ageResponse = await request(
  "/api/v2/properties/cage,sage,iage,bage,timeago,runtimestate",
);
checked(ageResponse.status === 200, "age property status");
const ageProperties = await ageResponse.json();
const basalResponse = await request("/api/v2/properties/basal");
checked(basalResponse.status === 200, "basal property status");
const basalProperties = await basalResponse.json();
const enabledPlugins = Array.isArray(statusV1.settings?.enable)
  ? statusV1.settings.enable
  : [];
checked(enabledPlugins.includes("basal"), "basal remains default-enabled");
checked(enabledPlugins.includes("errorcodes"), "errorcodes remains default-enabled");
checked(enabledPlugins.includes("upbat"), "upbat remains default-enabled");
equal(basalProperties, {}, "basal does not fabricate a property without a Profile");
checked(!enabledPlugins.includes("xdripjs"), "xdripjs remains opt-in by default");
for (const plugin of ["iob", "cob"]) {
  checked(
    Object.hasOwn(insulinCarbProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
for (const plugin of ["openaps", "pump"]) {
  checked(
    Object.hasOwn(openApsPumpProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
for (const plugin of ["cage", "sage", "iage", "bage"]) {
  checked(
    Object.hasOwn(ageProperties, plugin) === enabledPlugins.includes(plugin),
    `${plugin} enabled gate`,
  );
}
checked(!Object.hasOwn(ageProperties, "timeago"), "timeago remains a client/notification plugin");
checked(enabledPlugins.includes("runtimestate"), "runtimestate remains default-enabled");
equal(ageProperties.runtimestate, { state: "loaded" }, "steady Worker runtime state");

const summaryResponse = await request("/api/v2/summary");
checked(summaryResponse.status === 200, "v2 summary status");
const summary = await summaryResponse.json();
checked(Array.isArray(summary.sgvs) && summary.sgvs.length === 0, "empty summary SGVs");
checked(summary.profile && Object.keys(summary.profile).length === 0, "empty summary profile");
checked(summary.state?.iob === null, "disabled IOB remains null in summary");
checked(summary.state?.cob === null, "disabled COB remains null in summary");
checked(
  !Object.hasOwn(summary.state ?? {}, "bage"),
  "disabled BAGE remains absent from summary",
);

const api3Unauthorized = await request("/api/v3/entries");
checked(api3Unauthorized.status === 401, "API3 missing JWT");

const treatmentWrite = await request("/api/v1/treatments", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    eventType: "Note",
    notes: "NSCF public deployment smoke only",
    created_at: new Date().toISOString(),
  }),
});
checked(
  treatmentWrite.status === 401 || treatmentWrite.status === 503,
  "anonymous mutation fails closed with or without a configured API_SECRET",
);
const treatmentError = await treatmentWrite.json();
checked(
  treatmentWrite.status === 503
    ? treatmentError.error?.code === "api_secret_not_configured"
    : treatmentError.message === "Unauthorized",
  "anonymous mutation exposes the matching failure-closed response",
);
const treatmentRead = await request("/api/v1/treatments.json?count=1");
equal(await treatmentRead.json(), [], "failed write did not persist");

const loopPushUnauthorized = await request("/api/v2/notifications/loop", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
  body: "eventType=Temporary+Override+Cancel",
});
checked(loopPushUnauthorized.status === 401, "Loop remote notification requires push permission");
const loopPushUnauthorizedBody = await loopPushUnauthorized.json();
checked(
  loopPushUnauthorizedBody.message === "Unauthorized",
  "Loop remote notification returns the locked authorization boundary",
);

const loopPushV1 = await request("/api/v1/notifications/loop", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
  body: "eventType=Temporary+Override+Cancel",
});
checked(loopPushV1.status === 404, "Loop remote notification remains v2-only");

const jsonp4Tenant = `${tenant}-jsonp4`;
const jsonp4OpenResponse = await isolatedRequest(
  "/socket.io/?EIO=4&transport=polling&j=x1y2",
  jsonp4Tenant,
);
checked(jsonp4OpenResponse.status === 200, "EIO4 JSONP handshake status");
const jsonp4Open = unwrapJsonp(await jsonp4OpenResponse.text(), "12");
checked(jsonp4Open.startsWith("0"), "EIO4 JSONP open packet");
const jsonp4 = JSON.parse(jsonp4Open.slice(1));
checked(/^[A-Za-z0-9_-]{20}$/.test(jsonp4.sid), "EIO4 JSONP SID");
equal(jsonp4.upgrades, ["websocket"], "EIO4 JSONP advertises WebSocket");
const jsonp4Post = await isolatedRequest(
  `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(jsonp4.sid)}&j=999`,
  jsonp4Tenant,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "d=40",
  },
);
checked(jsonp4Post.status === 200 && await jsonp4Post.text() === "ok", "EIO4 JSONP form POST");
const jsonp4RootResponse = await isolatedRequest(
  `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(jsonp4.sid)}`,
  jsonp4Tenant,
);
const jsonp4Root = unwrapJsonp(await jsonp4RootResponse.text(), "12");
checked(jsonp4Root.startsWith('40{"sid":"'), "EIO4 JSONP persisted callback/root");
checked(jsonp4Root.includes('42["clients",1]'), "EIO4 JSONP clients event");
await isolatedRequest(
  `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(jsonp4.sid)}`,
  jsonp4Tenant,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "d=1",
  },
);

const jsonp3Tenant = `${tenant}-jsonp3`;
const jsonp3OpenResponse = await isolatedRequest(
  "/socket.io/?EIO=3&transport=polling&j=7",
  jsonp3Tenant,
);
checked(jsonp3OpenResponse.status === 200, "EIO3 JSONP handshake status");
const jsonp3Open = decodeEio3Polling(unwrapJsonp(await jsonp3OpenResponse.text(), "7"));
checked(jsonp3Open.length === 1 && jsonp3Open[0]?.startsWith("0"), "EIO3 JSONP open packet");
const jsonp3 = JSON.parse(jsonp3Open[0].slice(1));
checked(/^[A-Za-z0-9_-]{20}$/.test(jsonp3.sid), "EIO3 JSONP SID");
const jsonp3RootResponse = await isolatedRequest(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(jsonp3.sid)}&j=321`,
  jsonp3Tenant,
);
equal(
  decodeEio3Polling(unwrapJsonp(await jsonp3RootResponse.text(), "7")),
  ["40", '42["clients",1]'],
  "EIO3 JSONP persisted callback/root",
);
const jsonp3Ping = await isolatedRequest(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(jsonp3.sid)}`,
  jsonp3Tenant,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "d=1%3A2",
  },
);
checked(jsonp3Ping.status === 200 && await jsonp3Ping.text() === "ok", "EIO3 JSONP ping POST");
const jsonp3Pong = await isolatedRequest(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(jsonp3.sid)}`,
  jsonp3Tenant,
);
equal(unwrapJsonp(await jsonp3Pong.text(), "7"), "1:3", "EIO3 JSONP pong poll");
await isolatedRequest(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(jsonp3.sid)}`,
  jsonp3Tenant,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "d=1%3A1",
  },
);

const eioResponse = await request("/socket.io/?EIO=4&transport=polling");
checked(eioResponse.status === 200, "EIO4 handshake status");
const eioText = await eioResponse.text();
checked(eioText.startsWith("0"), "EIO4 open packet");
const eio = JSON.parse(eioText.slice(1));
checked(/^[A-Za-z0-9_-]{20}$/.test(eio.sid), "EIO4 SID");
equal(eio.upgrades, ["websocket"], "EIO4 advertises the locked WebSocket upgrade");
equal([eio.pingInterval, eio.pingTimeout], [25_000, 20_000], "EIO4 heartbeat");

const pendingEioPoll = request(
  `/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(eio.sid)}`,
);
await new Promise((resolve) => setTimeout(resolve, 100));
const websocketUrl = endpoint(
  `/socket.io/?EIO=4&transport=websocket&sid=${encodeURIComponent(eio.sid)}`,
);
websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
const upgraded = await openWebSocket(websocketUrl);
upgraded.socket.send("2probe");
equal(await upgraded.inbox.next(), "3probe", "EIO4 WebSocket probe response");
const releasedEioPoll = await pendingEioPoll;
checked(releasedEioPoll.status === 200, "EIO4 upgrade releases polling request");
equal(await releasedEioPoll.text(), "6", "EIO4 upgrade polling noop");
upgraded.socket.send("5");
await new Promise((resolve) => setTimeout(resolve, 100));
upgraded.socket.send("40");
const upgradedRoot = await upgraded.inbox.next();
checked(
  typeof upgradedRoot === "string" && upgradedRoot.startsWith('40{"sid":"'),
  "EIO4 upgraded root connect",
);
equal(await upgraded.inbox.next(), '42["clients",1]', "EIO4 upgraded clients event");
upgraded.socket.close(1000, "smoke complete");

const eio3Response = await request("/socket.io/?EIO=3&transport=polling");
checked(eio3Response.status === 200, "EIO3 handshake status");
const eio3Packets = decodeEio3Polling(await eio3Response.text());
checked(eio3Packets.length === 1, "EIO3 initial open packet count");
checked(eio3Packets[0]?.startsWith("0"), "EIO3 open packet");
const eio3 = JSON.parse(eio3Packets[0].slice(1));
checked(/^[A-Za-z0-9_-]{20}$/.test(eio3.sid), "EIO3 SID");
equal(eio3.upgrades, ["websocket"], "EIO3 advertises the locked WebSocket upgrade");
equal([eio3.pingInterval, eio3.pingTimeout], [25_000, 20_000], "EIO3 heartbeat");
const eio3Root = await request(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(eio3.sid)}`,
);
checked(eio3Root.status === 200, "EIO3 root poll status");
equal(
  decodeEio3Polling(await eio3Root.text()),
  ["40", '42["clients",1]'],
  "EIO3 automatic root connect",
);

const eio3Ping = await request(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(eio3.sid)}`,
  { method: "POST", body: "1:2" },
);
checked(eio3Ping.status === 200 && await eio3Ping.text() === "ok", "EIO3 ping POST");
const eio3Pong = await request(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(eio3.sid)}`,
);
checked(eio3Pong.status === 200 && await eio3Pong.text() === "1:3", "EIO3 pong poll");

const pendingEio3Poll = request(
  `/socket.io/?EIO=3&transport=polling&sid=${encodeURIComponent(eio3.sid)}`,
);
await new Promise((resolve) => setTimeout(resolve, 100));
const eio3UpgradeUrl = endpoint(
  `/socket.io/?EIO=3&transport=websocket&sid=${encodeURIComponent(eio3.sid)}`,
);
eio3UpgradeUrl.protocol = eio3UpgradeUrl.protocol === "https:" ? "wss:" : "ws:";
const eio3Upgraded = await openWebSocket(eio3UpgradeUrl);
eio3Upgraded.socket.send("2probe");
equal(await eio3Upgraded.inbox.next(), "3probe", "EIO3 WebSocket probe response");
const releasedEio3Poll = await pendingEio3Poll;
checked(releasedEio3Poll.status === 200, "EIO3 upgrade releases polling request");
equal(await releasedEio3Poll.text(), "1:6", "EIO3 upgrade polling noop");
eio3Upgraded.socket.send("5");
await new Promise((resolve) => setTimeout(resolve, 100));
eio3Upgraded.socket.send("2");
equal(await eio3Upgraded.inbox.next(), "3", "EIO3 upgraded client heartbeat");
eio3Upgraded.socket.close(1000, "smoke complete");

const eio3DirectUrl = endpoint("/socket.io/?EIO=3&transport=websocket");
eio3DirectUrl.protocol = eio3DirectUrl.protocol === "https:" ? "wss:" : "ws:";
const eio3Direct = await openWebSocket(eio3DirectUrl);
const eio3DirectOpen = await eio3Direct.inbox.next();
checked(
  typeof eio3DirectOpen === "string" && eio3DirectOpen.startsWith('0{"sid":"'),
  "EIO3 direct WebSocket open",
);
const eio3DirectHandshake = JSON.parse(eio3DirectOpen.slice(1));
equal(eio3DirectHandshake.upgrades, [], "EIO3 direct WebSocket has no further upgrade");
equal(await eio3Direct.inbox.next(), "40", "EIO3 direct automatic root connect");
equal(await eio3Direct.inbox.next(), '42["clients",1]', "EIO3 direct clients event");
eio3Direct.socket.send("2");
equal(await eio3Direct.inbox.next(), "3", "EIO3 direct client heartbeat");
eio3Direct.socket.close(1000, "smoke complete");

process.stdout.write(`${JSON.stringify({
  origin,
  tenant,
  assertions,
  databaseBytes: ddata.dbstats.dataSize,
  dbsize: properties.dbsize,
  eio: {
    sidLength: eio.sid.length,
    upgrades: eio.upgrades,
    pingInterval: eio.pingInterval,
    pingTimeout: eio.pingTimeout,
  },
  eio3: {
    sidLength: eio3.sid.length,
    upgrades: eio3.upgrades,
    pingInterval: eio3.pingInterval,
    pingTimeout: eio3.pingTimeout,
  },
  jsonp: {
    eio4Callback: "12",
    eio3Callback: "7",
  },
})}\n`);
