/*
 * Cloudflare transport boundary for the official Socket.IO 4.8.3 client.
 *
 * Nightscout normally has one database per deployment, so its browser client
 * does not add NSCF's optional test-tenant selector to Engine.IO requests.
 * Keep the official client byte-identical and add only that platform query
 * when the visible page explicitly selected a tenant.
 */
(function installCloudflareSocketTenant(global) {
  "use strict";

  if (!global.io || typeof global.io.connect !== "function") return;

  var selected = new URLSearchParams(global.location.search).get("tenant");
  if (!selected || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(selected)) return;

  var originalConnect = global.io.connect.bind(global.io);

  global.io.connect = function connectWithTenant(namespace, options) {
    var target = namespace;
    var configured = options;
    if (namespace && typeof namespace === "object") {
      configured = namespace;
      target = undefined;
    }

    configured = Object.assign({}, configured || {});
    if (typeof configured.query === "string") {
      var query = new URLSearchParams(configured.query);
      query.set("tenant", selected);
      configured.query = query.toString();
    } else {
      configured.query = Object.assign({}, configured.query || {}, {
        tenant: selected,
      });
    }

    return target === undefined
      ? originalConnect(configured)
      : originalConnect(target, configured);
  };
})(window);
