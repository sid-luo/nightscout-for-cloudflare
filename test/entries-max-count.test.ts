import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

type Entry = { _id: string; date: number; dateString: string; type: string; sgv: number };
type JsonObject = Record<string, unknown>;

function tenant(): string {
  return `entries-max-count-${crypto.randomUUID()}`;
}

function request(
  name: string,
  path: string,
  maximum?: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(path, "https://example.test");
  url.searchParams.set("tenant", name);
  const appEnv = {
    ...env,
    AUTH_DEFAULT_ROLES: "readable",
    ...(maximum === undefined ? {} : { ENTRIES_MAX_COUNT: maximum }),
  };
  return worker.fetch(new Request(url, init), appEnv);
}

function id(n: number): string {
  return n.toString(16).padStart(24, "0");
}

async function seed(name: string, count: number, firstDate: number): Promise<void> {
  const stub = env.ENTRY_STORE.getByName(name);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      state.storage.sql.exec(`
        WITH RECURSIVE fixture(n) AS (
          VALUES (1) UNION ALL SELECT n + 1 FROM fixture WHERE n < ?
        )
        INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, is_valid)
        SELECT 'entries', printf('%024x', n),
          json_object(
            '_id', printf('%024x', n), 'type', 'sgv', 'sgv', 120,
            'date', ? + (n - 1) * 60000,
            'dateString', strftime('%Y-%m-%dT%H:%M:%fZ', (? + (n - 1) * 60000) / 1000, 'unixepoch'),
            'direction', 'Flat', 'device', 'synthetic'
          ),
          ? + (n - 1) * 60000, ?, ?, 1
        FROM fixture
      `, count, firstDate, firstDate, firstDate, firstDate, firstDate);
    });
    expect(state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM documents WHERE collection = 'entries'",
    ).one().n).toBe(count);
  });
  // Direct fixture SQL intentionally bypasses write-side cache invalidation.
  // Evict before HTTP reads so every assertion uses the real cold DO/RPC path.
  await evictDurableObject(stub);
}

async function expectCountError(response: Response, maximum: number): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "invalid_query", message: `count must be an integer from 1 to ${maximum}` },
  });
}

describe("optional legacy Entries maximum count", () => {
  it("keeps the existing 10000 boundary when the deployment has no override", async () => {
    const name = tenant();
    const accepted = await request(name, "/api/v1/entries.json?count=10000");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual([]);
    await expectCountError(await request(name, "/api/v1/entries.json?count=10001"), 10000);
  });

  it("falls back to 10000 for invalid deployment values", async () => {
    const name = tenant();
    for (const value of ["", " ", "0", "-1", "1.5", "Infinity", "NaN", "10000oops", "9007199254740992"]) {
      const accepted = await request(name, "/api/v1/entries.json?count=10000", value);
      expect(accepted.status, JSON.stringify(value)).toBe(200);
      expect(await accepted.json()).toEqual([]);
      await expectCountError(await request(name, "/api/v1/entries.json?count=10001", value), 10000);
    }
  });

  it("still rejects invalid request counts and reports the configured boundary", async () => {
    const name = tenant();
    for (const count of ["0", "-1", "1.5", "Infinity", "NaN", "50001", "9007199254740992"]) {
      await expectCountError(await request(name, `/api/v1/entries.json?count=${count}`, "50000"), 50000);
    }
    const repeated = await request(name, "/api/v1/entries.json?count=1&count=2", "50000");
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({ error: { code: "invalid_query", message: "count must not be repeated" } });
  });

  it("allows deployment values above 50000 without imposing another business ceiling", async () => {
    const name = tenant();
    const firstDate = Date.now() - 5 * 60000;
    await seed(name, 2, firstDate);
    for (const maximum of ["1000000", "9007199254740991"]) {
      const response = await request(name, `/api/v1/entries.json?count=${maximum}`, maximum);
      expect(response.status, maximum).toBe(200);
      expect((await response.json<Entry[]>()).map(row => row._id)).toEqual([id(2), id(1)]);
    }
  });

  it("preserves the omitted-count default and respects a configured maximum below ten", async () => {
    const name = tenant();
    await seed(name, 12, Date.now() - 20 * 60000);
    for (const [maximum, length] of [[undefined, 10], ["50000", 10], ["3", 3], ["1", 1]] as const) {
      const response = await request(name, "/api/v1/entries.json", maximum);
      expect(response.status).toBe(200);
      const rows = await response.json<Entry[]>();
      expect(rows.map(row => row._id)).toEqual(Array.from({ length }, (_, i) => id(12 - i)));
    }
    await expectCountError(await request(name, "/api/v1/entries.json?count=4", "3"), 3);
  });

  it("applies the override to both API versions, type routes, and every Entries format", async () => {
    const name = tenant();
    await seed(name, 3, Date.now() - 5 * 60000);
    for (const version of [1, 2]) {
      for (const route of ["entries", "entries/sgv"]) {
        for (const [format, contentType] of [
          ["json", "application/json"], ["csv", "text/csv"],
          ["tsv", "text/tab-separated-values"], ["txt", "text/plain"],
        ]) {
          const path = `/api/v${version}/${route}.${format}?count=50000`;
          const response = await request(name, path, "50000");
          expect(response.status, path).toBe(200);
          expect(response.headers.get("Content-Type"), path).toBe(`${contentType}; charset=utf-8`);
          if (format === "json") {
            expect((await response.json<Entry[]>()).map(row => row._id), path).toEqual([id(3), id(2), id(1)]);
          } else {
            expect((await response.text()).split("\r\n"), path).toHaveLength(3);
          }
        }
      }
    }
  });

  it("returns a complete 50000-row GlucoLens date-range response over real Durable Object RPC", async () => {
    const name = tenant();
    const firstDate = Date.UTC(2026, 0, 1);
    const lastDate = firstDate + 49999 * 60000;
    await seed(name, 50001, firstDate);
    // Match GlucoLens' actual request syntax. The newest fixture row falls just
    // outside the requested interval and must not displace a matching result.
    const path = `/api/v1/entries.json?find[date][$gte]=${firstDate}&find[date][$lte]=${lastDate}&count=50000`;
    await expectCountError(await request(name, path), 10000);
    const response = await request(name, path, "50000");
    expect(response.status).toBe(200);
    const rows = await response.json<Entry[]>();
    expect(rows).toHaveLength(50000);
    expect(rows[0]).toMatchObject({ _id: id(50000), date: lastDate });
    expect(rows.at(-1)).toMatchObject({ _id: id(1), date: firstDate });
    expect(new Set(rows.map(row => row._id)).size).toBe(50000);
    expect(rows.every((row, i) => row._id === id(50000 - i)
      && row.date === lastDate - i * 60000 && row.type === "sgv" && row.sgv === 120)).toBe(true);
  }, 60000);

  it("validates times/slice caller counts separately from their internal candidate budget", async () => {
    const name = tenant();
    await seed(name, 30, Date.UTC(2026, 0, 1));
    for (const path of [
      "/api/v1/times/2026-01-01",
      "/api/v2/slice/entries/dateString/sgv/2026-01-01",
    ]) {
      const raised = await request(name, `${path}.json?count=50000`, "50000");
      expect(raised.status, path).toBe(200);
      expect(await raised.json()).toHaveLength(30);
      await expectCountError(await request(name, `${path}.json?count=4`, "3"), 3);

      // Only the oldest row matches. A candidate budget incorrectly reduced to
      // the user maximum (3) would discard it before applying this pattern.
      const patterned = await request(name, `${path}/${encodeURIComponent("T00:00:")}.json?count=1`, "3");
      expect(patterned.status, path).toBe(200);
      expect((await patterned.json<Entry[]>()).map(row => row._id)).toEqual([id(1)]);
    }
  });

  it("does not change limits on other legacy collections or authenticated API3 reads", async () => {
    const name = tenant();
    for (const collection of ["treatments", "devicestatus", "profile"]) {
      const path = `/api/v1/${collection}.json?count=10001`;
      const baseline = await request(name, path);
      const overridden = await request(name, path, "50000");
      expect(overridden.status, collection).toBe(baseline.status);
      expect(await overridden.json(), collection).toEqual(await baseline.json());
    }

    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode("nscf-test-secret-20260717"));
    const secret = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const headers = { "api-secret": secret, "Content-Type": "application/json" };
    const role = await request(name, "/api/v2/authorization/roles", "50000", {
      method: "POST", headers, body: JSON.stringify({ name: "entries-limit-reader", permissions: ["api:entries:read"] }),
    });
    expect(role.status).toBe(200);
    await role.text();
    const created = await request(name, "/api/v2/authorization/subjects", "50000", {
      method: "POST", headers, body: JSON.stringify({ name: "Entries limit reader", roles: ["entries-limit-reader"] }),
    });
    expect(created.status).toBe(200);
    const subjectId = (await created.json<JsonObject>())._id;
    const listed = await request(name, "/api/v2/authorization/subjects", "50000", { headers });
    expect(listed.status).toBe(200);
    const accessToken = (await listed.json<JsonObject[]>()).find(subject => subject._id === subjectId)?.accessToken;
    expect(accessToken).toEqual(expect.any(String));
    const authorization = await request(name, `/api/v2/authorization/request/${encodeURIComponent(String(accessToken))}`, "50000");
    expect(authorization.status).toBe(200);
    const token = (await authorization.json<JsonObject>()).token;
    const bearer = { Authorization: `Bearer ${String(token)}` };
    const accepted = await request(name, "/api/v3/entries?limit=1000", "50000", { headers: bearer });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: 200, result: [] });
    const rejected = await request(name, "/api/v3/entries?limit=1001", "50000", { headers: bearer });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ status: 400, message: "Parameter limit out of tolerance" });
  });
});
