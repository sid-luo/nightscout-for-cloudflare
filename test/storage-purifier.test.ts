import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sanitizeStoredDocument, sanitizeStoredString } from "../src/storage-purifier";
import { SqliteDocumentRepository } from "../src/document-repository";

const payload = '<script>alert(1)</script><img src=x onerror=alert(2)><b>meal</b>';
const clean = '<img src="x" /><b>meal</b>';

describe("15.0.8 bounded storage purifier", () => {
  it("strips executable markup and dangerous URLs while retaining formatting", () => {
    expect(sanitizeStoredString(payload)).toBe(clean);
    expect(sanitizeStoredString('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeStoredString('<svg><script>alert(1)</script></svg>ok')).toBe('ok');
  });
  it("preserves literal text, profile references, scalar types and caller objects", () => {
    const source = { defaultProfile: 'A & B < 2', store: { 'A & B < 2': { notes: payload } },
      values: [false, null, 0, '1 < 2', '&lt;script&gt;'] };
    const result = sanitizeStoredDocument(source);
    expect(result.defaultProfile).toBe(source.defaultProfile);
    expect(result.values).toEqual(source.values);
    expect(result.store['A & B < 2'].notes).toBe(clean);
    expect(source.store['A & B < 2'].notes).toBe(payload);
    expect(sanitizeStoredDocument(result)).toEqual(result);
  });
  it("bounds aggregate HTML parsing and object traversal", () => {
    expect(() => sanitizeStoredDocument({ a: '<b>' + 'a'.repeat(33000),
      b: '<b>' + 'b'.repeat(33000) })).toThrow(/sanitization limit/);
    expect(() => sanitizeStoredDocument({ values: Array.from({ length: 10241 }, () => ({})) }))
      .toThrow(/complexity limit/);
    expect(sanitizeStoredString('a'.repeat(70000))).toHaveLength(70000);
  });
});

describe("storage write boundary", () => {
  it("sanitizes API3 create, replace and patch across supported collections", async () => {
    const stub = env.ENTRY_STORE.getByName(`purifier-api3-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteDocumentRepository(state.storage);
      const options = { canCreate: true, canUpdate: true, actor: null,
        ifUnmodifiedSince: null, validate: false };
      for (const collection of ['entries', 'treatments', 'devicestatus', 'food', 'profile', 'settings'] as const) {
        const document = { identifier: `xss-${collection}`, date: Date.now(), type: 'sgv',
          sgv: 123, eventType: 'Note', created_at: new Date().toISOString(), notes: payload };
        const create = repository.createDocumentForApi3(collection, document, options);
        expect(create.ok).toBe(true);
        for (const operation of ['create', 'replace', 'patch'] as const) {
          const result = operation === 'create' ? create : operation === 'replace'
            ? repository.replaceDocumentForApi3(collection, document.identifier, document, options)
            : repository.patchDocumentForApi3(collection, document.identifier, { notes: payload }, options);
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error(result.reason);
          expect(result.mutation.document.notes).toBe(clean);
          const row = state.storage.sql.exec<{ body: string }>(
            'SELECT body FROM documents WHERE collection = ? AND identifier = ?',
            collection, document.identifier).one();
          expect(JSON.parse(row.body).notes).toBe(clean);
        }
      }
    });
  });

  it("sanitizes legacy REST create and update for food, profile, activity and treatments", async () => {
    const tenant = `purifier-rest-${crypto.randomUUID()}`;
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('nscf-test-secret-20260717'));
    const secret = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    for (const collection of ['food', 'profile', 'activity', 'treatments']) {
      let id: string | undefined;
      for (const method of ['POST', 'PUT']) {
        const response = await SELF.fetch(`https://example.test/api/v1/${collection}?tenant=${tenant}`, {
          method, headers: { 'api-secret': secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(id ? { _id: id } : {}), notes: payload,
            created_at: new Date().toISOString(), eventType: 'Note', name: 'test', type: 'food' }),
        });
        expect(response.status).toBe(200);
        const body = await response.json<{ _id: string; notes: string } | Array<{ _id: string; notes: string }>>();
        const documents = Array.isArray(body) ? body : [body];
        expect(documents[0]?.notes).toBe(clean);
        id = documents[0]?._id;
      }
    }
  });
});


it("rejects an over-budget REST batch without writing its valid prefix", async () => {
  const tenant = `purifier-budget-${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('nscf-test-secret-20260717'));
  const secret = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await SELF.fetch(`https://example.test/api/v1/food?tenant=${tenant}`, {
    method: 'POST', headers: { 'api-secret': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: 'valid' }, { name: '<b>' + 'a'.repeat(33000),
      notes: '<b>' + 'b'.repeat(33000) }]),
  });
  expect(response.status).toBe(400);
  const read = await SELF.fetch(`https://example.test/api/v1/food?tenant=${tenant}`);
  expect(await read.json()).toEqual([]);
});
