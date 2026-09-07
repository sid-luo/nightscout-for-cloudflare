import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const OVERRIDES_PATH = "upstream/contract-overrides.json";
const UPSTREAM_LOCK_PATH = "upstream/manifest.json";
const MANIFEST_PATH = "upstream/contract-manifest.json";
const MARKDOWN_PATH = "docs/UPSTREAM_TEST_MANIFEST.md";
const TEST_ROOT = "vendor/nightscout/tests";
const DEFAULT_ROLE_SOURCE_PATH = "vendor/nightscout/lib/authorization/storage.js";
const KNOWN_STATUSES = new Set([
  "pass",
  "adapted",
  "excluded-fixed-scope",
  "unresolved",
]);
const VERSION_ORDER = new Map([
  ["root", 0],
  ["v1", 1],
  ["v2", 2],
  ["v3", 3],
]);
const METHOD_ORDER = new Map([
  ["GET", 0],
  ["POST", 1],
  ["PUT", 2],
  ["PATCH", 3],
  ["DELETE", 4],
  ["HEAD", 5],
  ["OPTIONS", 6],
  ["ALL", 7],
]);

function readJson(path) {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findClosingDelimiter(source, openIndex, open = "(", close = ")") {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unclosed ${open}${close} delimiter at source offset ${openIndex}`);
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function decodeStringLiteral(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) {
    const body = trimmed.slice(1, -1);
    return body
      .replaceAll("\\'", "'")
      .replaceAll('\\"', '"')
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll("\\\\", "\\");
  }
  if (trimmed.startsWith("`") && !trimmed.includes("${")) return trimmed.slice(1, -1);
  return null;
}

function parsePathArgument(argument) {
  const trimmed = argument.trim();
  const single = decodeStringLiteral(trimmed);
  if (single !== null) return [single];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const items = splitTopLevel(trimmed.slice(1, -1));
  const paths = items.map(decodeStringLiteral);
  return paths.every((path) => path !== null) ? paths : null;
}

function permissionStrings(source) {
  const permissions = [];
  const expression = /\.isPermitted\s*\(\s*(['"])(.*?)\1\s*\)/g;
  for (const match of source.matchAll(expression)) permissions.push(match[2]);
  return [...new Set(permissions)].sort();
}

function routerDefaultPermissions(source, routerName) {
  const permissions = [];
  const expression = new RegExp(`\\b${routerName.replaceAll("$", "\\$")}\\.use\\s*\\(`, "g");
  for (const match of source.matchAll(expression)) {
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findClosingDelimiter(source, openIndex);
    permissions.push(...permissionStrings(source.slice(openIndex + 1, closeIndex)));
  }
  return [...new Set(permissions)].sort();
}

export function extractRouteRegistrations(source, sourceFile = "fixture.js") {
  const routes = [];
  const dynamic = [];
  const dynamicUses = [];
  const expression = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.(get|post|put|patch|delete|head|options|all|use)\s*\(/g;

  for (const match of source.matchAll(expression)) {
    const routerName = match[1];
    const registrationMethod = match[2].toLowerCase();
    const method = registrationMethod === "use" ? "ALL" : registrationMethod.toUpperCase();
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findClosingDelimiter(source, openIndex);
    const callSource = source.slice(openIndex + 1, closeIndex);
    const argumentsList = splitTopLevel(callSource);
    if (argumentsList.length < 2) continue;
    const paths = parsePathArgument(argumentsList[0]);
    if (paths === null) {
      // Express treats use(fn, ...) as middleware on the current mount. It is
      // not emitted as a route, but callers auditing a registration-only file
      // can reject it fail-closed because the expression might be a path.
      const dynamicRegistration = {
        method,
        registration_method: registrationMethod,
        router_name: routerName,
        path_expression: argumentsList[0],
        handler_expression: argumentsList[1],
        source_file: sourceFile,
        source_line: lineNumber(source, match.index),
      };
      if (registrationMethod === "use") dynamicUses.push(dynamicRegistration);
      else dynamic.push(dynamicRegistration);
      continue;
    }
    const permissions = [
      ...routerDefaultPermissions(source, routerName),
      ...permissionStrings(callSource),
    ];
    const uniquePermissions = [...new Set(permissions)].sort();
    const requireMatch = callSource.match(/require\s*\(\s*(['"])(.*?)\1\s*\)/);
    for (const path of paths) {
      routes.push({
        method,
        registration_method: registrationMethod,
        registered_path: path,
        router_name: routerName,
        permissions: uniquePermissions,
        source_file: sourceFile,
        source_line: lineNumber(source, match.index),
        required_module: requireMatch?.[2] ?? null,
        handler_expression: argumentsList[1],
      });
    }
  }
  return { routes, dynamic, dynamicUses };
}

export function normalizePath(...parts) {
  const joined = parts
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("/")
    .replaceAll(/\/{2,}/g, "/");
  let normalized = joined.startsWith("/") ? joined : `/${joined}`;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function resolveRequiredModule(sourceFile, requiredModule) {
  if (requiredModule === null || !requiredModule.startsWith(".")) return sourceFile;
  const sourceDirectory = dirname(sourceFile);
  const base = join(sourceDirectory, requiredModule);
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    if (existsSync(join(REPO_ROOT, candidate))) return candidate;
  }
  return sourceFile;
}

function routeKey(route) {
  return `${route.api_version} ${route.method} ${route.path}`;
}

function applyRouteOverrides(routes, overrides) {
  return routes.map((route) => {
    const key = routeKey(route);
    return {
      ...route,
      auth: overrides.auth_overrides[key] ?? route.auth,
      condition: overrides.condition_overrides[key] ?? route.condition,
    };
  });
}

export function assertExactOverlaySet(label, expectedItems, actualItems) {
  const expected = [...expectedItems].sort();
  const actual = [...actualItems].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} overlay drift: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

export function assertLockedSourceHash(label, source, expectedSha256) {
  if (typeof expectedSha256 !== "string" || expectedSha256.length === 0) {
    throw new Error(`${label} requires a reviewed source_sha256 lock`);
  }
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} source hash drift: expected ${expectedSha256}, found ${actualSha256}`);
  }
}

function lineForExpressPath(source, path) {
  if (!path) return null;
  const escaped = path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `\\bapp\\.(?:use|all|get|post|put|patch|delete)\\s*\\(\\s*(['"])${escaped}(?:\\*|/\\*)?\\1`,
  );
  const match = expression.exec(source);
  return match === null ? null : lineNumber(source, match.index);
}

function moduleReference(sourceFile, targetFile) {
  let reference = relative(dirname(sourceFile), targetFile).replaceAll("\\", "/");
  reference = reference.replace(/\.js$/, "").replace(/\/index$/, "");
  if (!reference.startsWith(".")) reference = `./${reference}`;
  return reference;
}

function sourceAnchor(file, line) {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  const anchor = source.split("\n")[line - 1];
  if (anchor === undefined) throw new Error(`Cannot read source anchor ${file}:${line}`);
  return anchor.trim();
}

function mountChainEntry(kind, file, line, mountPath) {
  return {
    kind,
    file,
    line,
    mount_path: mountPath,
    anchor: sourceAnchor(file, line),
  };
}

function descriptorMountEntry(descriptor, versionPrefix, registeredPath) {
  const source = readFileSync(join(REPO_ROOT, descriptor.registered_by), "utf8");
  const candidates = [];
  if (descriptor.registered_by.endsWith("/server/app.js")) candidates.push(versionPrefix);
  if (descriptor.mount_path) candidates.push(normalizePath(descriptor.mount_path));
  const firstSegment = normalizePath(registeredPath).split("/").filter(Boolean)[0];
  if (firstSegment !== undefined) candidates.push(`/${firstSegment}`);
  for (const candidate of [...new Set(candidates)]) {
    const sourceLine = lineForExpressPath(source, candidate);
    if (sourceLine !== null) {
      const registrations = extractRouteRegistrations(source, descriptor.registered_by).routes
        .filter((route) => route.source_line === sourceLine);
      const registeredPath = registrations.length === 1
        ? registrations[0].registered_path
        : candidate;
      return mountChainEntry("express-mount", descriptor.registered_by, sourceLine, registeredPath);
    }
  }
  const reference = moduleReference(descriptor.registered_by, descriptor.source_file);
  const referenceIndex = source.indexOf(reference);
  if (referenceIndex >= 0) {
    return mountChainEntry(
      "module-reference",
      descriptor.registered_by,
      lineNumber(source, referenceIndex),
      null,
    );
  }
  throw new Error(`Cannot trace mount of ${descriptor.source_file} from ${descriptor.registered_by}`);
}

function topLevelMountEntry(apiVersion, versionPrefix) {
  const file = "vendor/nightscout/lib/server/app.js";
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  const line = lineForExpressPath(source, versionPrefix);
  if (line === null) throw new Error(`Cannot trace ${apiVersion} top-level mount ${versionPrefix}`);
  return mountChainEntry("express-mount", file, line, versionPrefix);
}

function sameMountEntry(left, right) {
  return left.file === right.file && left.line === right.line;
}

function staticMountChain(descriptor, apiVersion, versionPrefix, registeredPath) {
  const chain = [topLevelMountEntry(apiVersion, versionPrefix)];
  if (
    apiVersion === "v2"
      && descriptor.registered_by === "vendor/nightscout/lib/api/index.js"
  ) {
    const inheritanceFile = "vendor/nightscout/lib/api2/index.js";
    const inheritanceSource = readFileSync(join(REPO_ROOT, inheritanceFile), "utf8");
    const inheritanceLine = lineForExpressPath(inheritanceSource, "/");
    if (inheritanceLine === null) throw new Error("Cannot trace API v2 inheritance of API v1 router");
    chain.push(mountChainEntry(
      "router-inheritance",
      inheritanceFile,
      inheritanceLine,
      "/",
    ));
  }
  const descriptorEntry = descriptorMountEntry(descriptor, versionPrefix, registeredPath);
  if (!sameMountEntry(chain.at(-1), descriptorEntry)) chain.push(descriptorEntry);
  return chain;
}

function handlerSourceLine(route, registrationFile, sourceFile) {
  if (registrationFile === sourceFile) return route.source_line;
  const source = readFileSync(join(REPO_ROOT, sourceFile), "utf8");
  const matches = extractRouteRegistrations(source, sourceFile).routes.filter((candidate) => (
    candidate.method === route.method
      && normalizePath(candidate.registered_path) === normalizePath(route.registered_path)
  ));
  if (matches.length !== 1) {
    throw new Error(
      `Cannot trace ${route.method} ${route.registered_path} from ${registrationFile} into ${sourceFile}`,
    );
  }
  return matches[0].source_line;
}

function namedFunctionLine(sourceFile, functionName) {
  const source = readFileSync(join(REPO_ROOT, sourceFile), "utf8");
  const escaped = functionName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
  const match = expression.exec(source);
  if (match === null) throw new Error(`Cannot trace handler ${functionName} in ${sourceFile}`);
  return lineNumber(source, match.index);
}

function parseDefaultReadablePermissions() {
  const source = readFileSync(join(REPO_ROOT, DEFAULT_ROLE_SOURCE_PATH), "utf8");
  const match = source.match(/\{\s*name:\s*(['"])readable\1\s*,\s*permissions:\s*\[([^\]]*)\]/);
  if (match === null) throw new Error(`Cannot find the readable default role in ${DEFAULT_ROLE_SOURCE_PATH}`);
  const permissions = [...match[2].matchAll(/(['"])(.*?)\1/g)].map((item) => item[2]);
  assertExactOverlaySet(`${DEFAULT_ROLE_SOURCE_PATH} readable role`, ["*:*:read"], permissions);
  return permissions;
}

function permissionCovers(granted, required) {
  const grantedParts = granted.split(":");
  const requiredParts = required.split(":");
  return grantedParts.length === requiredParts.length
    && grantedParts.every((part, index) => part === "*" || part === requiredParts[index]);
}

function defaultAuth(permissions, defaultReadablePermissions) {
  if (permissions.length === 0) {
    return {
      mode: "public",
      credential_required: false,
      permissions: [],
      note: "No explicit authorization middleware is registered on this route.",
    };
  }
  const credentialRequired = permissions.some((permission) => (
    !defaultReadablePermissions.some((granted) => permissionCovers(granted, permission))
  ));
  return {
    mode: "nightscout-permission",
    credential_required: credentialRequired,
    permissions,
    note: credentialRequired
      ? "Nightscout resolves request credentials before checking these non-default permissions."
      : "Nightscout resolves request credentials and the DEFAULT read role before checking these permissions.",
  };
}

function staticRoutes(overrides, defaultReadablePermissions) {
  const output = [];
  const dynamicRisks = [];
  for (const descriptor of overrides.route_modules) {
    const source = readFileSync(join(REPO_ROOT, descriptor.source_file), "utf8");
    if (descriptor.only_paths !== undefined) {
      assertLockedSourceHash(descriptor.source_file, source, descriptor.source_sha256);
    }
    const extracted = extractRouteRegistrations(source, descriptor.source_file);
    if (descriptor.only_paths !== undefined) {
      assertExactOverlaySet(
        `${descriptor.source_file} only_paths`,
        descriptor.only_paths.map((path) => normalizePath(path)),
        extracted.routes.map((route) => normalizePath(route.registered_path)),
      );
      if (descriptor.only_routes === undefined) {
        throw new Error(`${descriptor.source_file} only_paths requires exact only_routes signatures`);
      }
      assertExactOverlaySet(
        `${descriptor.source_file} only_routes`,
        descriptor.only_routes,
        extracted.routes.map((route) => `${route.method} ${normalizePath(route.registered_path)}`),
      );
      assertExactOverlaySet(
        `${descriptor.source_file} only_paths/only_routes consistency`,
        descriptor.only_paths.map((path) => normalizePath(path)),
        descriptor.only_routes.map((signature) => normalizePath(signature.slice(signature.indexOf(" ") + 1))),
      );
    }
    const allowedPaths = descriptor.only_paths === undefined
      ? null
      : new Set(descriptor.only_paths.map((path) => normalizePath(path)));
    const accepted = extracted.routes.filter((route) => (
      allowedPaths === null || allowedPaths.has(normalizePath(route.registered_path))
    ));
    if (accepted.length === 0) {
      throw new Error(`No routes extracted from ${descriptor.source_file}`);
    }
    for (const apiVersion of descriptor.api_versions) {
      const versionPrefix = overrides.version_prefixes[apiVersion];
      if (versionPrefix === undefined) throw new Error(`Unknown API version ${apiVersion}`);
      for (const route of accepted) {
        const registrationFile = descriptor.source_file;
        const sourceFile = resolveRequiredModule(registrationFile, route.required_module);
        const sourceLine = handlerSourceLine(route, registrationFile, sourceFile);
        const registeredPath = route.registration_method === "use"
          ? normalizePath(route.registered_path, "*")
          : route.registered_path;
        const path = normalizePath(versionPrefix, descriptor.mount_path, registeredPath);
        const built = {
          api_version: apiVersion,
          method: route.method,
          path,
          registration_kind: route.registration_method === "use"
            ? "static-express-prefix"
            : "static-express",
          mount_chain: staticMountChain(
            descriptor,
            apiVersion,
            versionPrefix,
            route.registered_path,
          ),
          registration_file: registrationFile,
          registration_line: route.source_line,
          registration_anchor: sourceAnchor(registrationFile, route.source_line),
          source_file: sourceFile,
          source_line: sourceLine,
          source_anchor: sourceAnchor(sourceFile, sourceLine),
          condition: descriptor.condition ?? "always",
          auth: defaultAuth(route.permissions, defaultReadablePermissions),
          related_tests: [],
          related_tests_basis: "heuristic-candidate-linkage",
        };
        output.push(built);
      }
    }
    const routeRouterNames = new Set(extracted.routes.map((route) => route.router_name));
    for (const risk of extracted.dynamic.filter((item) => routeRouterNames.has(item.router_name))) {
      dynamicRisks.push({
        ...risk,
        disposition: "Not emitted from this module without a reviewed manual expansion.",
      });
    }
  }
  return { routes: output, dynamicRisks };
}

function parseConfiguredCollections(group) {
  const source = readFileSync(join(REPO_ROOT, group.collections_source), "utf8");
  const setting = group.collections_setting.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`app\\.set\\(\\s*['\"]${setting}['\"]\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = source.match(expression);
  if (match === null) throw new Error(`Cannot find ${group.collections_setting} in ${group.collections_source}`);
  const collections = [];
  for (const item of match[1].matchAll(/(['"])(.*?)\1/g)) collections.push(item[2]);
  if (collections.length === 0) throw new Error(`No collections found in ${group.collections_source}`);
  return collections;
}

function splitConcatenation(expression) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "+") {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts;
}

function evaluateDynamicPath(expression, definitions, stack = []) {
  return splitConcatenation(expression).map((part) => {
    const literal = decodeStringLiteral(part);
    if (literal !== null) return literal;
    if (part === "colName") return "{collection}";
    if (!definitions.has(part)) throw new Error(`Unsupported dynamic route expression ${part}`);
    if (stack.includes(part)) throw new Error(`Recursive dynamic route expression ${part}`);
    return evaluateDynamicPath(definitions.get(part), definitions, [...stack, part]);
  }).join("");
}

function dynamicTemplateKey(template) {
  return JSON.stringify([
    template.method.toUpperCase(),
    template.suffix,
    template.source_file,
  ]);
}

export function extractDynamicRouteTemplates(source, sourceFile) {
  const definitions = new Map();
  const definitionExpression = /\b(prefix(?:Id|History)?)\s*=\s*([^,\n;]+)/g;
  for (const match of source.matchAll(definitionExpression)) definitions.set(match[1], match[2].trim());

  const requiredModules = new Map();
  const requireExpression = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*(['"])(.*?)\2\s*\)/g;
  for (const match of source.matchAll(requireExpression)) {
    requiredModules.set(match[1], resolveRequiredModule(sourceFile, match[3]));
  }

  const registrations = extractRouteRegistrations(source, sourceFile);
  if (registrations.routes.length > 0) {
    throw new Error(
      `${sourceFile} dynamic overlay drift: unexpected literal registrations ${JSON.stringify(
        registrations.routes.map((route) => `${route.router_name}.${route.method} ${route.registered_path}`),
      )}`,
    );
  }
  const unexpectedDynamic = registrations.dynamic.filter((route) => route.router_name !== "app");
  if (unexpectedDynamic.length > 0) {
    throw new Error(
      `${sourceFile} dynamic overlay drift: unexpected router registrations ${JSON.stringify(
        unexpectedDynamic.map((route) => `${route.router_name}.${route.method} ${route.path_expression}`),
      )}`,
    );
  }
  if (registrations.dynamicUses.length > 0) {
    throw new Error(
      `${sourceFile} dynamic overlay drift: unexpected dynamic use registrations ${JSON.stringify(
        registrations.dynamicUses.map((route) => `${route.router_name}.use ${route.path_expression}`),
      )}`,
    );
  }

  return registrations.dynamic
    .filter((route) => route.router_name === "app")
    .map((route) => {
      const fullPath = evaluateDynamicPath(route.path_expression, definitions);
      const collectionPrefix = "/{collection}";
      if (!fullPath.startsWith(collectionPrefix)) {
        throw new Error(`Dynamic route does not start with ${collectionPrefix}: ${fullPath}`);
      }
      const handlerMatch = route.handler_expression.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      if (handlerMatch === null || !requiredModules.has(handlerMatch[1])) {
        throw new Error(`Cannot trace dynamic handler ${route.handler_expression} in ${sourceFile}`);
      }
      return {
        method: route.method,
        suffix: fullPath.slice(collectionPrefix.length),
        source_file: requiredModules.get(handlerMatch[1]),
        handler_name: handlerMatch[1],
        registration_line: route.source_line,
      };
    });
}

function dynamicRoutes(overrides) {
  const routes = [];
  const risks = [];
  for (const group of overrides.dynamic_route_groups) {
    const collections = parseConfiguredCollections(group);
    const versionPrefix = overrides.version_prefixes[group.api_version];
    const collectionsSource = readFileSync(join(REPO_ROOT, group.collections_source), "utf8");
    const mountIndex = collectionsSource.indexOf("genericSetup(ctx, env, app)");
    if (mountIndex < 0) throw new Error(`Cannot trace generic route setup in ${group.collections_source}`);
    const mountLine = lineNumber(collectionsSource, mountIndex);
    const mountChain = [
      topLevelMountEntry(group.api_version, versionPrefix),
      mountChainEntry(
        "router-setup",
        group.collections_source,
        mountLine,
        "/{collection}",
      ),
    ];
    const registrationSource = readFileSync(join(REPO_ROOT, group.registration_file), "utf8");
    assertLockedSourceHash(group.registration_file, registrationSource, group.registration_sha256);
    const sourceTemplates = extractDynamicRouteTemplates(registrationSource, group.registration_file);
    assertExactOverlaySet(
      `${group.name} dynamic templates`,
      group.routes.map((template) => dynamicTemplateKey({
        method: template.method,
        suffix: template.suffix,
        source_file: template.source_file,
      })),
      sourceTemplates.map(dynamicTemplateKey),
    );
    const sourceTemplateByKey = new Map(sourceTemplates.map((template) => [dynamicTemplateKey(template), template]));
    for (const collection of collections) {
      for (const template of group.routes) {
        const templateKey = dynamicTemplateKey(template);
        const sourceTemplate = sourceTemplateByKey.get(templateKey);
        const permissionTemplates = template.permissions ?? [template.permission];
        if (permissionTemplates.some((permission) => typeof permission !== "string")) {
          throw new Error(`Missing permission overlay for ${group.name} ${template.method} ${template.suffix}`);
        }
        const permissions = permissionTemplates
          .map((permission) => permission.replaceAll("{collection}", collection))
          .sort();
        const note = template.auth_note?.replaceAll("{collection}", collection)
          ?? "API v3 authenticates the JWT before checking the collection permission.";
        const sourceLine = namedFunctionLine(template.source_file, sourceTemplate.handler_name);
        routes.push({
          api_version: group.api_version,
          method: template.method,
          path: normalizePath(versionPrefix, collection, template.suffix),
          registration_kind: "dynamic-expanded",
          mount_chain: mountChain,
          registration_file: group.registration_file,
          registration_line: sourceTemplate.registration_line,
          registration_anchor: sourceAnchor(group.registration_file, sourceTemplate.registration_line),
          source_file: template.source_file,
          source_line: sourceLine,
          source_anchor: sourceAnchor(template.source_file, sourceLine),
          condition: "collection-enabled",
          auth: {
            mode: "jwt",
            credential_required: true,
            permissions,
            note,
          },
          related_tests: [],
          related_tests_basis: "heuristic-candidate-linkage",
        });
      }
    }
    risks.push({
      name: group.name,
      collections,
      route_templates: group.routes.length,
      source_route_templates: sourceTemplates.length,
      expanded_routes: collections.length * group.routes.length,
      risk: group.risk,
      sources: [group.collections_source, group.registration_file],
    });
  }
  return { routes, risks };
}

function listFilesRecursively(directory) {
  const absolute = join(REPO_ROOT, directory);
  const files = [];
  for (const name of readdirSync(absolute).sort()) {
    const path = join(absolute, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFilesRecursively(relative(REPO_ROOT, path)));
    } else {
      files.push(relative(REPO_ROOT, path));
    }
  }
  return files;
}

function workstreamFor(testFile) {
  const name = testFile.split("/").at(-1).toLowerCase();
  if (/websocket|socket/.test(name)) return "6-realtime";
  if (/api3\.|api3-/.test(name)) return "5-api-v3";
  if (/hashauth|verifyauth|security|identity-matrix/.test(name)) return "2-authorization";
  if (/mongo|storage|query|objectid|uuid|concurrent|deduplication|partial-failures|cache-objectid/.test(name)) {
    return "1-storage-foundation";
  }
  if (/^api\./.test(name)) return "3-api-v1-v2";
  if (/bridge|mmconnect|maker|pushnotify|pushover|notification|bootevent|flakiness|production-safety/.test(name)) {
    return "7-background-and-integrations";
  }
  if (/report|client|profileeditor|language|settings|sandbox|env\./.test(name)) {
    return "8-ui-and-process-boundaries";
  }
  return "4-plugins-and-calculations";
}

function dependencyFor(workstream) {
  const dependencies = {
    "1-storage-foundation": [],
    "2-authorization": ["1-storage-foundation"],
    "3-api-v1-v2": ["1-storage-foundation", "2-authorization"],
    "4-plugins-and-calculations": ["1-storage-foundation"],
    "5-api-v3": ["1-storage-foundation", "2-authorization", "3-api-v1-v2"],
    "6-realtime": ["1-storage-foundation", "2-authorization", "5-api-v3"],
    "7-background-and-integrations": ["1-storage-foundation", "4-plugins-and-calculations"],
    "8-ui-and-process-boundaries": ["3-api-v1-v2", "4-plugins-and-calculations", "6-realtime"],
  };
  return dependencies[workstream];
}

function routeNeedles(route) {
  if (route.registration_kind === "dynamic-expanded" && route.path.includes("/:")) return [];
  const withoutParameters = route.path
    .replaceAll(/\/:([^/]+)/g, "")
    .replaceAll("/*", "")
    .replace(/\/$/, "");
  const needles = new Set([withoutParameters]);
  if (route.api_version === "v3") return [...needles].filter((needle) => needle.length >= 4);
  for (const prefix of ["/api/v1", "/api/v2", "/api/v3"]) {
    if (withoutParameters.startsWith(prefix)) {
      const suffix = withoutParameters.slice(prefix.length) || "/";
      needles.add(suffix);
      if (prefix === "/api/v1" || prefix === "/api/v2") needles.add(`/api${suffix}`);
    }
  }
  return [...needles].filter((needle) => needle.length >= 4);
}

function operationTestHints(route) {
  if (route.api_version !== "v3" || route.registration_kind !== "dynamic-expanded") return [];
  if (route.path.includes("/history")) return ["api3.generic.workflow", "api3.storage.find"];
  if (route.path.includes(":")) {
    if (route.method === "GET") return ["api3.read"];
    if (route.method === "PUT") return ["api3.update"];
    if (route.method === "PATCH") return ["api3.patch"];
    if (route.method === "DELETE") return ["api3.delete"];
  }
  if (route.method === "GET") return ["api3.search"];
  if (route.method === "POST") return ["api3.create"];
  return [];
}

function contentHasRouteNeedle(content, needle) {
  const escaped = needle.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_/-])${escaped}/?(?![A-Za-z0-9_/-])`, "i").test(content);
}

export function extractLiteralHttpCalls(content) {
  const calls = [];
  const expression = /\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`\r\n]*?)\2/gi;
  for (const match of content.matchAll(expression)) {
    calls.push({ method: match[1].toUpperCase(), path: match[3].toLowerCase() });
  }
  return calls;
}

function sourceTextMatchesRoute(content, literalHttpCalls, route, needles) {
  const matchingCalls = literalHttpCalls.filter((call) => (
    needles.some((needle) => contentHasRouteNeedle(call.path, needle))
  ));
  if (matchingCalls.length > 0) {
    return route.method === "ALL"
      || matchingCalls.some((call) => call.method === route.method);
  }
  return needles.some((needle) => contentHasRouteNeedle(content, needle));
}

function associateTests(routes, testFiles) {
  const testSources = new Map(testFiles.map((testFile) => {
    const content = readFileSync(join(REPO_ROOT, testFile), "utf8").toLowerCase();
    return [testFile, { content, literalHttpCalls: extractLiteralHttpCalls(content) }];
  }));
  for (const route of routes) {
    const needles = routeNeedles(route).map((needle) => needle.toLowerCase());
    const hints = operationTestHints(route);
    route.related_tests = testFiles.filter((testFile) => {
      const { content, literalHttpCalls } = testSources.get(testFile);
      const basename = testFile.split("/").at(-1).toLowerCase();
      return sourceTextMatchesRoute(content, literalHttpCalls, route, needles)
        || hints.some((hint) => basename.includes(hint));
    });
  }
}

function buildTests(overrides, routes) {
  const testFiles = listFilesRecursively(TEST_ROOT)
    .filter((path) => path.endsWith(".test.js"))
    .sort();
  associateTests(routes, testFiles);
  const reverseRoutes = new Map(testFiles.map((testFile) => [testFile, []]));
  for (const route of routes) {
    for (const testFile of route.related_tests) reverseRoutes.get(testFile).push(routeKey(route));
  }
  return testFiles.map((testFile) => {
    const override = overrides.test_status_overrides[testFile] ?? overrides.test_defaults;
    const workstream = workstreamFor(testFile);
    return {
      file: testFile,
      status: override.status,
      reason: override.reason,
      workstream,
      depends_on: dependencyFor(workstream),
      related_routes: reverseRoutes.get(testFile).sort(),
      related_routes_basis: "heuristic-candidate-linkage",
    };
  });
}

function countBy(items, keyFunction) {
  const output = {};
  for (const item of items) {
    const key = keyFunction(item);
    output[key] = (output[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => compareStrings(a, b)));
}

function countTestStatuses(tests) {
  const counts = Object.fromEntries([...KNOWN_STATUSES].map((status) => [status, 0]));
  for (const test of tests) counts[test.status] += 1;
  return counts;
}

function inputDigest(paths) {
  const digest = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(readFileSync(join(REPO_ROOT, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRoutes(left, right) {
  return (VERSION_ORDER.get(left.api_version) - VERSION_ORDER.get(right.api_version))
    || compareStrings(left.path, right.path)
    || (METHOD_ORDER.get(left.method) - METHOD_ORDER.get(right.method))
    || compareStrings(left.source_file, right.source_file);
}

export function assertNoDuplicateRoutes(routes) {
  const seen = new Map();
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) {
      throw new Error(`Duplicate route ${key}: ${seen.get(key)} and ${route.source_file}`);
    }
    seen.set(key, route.source_file);
  }
}

function validateSourceLocation(file, line, label) {
  const absolute = join(REPO_ROOT, file);
  if (!existsSync(absolute)) throw new Error(`Missing ${label} source ${file}`);
  if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid ${label} line ${line} for ${file}`);
  const lineCount = readFileSync(absolute, "utf8").split("\n").length;
  if (line > lineCount) throw new Error(`${label} line ${line} exceeds ${file} line count ${lineCount}`);
}

function validateExactSourceAnchor(file, line, anchor, label) {
  validateSourceLocation(file, line, label);
  const actual = sourceAnchor(file, line);
  if (anchor !== actual) {
    throw new Error(`${label} anchor mismatch at ${file}:${line}`);
  }
}

function expectedStaticMountChain(route, overrides) {
  const descriptors = overrides.route_modules.filter((descriptor) => (
    descriptor.api_versions.includes(route.api_version)
      && descriptor.source_file === route.registration_file
  ));
  if (descriptors.length !== 1) {
    throw new Error(`Cannot resolve one static route descriptor for ${routeKey(route)}`);
  }
  const descriptor = descriptors[0];
  const versionPrefix = overrides.version_prefixes[route.api_version];
  const source = readFileSync(join(REPO_ROOT, descriptor.source_file), "utf8");
  const registrations = extractRouteRegistrations(source, descriptor.source_file).routes.filter((registration) => {
    const registeredPath = registration.registration_method === "use"
      ? normalizePath(registration.registered_path, "*")
      : registration.registered_path;
    return registration.method === route.method
      && registration.source_line === route.registration_line
      && normalizePath(versionPrefix, descriptor.mount_path, registeredPath) === route.path;
  });
  if (registrations.length !== 1) {
    throw new Error(`Cannot resolve one static registration for ${routeKey(route)}`);
  }
  return staticMountChain(
    descriptor,
    route.api_version,
    versionPrefix,
    registrations[0].registered_path,
  );
}

function expectedDynamicMountChain(route, overrides) {
  const groups = overrides.dynamic_route_groups.filter((group) => (
    group.api_version === route.api_version
      && group.registration_file === route.registration_file
  ));
  if (groups.length !== 1) {
    throw new Error(`Cannot resolve one dynamic route group for ${routeKey(route)}`);
  }
  const group = groups[0];
  const versionPrefix = overrides.version_prefixes[group.api_version];
  const source = readFileSync(join(REPO_ROOT, group.collections_source), "utf8");
  const setupIndex = source.indexOf("genericSetup(ctx, env, app)");
  if (setupIndex < 0) throw new Error(`Cannot trace generic route setup in ${group.collections_source}`);
  return [
    topLevelMountEntry(group.api_version, versionPrefix),
    mountChainEntry(
      "router-setup",
      group.collections_source,
      lineNumber(source, setupIndex),
      "/{collection}",
    ),
  ];
}

function expectedMountChain(route, overrides) {
  if (route.registration_kind === "dynamic-expanded") {
    return expectedDynamicMountChain(route, overrides);
  }
  return expectedStaticMountChain(route, overrides);
}

export function validateManifest(manifest, overrides = readJson(OVERRIDES_PATH)) {
  if (manifest.tests.length !== overrides.expected_test_count) {
    throw new Error(`Expected ${overrides.expected_test_count} tests, found ${manifest.tests.length}`);
  }
  assertNoDuplicateRoutes(manifest.routes);
  if (manifest.unexpanded_dynamic_registrations.length > 0) {
    throw new Error("Unexpanded dynamic route registrations require a reviewed manual override");
  }
  const sortedRoutes = [...manifest.routes].sort(compareRoutes);
  if (JSON.stringify(sortedRoutes) !== JSON.stringify(manifest.routes)) {
    throw new Error("Routes are not in deterministic order");
  }
  const sortedTests = [...manifest.tests].sort((left, right) => (
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  ));
  if (JSON.stringify(sortedTests) !== JSON.stringify(manifest.tests)) {
    throw new Error("Tests are not in deterministic order");
  }
  for (const route of manifest.routes) {
    if (!Array.isArray(route.mount_chain) || route.mount_chain.length === 0) {
      throw new Error(`Missing mount chain for ${routeKey(route)}`);
    }
    for (const [index, entry] of route.mount_chain.entries()) {
      validateExactSourceAnchor(
        entry.file,
        entry.line,
        entry.anchor,
        `route mount chain ${index} for ${routeKey(route)}`,
      );
    }
    const expectedChain = expectedMountChain(route, overrides);
    if (JSON.stringify(route.mount_chain) !== JSON.stringify(expectedChain)) {
      throw new Error(`Mount chain mismatch for ${routeKey(route)}`);
    }
    validateExactSourceAnchor(
      route.registration_file,
      route.registration_line,
      route.registration_anchor,
      `route registration for ${routeKey(route)}`,
    );
    validateExactSourceAnchor(
      route.source_file,
      route.source_line,
      route.source_anchor,
      `route handler for ${routeKey(route)}`,
    );
    if (route.related_tests_basis !== "heuristic-candidate-linkage") {
      throw new Error(`Unknown related test basis for ${routeKey(route)}`);
    }
  }
  for (const test of manifest.tests) {
    if (!KNOWN_STATUSES.has(test.status)) throw new Error(`Unknown status ${test.status} for ${test.file}`);
    if (test.reason.trim().length === 0) throw new Error(`Missing reason for ${test.file}`);
    if (!existsSync(join(REPO_ROOT, test.file))) throw new Error(`Missing test file ${test.file}`);
    if (test.related_routes_basis !== "heuristic-candidate-linkage") {
      throw new Error(`Unknown related route basis for ${test.file}`);
    }
  }
  if (manifest.statistics.route_count !== manifest.routes.length) {
    throw new Error("Route statistics do not match the route inventory");
  }
  for (const status of KNOWN_STATUSES) {
    const actual = manifest.tests.filter((test) => test.status === status).length;
    if (manifest.statistics.tests_by_status[status] !== actual) {
      throw new Error(`Status statistics do not match for ${status}`);
    }
  }
  const testNames = new Set(manifest.tests.map((test) => test.file));
  for (const overridden of Object.keys(overrides.test_status_overrides)) {
    if (!testNames.has(overridden)) throw new Error(`Status override targets unknown test ${overridden}`);
  }
  const routeNames = new Set(manifest.routes.map(routeKey));
  for (const overridden of Object.keys(overrides.auth_overrides)) {
    if (!routeNames.has(overridden)) throw new Error(`Auth override targets unknown route ${overridden}`);
  }
  for (const overridden of Object.keys(overrides.condition_overrides)) {
    if (!routeNames.has(overridden)) throw new Error(`Condition override targets unknown route ${overridden}`);
  }
  return manifest;
}

export function buildManifest() {
  const overrides = readJson(OVERRIDES_PATH);
  const upstream = readJson(UPSTREAM_LOCK_PATH);
  const defaultReadablePermissions = parseDefaultReadablePermissions();
  const staticResult = staticRoutes(overrides, defaultReadablePermissions);
  const dynamicResult = dynamicRoutes(overrides);
  const routes = applyRouteOverrides(
    [...staticResult.routes, ...dynamicResult.routes],
    overrides,
  ).sort(compareRoutes);
  const tests = buildTests(overrides, routes);
  const inputPaths = [
    "scripts/audit-upstream-contracts.mjs",
    OVERRIDES_PATH,
    UPSTREAM_LOCK_PATH,
    DEFAULT_ROLE_SOURCE_PATH,
    ...overrides.route_modules.flatMap((module) => [module.source_file, module.registered_by]),
    ...overrides.dynamic_route_groups.flatMap((group) => [
      group.collections_source,
      group.registration_file,
      ...group.routes.map((route) => route.source_file),
    ]),
    ...routes.flatMap((route) => [
      ...route.mount_chain.map((entry) => entry.file),
      route.registration_file,
      route.source_file,
    ]),
    ...tests.map((test) => test.file),
  ];
  const manifest = {
    schema_version: 3,
    generated_by: "scripts/audit-upstream-contracts.mjs",
    baseline: {
      project: upstream.project,
      release: upstream.release,
      commit: upstream.commit,
      vendor_path: upstream.vendor_path,
    },
    policy: {
      pass_definition: "pass means the complete upstream test file runs unchanged and passes against NSCF",
      adapted_definition: "adapted means every contract in the upstream file is represented by a named passing Workers-runtime adapter test",
      default_status: overrides.test_defaults.status,
      default_anonymous_permissions: defaultReadablePermissions,
      fixed_scope: "Only mmconnect.test.js is excluded-fixed-scope because the MiniMed CareLink integration is outside this port's fixed platform scope. Fully mocked integration contracts, including the legacy bridge.test.js contract, remain required implementation work unless completely adapted.",
      route_method_scope: "The manifest records explicit Express registrations. Express-derived HEAD/OPTIONS behavior and extension middleware variants are not expanded into duplicate rows.",
      provenance_scope: "mount_chain is a deterministic, locked-source syntactic assembly chain whose exact line anchors are re-derived during validation. registration/source fields are exact local source anchors. These fields do not prove runtime reachability, middleware order, handler execution, or test coverage; dynamic API3 chains stop at the genericSetup call.",
      related_test_association: "Route-to-test links are boundary-aware heuristic candidates. Literal HTTP calls are filtered by their path-local method when statically visible; dynamic paths, plain-text references, prefix ambiguity, and API3 operation filename hints remain heuristic. Links are not pass, adapted, or coverage evidence and require human confirmation.",
    },
    inputs_sha256: inputDigest(inputPaths),
    statistics: {
      route_count: routes.length,
      routes_by_version: countBy(routes, (route) => route.api_version),
      routes_by_method: countBy(routes, (route) => route.method),
      test_file_count: tests.length,
      tests_by_status: countTestStatuses(tests),
      tests_by_workstream: countBy(tests, (test) => test.workstream),
    },
    dynamic_route_risks: dynamicResult.risks,
    unexpanded_dynamic_registrations: staticResult.dynamicRisks,
    routes,
    tests,
  };
  return validateManifest(manifest, overrides);
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(manifest) {
  const lines = [
    "# Upstream test manifest",
    "",
    "> Generated by `npm run upstream:audit`. Do not edit this file by hand; edit `upstream/contract-overrides.json` or the generator instead.",
    "",
    `Locked upstream: \`${manifest.baseline.project}\` ${manifest.baseline.release} at \`${manifest.baseline.commit}\`.`,
    "",
    "## Audit summary",
    "",
    `- Routes: ${manifest.statistics.route_count} (${Object.entries(manifest.statistics.routes_by_version).map(([key, value]) => `${key}: ${value}`).join(", ")})`,
    `- Upstream test files: ${manifest.statistics.test_file_count}`,
    `- Statuses: ${Object.entries(manifest.statistics.tests_by_status).map(([key, value]) => `${key}: ${value}`).join(", ")}`,
    `- Input fingerprint: \`${manifest.inputs_sha256}\``,
    "",
    "`pass` is intentionally strict: the whole upstream file must run unchanged. `adapted` requires every contract in that file to be represented by named passing Workers-runtime tests. A partial local implementation therefore remains `unresolved`.",
    "",
    "The only fixed-scope exclusion is the MiniMed CareLink integration (`mmconnect.test.js`). Fully mocked integration contracts, including the legacy `bridge.test.js` contract, remain required implementation work even when a modern replacement exists.",
    "",
    "## Dependency-ordered workstreams",
    "",
    "| Workstream | Depends on | Files | Unresolved | Fixed-scope excluded |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const workstreams = [...new Set(manifest.tests.map((test) => test.workstream))].sort();
  for (const workstream of workstreams) {
    const tests = manifest.tests.filter((test) => test.workstream === workstream);
    const dependencies = tests[0].depends_on.join(", ") || "none";
    lines.push(`| ${workstream} | ${dependencies} | ${tests.length} | ${tests.filter((test) => test.status === "unresolved").length} | ${tests.filter((test) => test.status === "excluded-fixed-scope").length} |`);
  }
  lines.push(
    "",
    "Dispatch work in numeric order. Within a workstream, use each test's `related_routes` in `upstream/contract-manifest.json` only as heuristic candidate links for grouping implementation slices; confirm each link against upstream source before claiming coverage.",
    "",
    "## Dynamic route risk",
    "",
  );
  for (const risk of manifest.dynamic_route_risks) {
    lines.push(`- **${risk.name}:** ${risk.expanded_routes} routes expanded from ${risk.collections.length} collections and ${risk.route_templates} reviewed templates. ${risk.risk}`);
  }
  lines.push(
    "",
    "The check command also rejects duplicate method/path pairs, locked registration-source hash drift, static/dynamic overlay drift, unknown auth/condition/status override targets, mount-chain or exact source-anchor drift, an upstream test count different from the reviewed expected_test_count, unknown statuses, stale generated output, and nondeterministic ordering.",
    "",
    "`mount_chain` records re-derived syntactic assembly anchors, not a complete runtime call graph. Registration and handler locations are exact local source anchors; none of these fields prove reachability, middleware order, execution, or coverage.",
    "",
    "Route/test associations are boundary-aware heuristics. Static literal HTTP calls are path-locally method-filtered when visible; dynamic paths, plain-text references, prefix ambiguity and API3 filename hints remain risks. Associations are candidate links, not pass/adapted claims or coverage evidence.",
    "",
    "## Complete upstream test-file status",
    "",
  );
  for (const workstream of workstreams) {
    lines.push(
      `### ${workstream}`,
      "",
      "| Test file | Status | Candidate routes (heuristic) | Reason |",
      "| --- | --- | ---: | --- |",
    );
    for (const test of manifest.tests.filter((item) => item.workstream === workstream)) {
      lines.push(`| \`${test.file}\` | ${test.status} | ${test.related_routes.length} | ${markdownEscape(test.reason)} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Commands",
    "",
    "```sh",
    "npm run upstream:audit",
    "npm run upstream:audit:check",
    "npm run test:upstream-audit",
    "```",
    "",
  );
  return lines.join("\n");
}

function checkFile(path, expected) {
  const absolute = join(REPO_ROOT, path);
  if (!existsSync(absolute)) throw new Error(`${path} is missing; run npm run upstream:audit`);
  const actual = readFileSync(absolute, "utf8");
  if (actual !== expected) throw new Error(`${path} is stale; run npm run upstream:audit`);
}

function main() {
  const manifest = buildManifest();
  const serialized = serializeManifest(manifest);
  const markdown = renderMarkdown(manifest);
  if (process.argv.includes("--check")) {
    checkFile(MANIFEST_PATH, serialized);
    checkFile(MARKDOWN_PATH, markdown);
    console.log(`Upstream audit is current: ${manifest.statistics.route_count} routes, ${manifest.statistics.test_file_count} test files.`);
    return;
  }
  writeFileSync(join(REPO_ROOT, MANIFEST_PATH), serialized);
  writeFileSync(join(REPO_ROOT, MARKDOWN_PATH), markdown);
  console.log(`Generated ${MANIFEST_PATH} and ${MARKDOWN_PATH}: ${manifest.statistics.route_count} routes, ${manifest.statistics.test_file_count} test files.`);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
