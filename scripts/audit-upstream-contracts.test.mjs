import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  REPO_ROOT,
  assertExactOverlaySet,
  assertLockedSourceHash,
  assertNoDuplicateRoutes,
  buildManifest,
  extractDynamicRouteTemplates,
  extractLiteralHttpCalls,
  extractRouteRegistrations,
  normalizePath,
  serializeManifest,
  validateManifest,
} from "./audit-upstream-contracts.mjs";

test("extracts literal and array Express routes while ignoring app settings getters", () => {
  const source = `
    const router = express.Router();
    router.use(auth.isPermitted('api:entries:read'));
    app.get('env');
    router.get(['/', '/:id'], handler);
    router.post('/items', auth.isPermitted('api:entries:create'), handler);
  `;
  const extracted = extractRouteRegistrations(source, "fixture.js");
  assert.equal(extracted.routes.length, 3);
  assert.deepEqual(extracted.routes.map((route) => route.registered_path), ["/", "/:id", "/items"]);
  assert.deepEqual(extracted.routes[0].permissions, ["api:entries:read"]);
  assert.deepEqual(extracted.routes[2].permissions, ["api:entries:create", "api:entries:read"]);
});

test("normalizes mounted paths deterministically", () => {
  assert.equal(normalizePath("/api/v2/", "/properties", "/*"), "/api/v2/properties/*");
  assert.equal(normalizePath("/api/v1", "", "/entries/"), "/api/v1/entries");
});

test("duplicate method/path pairs are rejected", () => {
  const route = {
    api_version: "v1",
    method: "GET",
    path: "/api/v1/status",
    source_file: "first.js",
  };
  assert.throws(() => assertNoDuplicateRoutes([route, { ...route, source_file: "second.js" }]), /Duplicate route/);
});

test("reviewed overlays reject additions, removals, and duplicates", () => {
  assert.doesNotThrow(() => assertExactOverlaySet("fixture", ["GET /", "POST /"], ["POST /", "GET /"]));
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /"], ["GET /", "POST /"]), /overlay drift/);
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /", "POST /"], ["GET /"]), /overlay drift/);
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /"], ["GET /", "GET /"]), /overlay drift/);
});

test("the API3 only_paths overlay equals the five locked static registrations", () => {
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, "upstream/contract-overrides.json"), "utf8"));
  const descriptor = overrides.route_modules.find((module) => module.source_file.endsWith("/api3/index.js"));
  const source = readFileSync(join(REPO_ROOT, descriptor.source_file), "utf8");
  assert.doesNotThrow(() => assertLockedSourceHash(descriptor.source_file, source, descriptor.source_sha256));
  assert.throws(
    () => assertLockedSourceHash(descriptor.source_file, `${source}\n`, descriptor.source_sha256),
    /source hash drift/,
  );
  const routes = extractRouteRegistrations(source, descriptor.source_file).routes;
  assertExactOverlaySet(
    "api3 only_paths fixture",
    descriptor.only_paths.map((path) => normalizePath(path)),
    routes.map((route) => normalizePath(route.registered_path)),
  );
  const signatures = routes.map((route) => `${route.method} ${route.registered_path}`);
  assert.deepEqual(signatures, [
    "GET /version",
    "GET /test",
    "GET /lastModified",
    "GET /status",
    "ALL /swagger-ui-dist",
  ]);
  assertExactOverlaySet("api3 only_routes fixture", descriptor.only_routes, signatures);
  assert.throws(
    () => assertExactOverlaySet(
      "api3 only_routes fixture",
      descriptor.only_routes,
      ["POST /version", ...signatures.slice(1)],
    ),
    /overlay drift/,
  );
});

test("the API3 overlay is anchored to all eight locked dynamic registrations", () => {
  const sourceFile = "vendor/nightscout/lib/api3/generic/collection.js";
  const source = readFileSync(join(REPO_ROOT, sourceFile), "utf8");
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, "upstream/contract-overrides.json"), "utf8"));
  const group = overrides.dynamic_route_groups.find((item) => item.registration_file === sourceFile);
  assert.doesNotThrow(() => assertLockedSourceHash(sourceFile, source, group.registration_sha256));
  assert.throws(() => assertLockedSourceHash(sourceFile, `${source}\n`, group.registration_sha256), /source hash drift/);
  assert.deepEqual(extractDynamicRouteTemplates(source, sourceFile), [
    {
      method: "GET",
      suffix: "",
      source_file: "vendor/nightscout/lib/api3/generic/search/operation.js",
      handler_name: "searchOperation",
      registration_line: 48,
    },
    {
      method: "POST",
      suffix: "",
      source_file: "vendor/nightscout/lib/api3/generic/create/operation.js",
      handler_name: "createOperation",
      registration_line: 51,
    },
    {
      method: "GET",
      suffix: "/history",
      source_file: "vendor/nightscout/lib/api3/generic/history/operation.js",
      handler_name: "historyOperation",
      registration_line: 54,
    },
    {
      method: "GET",
      suffix: "/history/:lastModified",
      source_file: "vendor/nightscout/lib/api3/generic/history/operation.js",
      handler_name: "historyOperation",
      registration_line: 57,
    },
    {
      method: "GET",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/read/operation.js",
      handler_name: "readOperation",
      registration_line: 60,
    },
    {
      method: "PUT",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/update/operation.js",
      handler_name: "updateOperation",
      registration_line: 63,
    },
    {
      method: "PATCH",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/patch/operation.js",
      handler_name: "patchOperation",
      registration_line: 66,
    },
    {
      method: "DELETE",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/delete/operation.js",
      handler_name: "deleteOperation",
      registration_line: 69,
    },
  ]);
  assert.throws(
    () => extractDynamicRouteTemplates(`${source}\napp.get('/unexpected', handler);\n`, sourceFile),
    /unexpected literal registrations/,
  );
  assert.throws(
    () => extractDynamicRouteTemplates(`${source}\nrouter.get(prefix, handler);\n`, sourceFile),
    /unexpected router registrations/,
  );
  for (const routerName of ["app", "router"]) {
    assert.throws(
      () => extractDynamicRouteTemplates(`${source}\n${routerName}.use(prefix, handler);\n`, sourceFile),
      /unexpected dynamic use registrations/,
    );
  }
});

test("the locked repository manifest is stable and validates all 157 test files", () => {
  const first = buildManifest();
  const second = buildManifest();
  validateManifest(first);
  assert.equal(first.routes.length, 163);
  assert.equal(first.tests.length, 157);
  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.equal(first.tests.filter((item) => item.status === "pass").length, 44);
  assert.equal(first.tests.filter((item) => item.status === "adapted").length, 90);
  assert.deepEqual(first.statistics.tests_by_status, {
    pass: 44,
    adapted: 90,
    "excluded-fixed-scope": 1,
    unresolved: 22,
  });
  for (const file of [
    "vendor/nightscout/tests/api.aaps-client.test.js",
    "vendor/nightscout/tests/ar2.test.js",
    "vendor/nightscout/tests/api.security.test.js",
    "vendor/nightscout/tests/api.verifyauth.test.js",
    "vendor/nightscout/tests/api.alexa.test.js",
    "vendor/nightscout/tests/api.activity.test.js",
    "vendor/nightscout/tests/api.devicestatus.test.js",
    "vendor/nightscout/tests/api.deduplication.test.js",
    "vendor/nightscout/tests/api.entries.test.js",
    "vendor/nightscout/tests/api.entries.uuid.test.js",
    "vendor/nightscout/tests/api.food.test.js",
    "vendor/nightscout/tests/api.id-validation.test.js",
    "vendor/nightscout/tests/api.objectid-validation.test.js",
    "vendor/nightscout/tests/api.partial-failures.test.js",
    "vendor/nightscout/tests/api.profiles.test.js",
    "vendor/nightscout/tests/profile.test.js",
    "vendor/nightscout/tests/concurrent-writes.test.js",
    "vendor/nightscout/tests/dataloader.test.js",
    "vendor/nightscout/tests/dbsize.test.js",
    "vendor/nightscout/tests/cannulaage.test.js",
    "vendor/nightscout/tests/insulinage.test.js",
    "vendor/nightscout/tests/sensorage.test.js",
    "vendor/nightscout/tests/timeago.test.js",
    "vendor/nightscout/tests/loop.test.js",
    "vendor/nightscout/tests/basalprofileplugin.test.js",
    "vendor/nightscout/tests/bootevent-debounce.test.js",
    "vendor/nightscout/tests/treatmentnotify.test.js",
    "vendor/nightscout/tests/simplealarms.test.js",
    "vendor/nightscout/tests/storage.shape-handling.test.js",
    "vendor/nightscout/tests/notifications.test.js",
    "vendor/nightscout/tests/settings.test.js",
    "vendor/nightscout/tests/security.test.js",
    "vendor/nightscout/tests/sandbox.test.js",
    "vendor/nightscout/tests/plugins.test.js",
    "vendor/nightscout/tests/api.root.test.js",
    "vendor/nightscout/tests/api.shape-handling.test.js",
    "vendor/nightscout/tests/api.status.test.js",
    "vendor/nightscout/tests/api.treatments.test.js",
    "vendor/nightscout/tests/api.unauthorized.test.js",
    "vendor/nightscout/tests/api.v1-batch-operations.test.js",
    "vendor/nightscout/tests/query.test.js",
    "vendor/nightscout/tests/language.test.js",
    "vendor/nightscout/tests/carb-dose-upload.test.js",
    "vendor/nightscout/tests/gap-treat-012.test.js",
    "vendor/nightscout/tests/objectid-cache.test.js",
    "vendor/nightscout/tests/maker.test.js",
    "vendor/nightscout/tests/pebble.test.js",
    "vendor/nightscout/tests/pushnotify.test.js",
    "vendor/nightscout/tests/pushover.test.js",
    "vendor/nightscout/tests/sgv-devicestatus.test.js",
    "vendor/nightscout/tests/api3.aaps-patterns.test.js",
    "vendor/nightscout/tests/api3.basic.test.js",
    "vendor/nightscout/tests/api3.create.test.js",
    "vendor/nightscout/tests/api3.delete.test.js",
    "vendor/nightscout/tests/api3.generic.workflow.test.js",
    "vendor/nightscout/tests/api3.patch.operation.test.js",
    "vendor/nightscout/tests/api3.patch.test.js",
    "vendor/nightscout/tests/api3.read.test.js",
    "vendor/nightscout/tests/api3.renderer.test.js",
    "vendor/nightscout/tests/api3.search.test.js",
    "vendor/nightscout/tests/api3.security.test.js",
    "vendor/nightscout/tests/api3.shape-handling.test.js",
    "vendor/nightscout/tests/api3.socket.test.js",
    "vendor/nightscout/tests/api3.storage.find.test.js",
    "vendor/nightscout/tests/api3.storage.modify.test.js",
    "vendor/nightscout/tests/api3.update.test.js",
    "vendor/nightscout/tests/notifications-api.test.js",
    "vendor/nightscout/tests/data.calcdelta.test.js",
    "vendor/nightscout/tests/ddata.test.js",
    "vendor/nightscout/tests/bgnow.test.js",
    "vendor/nightscout/tests/direction.test.js",
    "vendor/nightscout/tests/levels.test.js",
    "vendor/nightscout/tests/rawbg.test.js",
    "vendor/nightscout/tests/times.test.js",
    "vendor/nightscout/tests/units.test.js",
    "vendor/nightscout/tests/upbat.test.js",
    "vendor/nightscout/tests/websocket.shape-handling.test.js",
    "vendor/nightscout/tests/verifyauth.test.js",
  ]) {
    assert.equal(first.tests.find((item) => item.file === file)?.status, "adapted", file);
  }
  for (const file of [
    "vendor/nightscout/tests/adminnotifies.test.js",
    "vendor/nightscout/tests/admintools.modern.test.js",
    "vendor/nightscout/tests/boluswizardpreview.test.js",
    "vendor/nightscout/tests/cache-objectid-compat.test.js",
    "vendor/nightscout/tests/careportal.test.js",
    "vendor/nightscout/tests/client.renderer.test.js",
    "vendor/nightscout/tests/errorcodes.test.js",
    "vendor/nightscout/tests/env.test.js",
    "vendor/nightscout/tests/expressextensions.test.js",
    "vendor/nightscout/tests/hashauth.modern.test.js",
    "vendor/nightscout/tests/mongo-pool-config.test.js",
    "vendor/nightscout/tests/pluginbase.modern.test.js",
    "vendor/nightscout/tests/profileeditor.test.js",
    "vendor/nightscout/tests/reports.test.js",
    "vendor/nightscout/tests/reportstorage.test.js",
    "vendor/nightscout/tests/utils.test.js",
  ]) {
    assert.equal(first.tests.find((item) => item.file === file)?.status, "pass", file);
  }
  assert.deepEqual(
    first.tests
      .filter((item) => item.status === "excluded-fixed-scope")
      .map((item) => item.file),
    ["vendor/nightscout/tests/mmconnect.test.js"],
  );
  assert.equal(
    first.tests.find((item) => item.file === "vendor/nightscout/tests/bridge.test.js")?.status,
    "unresolved",
  );
});

test("default readable auth does not grant four-part admin read permissions", () => {
  const manifest = buildManifest();
  const expected = new Map([
    ["/api/v2/authorization/permissions", "admin:api:permissions:read"],
    ["/api/v2/authorization/permissions/trie", "admin:api:permissions:read"],
    ["/api/v2/authorization/subjects", "admin:api:subjects:read"],
  ]);
  for (const [path, permission] of expected) {
    const route = manifest.routes.find((item) => item.method === "GET" && item.path === path);
    assert.ok(route, path);
    assert.equal(route.auth.mode, "nightscout-permission", path);
    assert.equal(route.auth.credential_required, true, path);
    assert.deepEqual(route.auth.permissions, [permission], path);
  }

  const readable = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v1/entries");
  assert.ok(readable);
  assert.deepEqual(readable.auth.permissions, ["api:entries:read"]);
  assert.equal(readable.auth.credential_required, false);
  assert.deepEqual(manifest.policy.default_anonymous_permissions, ["*:*:read"]);
});

test("API3 PUT identifier routes record both conditional upsert permission branches", () => {
  const manifest = buildManifest();
  const routes = manifest.routes.filter((route) => (
    route.api_version === "v3"
      && route.registration_kind === "dynamic-expanded"
      && route.method === "PUT"
      && route.path.endsWith("/:identifier")
  ));
  assert.equal(routes.length, 6);
  for (const route of routes) {
    const collection = route.path.split("/")[3];
    assert.deepEqual(route.auth.permissions, [
      `api:${collection}:create`,
      `api:${collection}:update`,
    ]);
    assert.match(route.auth.note, /existing document requires .*:update/i);
    assert.match(route.auth.note, /no existing document matches .* requires .*:create/i);
  }
});

test("API3 settings search and history use the locked admin-only branches", () => {
  const searchSource = readFileSync(join(
    REPO_ROOT,
    "vendor/nightscout/lib/api3/generic/search/operation.js",
  ), "utf8");
  assert.match(
    searchSource,
    /if \(col\.colName === 'settings'\) \{\s*await security\.demandPermission\(opCtx, `api:\$\{col\.colName\}:admin`\);\s*\} else \{\s*await security\.demandPermission\(opCtx, `api:\$\{col\.colName\}:read`\);/,
  );
  assert.match(searchSource, /onlyValid = true/);
  const historySource = readFileSync(join(
    REPO_ROOT,
    "vendor/nightscout/lib/api3/generic/history/operation.js",
  ), "utf8");
  assert.match(
    historySource,
    /if \(col\.colName === 'settings'\) \{\s*await security\.demandPermission\(opCtx, `api:\$\{col\.colName\}:admin`\);\s*\} else \{\s*await security\.demandPermission\(opCtx, `api:\$\{col\.colName\}:read`\);/,
  );
  assert.match(historySource, /onlyValid = false/);

  const manifest = buildManifest();
  const findGet = (path) => manifest.routes.find((route) => (
    route.method === "GET" && route.path === path
  ));
  for (const suffix of ["", "/history", "/history/:lastModified"]) {
    const route = findGet(`/api/v3/settings${suffix}`);
    assert.ok(route, suffix);
    assert.equal(route.auth.mode, "jwt", route.path);
    assert.equal(route.auth.credential_required, true, route.path);
    assert.deepEqual(route.auth.permissions, ["api:settings:admin"], route.path);
    assert.doesNotMatch(route.auth.note, /invalid records/i, route.path);
  }
  for (const collection of ["devicestatus", "entries", "food", "profile", "treatments"]) {
    for (const suffix of ["", "/history", "/history/:lastModified"]) {
      const route = findGet(`/api/v3/${collection}${suffix}`);
      assert.ok(route, route?.path ?? `${collection}${suffix}`);
      assert.deepEqual(route.auth.permissions, [`api:${collection}:read`], route.path);
      assert.doesNotMatch(route.auth.note, /invalid records/i, route.path);
      if (suffix.startsWith("/history")) assert.match(route.auth.note, /tombstones/i, route.path);
    }
  }
  assert.deepEqual(
    findGet("/api/v3/settings/:identifier").auth.permissions,
    ["api:settings:read"],
  );
});

test("auth and condition overrides reject unknown exact route targets", () => {
  const manifest = buildManifest();
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, "upstream/contract-overrides.json"), "utf8"));
  const badAuth = structuredClone(overrides);
  badAuth.auth_overrides["v1 GET /api/v1/definitely-missing"] = {
    mode: "public",
    credential_required: false,
    permissions: [],
    note: "negative test",
  };
  assert.throws(
    () => validateManifest(manifest, badAuth),
    /Auth override targets unknown route v1 GET \/api\/v1\/definitely-missing/,
  );
  const badCondition = structuredClone(overrides);
  badCondition.condition_overrides["v1 GET /api/v1/definitely-missing"] = "negative-test";
  assert.throws(
    () => validateManifest(manifest, badCondition),
    /Condition override targets unknown route v1 GET \/api\/v1\/definitely-missing/,
  );
});

test("provenance records and validates deterministic syntactic mount chains", () => {
  const manifest = buildManifest();
  const versionRoute = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v3/version");
  assert.ok(versionRoute);
  assert.deepEqual({
    registration_file: versionRoute.registration_file,
    registration_line: versionRoute.registration_line,
    registration_anchor: versionRoute.registration_anchor,
    source_file: versionRoute.source_file,
    source_line: versionRoute.source_line,
    source_anchor: versionRoute.source_anchor,
  }, {
    registration_file: "vendor/nightscout/lib/api3/index.js",
    registration_line: 78,
    registration_anchor: "app.get('/version', require('./specific/version')(app, ctx, env));",
    source_file: "vendor/nightscout/lib/api3/specific/version.js",
    source_line: 11,
    source_anchor: "api.get('/version', async function getVersion (req, res) {",
  });
  assert.deepEqual(versionRoute.mount_chain, [{
    kind: "express-mount",
    file: "vendor/nightscout/lib/server/app.js",
    line: 294,
    mount_path: "/api/v3",
    anchor: "app.use('/api/v3', api3);",
  }]);

  const v2Entries = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v2/entries");
  assert.ok(v2Entries);
  assert.deepEqual(v2Entries.mount_chain, [
    {
      kind: "express-mount",
      file: "vendor/nightscout/lib/server/app.js",
      line: 293,
      mount_path: "/api/v2",
      anchor: "app.use('/api/v2', api2);",
    },
    {
      kind: "router-inheritance",
      file: "vendor/nightscout/lib/api2/index.js",
      line: 12,
      mount_path: "/",
      anchor: "app.use('/', apiv1);",
    },
    {
      kind: "express-mount",
      file: "vendor/nightscout/lib/api/index.js",
      line: 45,
      mount_path: "/entries*",
      anchor: "app.all('/entries*', entriesRouter);",
    },
  ]);
  const v1Entries = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v1/entries");
  assert.ok(!v1Entries.mount_chain.some((entry) => entry.file.endsWith("/api2/index.js")));
  const v2Properties = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v2/properties");
  assert.deepEqual(v2Properties.mount_chain.map(({ file, line }) => ({ file, line })), [
    { file: "vendor/nightscout/lib/server/app.js", line: 293 },
    { file: "vendor/nightscout/lib/api2/index.js", line: 13 },
  ]);

  const wrongAnchor = structuredClone(manifest);
  const wrongRoute = wrongAnchor.routes.find((item) => item.method === "GET" && item.path === "/api/v2/entries");
  wrongRoute.mount_chain[1].line = 13;
  wrongRoute.mount_chain[1].anchor = "app.use('/properties', ctx.properties);";
  assert.throws(() => validateManifest(wrongAnchor), /Mount chain mismatch/);
  const missingLink = structuredClone(manifest);
  missingLink.routes.find((item) => item.method === "GET" && item.path === "/api/v2/entries")
    .mount_chain.splice(1, 1);
  assert.throws(() => validateManifest(missingLink), /Mount chain mismatch/);
});

test("related route links are boundary-aware heuristic candidates", () => {
  const manifest = buildManifest();
  const findRoute = (path, method = "GET") => manifest.routes.find((route) => (
    route.path === path && route.method === method
  ));
  const rootVersion = findRoute("/api/versions");
  const api3Version = findRoute("/api/v3/version");
  const api3Entries = findRoute("/api/v3/entries");
  const api3Read = findRoute("/api/v3/entries/:identifier");
  const v1DeviceStatus = findRoute("/api/v1/devicestatus");
  const v2DeviceStatus = findRoute("/api/v2/devicestatus");
  assert.deepEqual(rootVersion.related_tests, ["vendor/nightscout/tests/api.root.test.js"]);
  assert.deepEqual(api3Version.related_tests, ["vendor/nightscout/tests/api3.basic.test.js"]);
  assert.ok(api3Entries.related_tests.includes("vendor/nightscout/tests/api3.search.test.js"));
  assert.deepEqual(api3Read.related_tests, ["vendor/nightscout/tests/api3.read.test.js"]);
  for (const route of [v1DeviceStatus, v2DeviceStatus]) {
    assert.ok(!route.related_tests.includes("vendor/nightscout/tests/api3.shape-handling.test.js"), route.path);
  }
  for (const route of manifest.routes.filter((item) => (
    item.api_version === "v3" && item.registration_kind !== "dynamic-expanded" && item.method === "GET"
  ))) {
    assert.ok(!route.related_tests.includes("vendor/nightscout/tests/api3.search.test.js"), route.path);
  }
  assert.match(manifest.policy.related_test_association, /heuristic candidates/i);
});

test("heuristic route candidates use path-local literal HTTP methods when available", () => {
  assert.deepEqual(extractLiteralHttpCalls(`
    request(app).post('/api/treatments/');
    request(app).get('/api/entries?count=1');
  `), [
    { method: "POST", path: "/api/treatments/" },
    { method: "GET", path: "/api/entries?count=1" },
  ]);

  const manifest = buildManifest();
  for (const file of [
    "vendor/nightscout/tests/api.partial-failures.test.js",
    "vendor/nightscout/tests/api.v1-batch-operations.test.js",
  ]) {
    const related = manifest.tests.find((item) => item.file === file).related_routes;
    assert.ok(related.length > 0, file);
    assert.deepEqual([...new Set(related.map((key) => key.split(" ")[1]))], ["POST"], file);
  }

  const shapeRoutes = new Set(manifest.tests.find((item) => (
    item.file === "vendor/nightscout/tests/api.shape-handling.test.js"
  )).related_routes);
  for (const version of ["v1", "v2"]) {
    assert.ok(shapeRoutes.has(`${version} POST /api/${version}/treatments`));
    assert.ok(!shapeRoutes.has(`${version} GET /api/${version}/treatments`));
    assert.ok(!shapeRoutes.has(`${version} PUT /api/${version}/treatments`));
    assert.ok(!shapeRoutes.has(`${version} DELETE /api/${version}/treatments`));
    for (const collection of ["food", "activity"]) {
      assert.ok(shapeRoutes.has(`${version} PUT /api/${version}/${collection}`));
      assert.ok(!shapeRoutes.has(`${version} GET /api/${version}/${collection}`));
      assert.ok(!shapeRoutes.has(`${version} POST /api/${version}/${collection}`));
      assert.ok(!shapeRoutes.has(`${version} DELETE /api/${version}/${collection}`));
    }
  }
});
