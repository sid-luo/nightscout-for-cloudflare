import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const vendorRoot = path.join(projectRoot, "vendor", "nightscout");
const publicRoot = path.join(projectRoot, "public");
const upstreamBundleRoot = path.join(
  vendorRoot,
  "node_modules",
  ".cache",
  "_ns_cache",
  "public",
);

const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "upstream", "manifest.json"), "utf8"),
);
const projectPackage = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const projectUpdateGuide =
  "https://github.com/sid-luo/nightscout-for-cloudflare/blob/main/README.md#2-upgrading";
const socketClientPath = path.join(
  vendorRoot,
  "node_modules",
  "socket.io",
  "client-dist",
  "socket.io.js",
);
const socketClient = await readFile(socketClientPath, "utf8");
const socketTenantAdapterPath = path.join(
  projectRoot,
  "platform",
  "socket-tenant-adapter.js",
);
const socketTenantAdapter = await readFile(socketTenantAdapterPath, "utf8");
const socketClientCachebuster = createHash("sha256")
  .update(socketClient)
  .digest("hex")
  .slice(0, 12);
const socketTenantCachebuster = createHash("sha256")
  .update(socketTenantAdapter)
  .digest("hex")
  .slice(0, 12);
const transportCachebuster = createHash("sha256")
  .update(socketClient)
  .update(socketTenantAdapter)
  .digest("hex")
  .slice(0, 12);
const cachebuster = `${manifest.release}-${manifest.commit.slice(0, 12)}-${transportCachebuster}`;
const locals = { bundle: "/bundle", cachebuster };

function displayProjectVersion(version) {
  return version
    .replace(/^(\d+\.\d+)\.0-beta(?:\.\d+)?$/i, "$1 Beta")
    .replace(/^(\d+\.\d+)\.0$/, "$1");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

const projectVersion = escapeHtml(displayProjectVersion(projectPackage.version));
const projectHomepage = escapeHtml(projectPackage.homepage.replace(/#readme$/, ""));
const projectIssues = escapeHtml(projectPackage.bugs.url);

const transportScripts = [
  `<script src="/socket.io/socket.io.js?${socketClientCachebuster}"></script>`,
  `<script src="/platform/socket-tenant-adapter.js?${socketTenantCachebuster}"></script>`,
].join("\n  ");

function applyPlatformAssetVersions(html) {
  return html
    .replaceAll(
      '<script src="socket.io/socket.io.js"></script>',
      transportScripts,
    )
    .replaceAll(
      '<script src="/socket.io/socket.io.js"></script>',
      transportScripts,
    )
    .replace(
      "navigator.serviceWorker.register('/sw.js', { scope: '/' })",
      `navigator.serviceWorker.register('/sw.js?${cachebuster}', { scope: '/', updateViaCache: 'none' })`,
    );
}

function applyPageAdapters(html, type) {
  if (type === "index") {
    const projectAbout = `
        <div id="nscf-about">
          <hr>
          <div><strong>Nightscout for Cloudflare</strong></div>
          <div>Version <strong>${projectVersion}</strong></div>
          <div>Independent, unofficial Cloudflare port</div>
          <p class="links">
            <a href="${projectHomepage}" target="_blank" rel="noopener">Project Home</a><br>
            <a href="${projectIssues}" target="_blank" rel="noopener">Report an Issue</a><br>
            <a href="${projectUpdateGuide}" target="_blank" rel="noopener">Update Guide</a>
          </p>
        </div>`;
    return html
      .replace(
        '<div>version <span class="version"></span></div>',
        '<div>Upstream version <span class="version"></span></div>',
      )
      .replace(
        '<div>head <span class="head"></span></div>',
        `<div>head <span class="head"></span></div>${projectAbout}`,
      );
  }

  if (type === "admin") {
    return html.replace(
      '<script src="/admin/js/admin.js"></script>',
      `<script>
      Nightscout.admin_plugins("cleanstatusdb").label = "Device status maintenance";
      Nightscout.admin_plugins("cleantreatmentsdb").label = "Treatment records maintenance";
      Nightscout.admin_plugins("cleanentriesdb").label = "Glucose entries maintenance";
      Nightscout.admin_plugins("futureitems").label = "Future-dated records maintenance";
    </script>
    <script src="/admin/js/admin.js"></script>`,
    );
  }

  return html;
}

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

await cp(path.join(vendorRoot, "static"), publicRoot, { recursive: true });
await cp(path.join(vendorRoot, "translations"), path.join(publicRoot, "translations"), {
  recursive: true,
});
// Locked Nightscout v15.0.7 requests sl_SL.json for Slovenian, while the
// official Crowdin asset is named sl_SI.json. Keep the vendor snapshot intact
// and publish a byte-identical compatibility alias for the upstream client.
await cp(
  path.join(publicRoot, "translations", "sl_SI.json"),
  path.join(publicRoot, "translations", "sl_SL.json"),
);
await cp(upstreamBundleRoot, path.join(publicRoot, "bundle"), { recursive: true });

const officialPages = [
  { view: "index.html", output: "index.html", title: "", type: "index" },
  {
    view: "adminindex.html",
    output: "admin/index.html",
    title: "Admin Tools",
    type: "admin",
  },
  {
    view: "profileindex.html",
    output: "profile/index.html",
    title: "Profile Editor",
    type: "profile",
  },
  {
    view: "foodindex.html",
    output: "food/index.html",
    title: "Food Editor",
    type: "food",
  },
  {
    view: "reportindex.html",
    output: "report/index.html",
    title: "Nightscout reporting",
    type: "report",
  },
  {
    view: "frame.html",
    output: "split/index.html",
    title: "8-user view",
    type: "index",
  },
];

for (const page of officialPages) {
  const viewPath = path.join(vendorRoot, "views", page.view);
  const html = applyPageAdapters(
    applyPlatformAssetVersions(
      await ejs.renderFile(viewPath, {
        locals,
        settings: {},
        title: page.title,
        type: page.type,
      }),
    ),
    page.type,
  );
  const outputPath = path.join(publicRoot, page.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
}

const clockViewPath = path.join(vendorRoot, "views", "clockviews", "clock.html");
for (const face of ["bgclock", "clock-color", "clock", "config"]) {
  const html = await ejs.renderFile(clockViewPath, { face, locals });
  const outputPath = path.join(publicRoot, "clock", face, "index.html");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
}
const clockTemplate = await ejs.renderFile(clockViewPath, {
  face: "__CLOCK_FACE__",
  locals,
});
await writeFile(path.join(publicRoot, "clock", "template.html"), clockTemplate);

const serviceWorkerPath = path.join(vendorRoot, "views", "service-worker.js");
const serviceWorkerSource = await readFile(serviceWorkerPath, "utf8");
const serviceWorker = ejs
  .render(serviceWorkerSource, { locals }, { filename: serviceWorkerPath })
  .replace("    '/socket.io/socket.io.js',\n", "");
await writeFile(path.join(publicRoot, "sw.js"), serviceWorker);

await mkdir(path.join(publicRoot, "socket.io"), { recursive: true });
await writeFile(path.join(publicRoot, "socket.io", "socket.io.js"), socketClient);
await mkdir(path.join(publicRoot, "platform"), { recursive: true });
await writeFile(
  path.join(publicRoot, "platform", "socket-tenant-adapter.js"),
  socketTenantAdapter,
);
await mkdir(path.join(publicRoot, "api-docs"), { recursive: true });
await cp(
  path.join(vendorRoot, "static", "api-docs.html"),
  path.join(publicRoot, "api-docs", "index.html"),
);
await cp(
  path.join(vendorRoot, "node_modules", "swagger-ui-dist"),
  path.join(publicRoot, "swagger-ui-dist"),
  { recursive: true },
);
await cp(
  path.join(vendorRoot, "lib", "server", "swagger.json"),
  path.join(publicRoot, "swagger.json"),
);
await cp(
  path.join(vendorRoot, "lib", "server", "swagger.yaml"),
  path.join(publicRoot, "swagger.yaml"),
);
await cp(
  path.join(vendorRoot, "lib", "api3", "swagger.json"),
  path.join(publicRoot, "api3-swagger.json"),
);

console.log(
  JSON.stringify({
    message: "Official Nightscout UI prepared for Workers Static Assets",
    upstream: manifest.release,
    output: publicRoot,
  }),
);
