import { handleApi3Treatments } from "../src/api3/treatments";
import type { EntryStore } from "../src/entry-store";
import { describe, expect, it } from "vitest";
import {
  API3_MESSAGES,
  Api3InputError,
  calculateApi3Identifier,
  normalizeApi3Date,
  normalizeApi3MaxLimit,
  parseApi3Document,
  parseApi3History,
  parseApi3Search,
  parseApi3Sort,
  resolveApi3Identifier,
  validateApi3Common,
} from "../src/api3/input";
import { api3FormatFromRequest, api3Json, renderApi3 } from "../src/api3/response";

describe("locked API3 input adapter", () => {
  it("represents the upstream fixed sort chain as an ordered list", () => {
    expect(parseApi3Sort(new URL("https://example.test/api/v3/treatments"))).toEqual([
      { field: "identifier", direction: "asc" },
      { field: "created_at", direction: "asc" },
      { field: "date", direction: "asc" },
    ]);
    expect(parseApi3Sort(new URL("https://example.test/api/v3/treatments?sort=date"))).toEqual([
      { field: "date", direction: "asc" },
      { field: "identifier", direction: "asc" },
      { field: "created_at", direction: "asc" },
    ]);
    expect(
      parseApi3Sort(new URL("https://example.test/api/v3/treatments?sort%24desc=payload.rank")),
    ).toEqual([
      { field: "payload.rank", direction: "desc" },
      { field: "identifier", direction: "desc" },
      { field: "created_at", direction: "desc" },
      { field: "date", direction: "desc" },
    ]);
  });

  it("matches Express array-to-property-key coercion without inventing public multi-sort", () => {
    const repeated = new URL("https://example.test/api/v3/treatments?sort=first&sort=second");
    expect(parseApi3Sort(repeated)[0]).toEqual({ field: "first,second", direction: "asc" });
    const comma = new URL("https://example.test/api/v3/treatments?sort=first%2Csecond");
    expect(parseApi3Sort(comma)[0]).toEqual({ field: "first,second", direction: "asc" });
  });

  it("preserves the locked combined-sort error and marks SQL-only field rejection as controlled", () => {
    expect(() => parseApi3Sort(
      new URL("https://example.test/api/v3/treatments?sort=date&sort%24desc=created_at"),
    )).toThrowError(API3_MESSAGES.combinedSort);
    try {
      parseApi3Sort(new URL("https://example.test/api/v3/treatments?sort=unsafe%5Bpath%5D"));
      throw new Error("expected controlled rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Api3InputError);
      expect((error as Api3InputError).controlledDifference).toBe(true);
      expect((error as Api3InputError).status).toBe(400);
    }
  });

  it("parses filters, dates, projection, paging, and excludes the platform tenant selector", () => {
    const input = parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?tenant=alpha&carbs%24gte=12.5"
      + "&created_at%24lt=2026-07-17T08%3A00%3A00%2B02%3A00"
      + "&eventType%24in=Meal%20Bolus%7CTemp%20Basal&fields=identifier%2Ccarbs&limit=7&skip=2",
    ));
    expect(input.filters).toEqual([
      { field: "carbs", operator: "gte", value: 12.5 },
      { field: "created_at", operator: "lt", value: "2026-07-17T06:00:00.000Z" },
      { field: "eventType", operator: "in", value: "Meal Bolus|Temp Basal" },
    ]);
    expect(input.fields).toEqual(["identifier", "carbs"]);
    expect(input.limit).toBe(7);
    expect(input.skip).toBe(2);
  });

  it("matches the locked search paging errors and the fixed API3 ceiling", () => {
    expect(parseApi3Search(new URL(
      "https://example.test/api/v3/entries",
    )).limit).toBe(1_000);
    expect(parseApi3Search(new URL(
      "https://example.test/api/v3/entries?limit=3",
    )).limit).toBe(3);
    expect(normalizeApi3MaxLimit(5)).toBe(5);
    expect(normalizeApi3MaxLimit("5")).toBe(5);
    expect(normalizeApi3MaxLimit("INVALID")).toBe(1_000);
    expect(normalizeApi3MaxLimit(10_000)).toBe(1_000);
    expect(parseApi3Search(new URL(
      "https://example.test/api/v3/entries",
    ), "5").limit).toBe(5);
    expect(() => parseApi3Search(new URL(
      "https://example.test/api/v3/entries?limit=10",
    ), 5)).toThrowError(API3_MESSAGES.badLimit);

    for (const limit of ["INVALID", "-1", "0", "1001"]) {
      expect(() => parseApi3Search(new URL(
        `https://example.test/api/v3/entries?limit=${limit}`,
      )), limit).toThrowError(API3_MESSAGES.badLimit);
    }
    for (const skip of ["INVALID", "-5"]) {
      expect(() => parseApi3Search(new URL(
        `https://example.test/api/v3/entries?skip=${skip}`,
      )), skip).toThrowError(API3_MESSAGES.badSkip);
    }
  });

  it("matches locked Mongo field overwrite and onlyValid precedence", () => {
    const input = parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?rank%24gt=1&other=2"
      + "&rank%24lte=3&isValid=false",
    ));
    expect(input.filters).toEqual([
      { field: "rank", operator: "lte", value: 3 },
      { field: "other", operator: "eq", value: 2 },
    ]);
  });

  it("passes fractional and hexadecimal paging through locked safe-integer fallback", () => {
    expect(parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?limit=.5&skip=.5",
    ))).toMatchObject({ limit: 1_000, skip: 0 });
    expect(parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?limit=0x10",
    )).limit).toBe(0);
    expect(parseApi3Search(new URL(
      `https://example.test/api/v3/treatments?skip=${Number.MAX_SAFE_INTEGER}`,
    )).skip).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseApi3Search(new URL(
      "https://example.test/api/v3/treatments?skip=9007199254740992",
    ))).toThrowError(API3_MESSAGES.badSkip);
  });

  it("keeps the two upstream history boundaries distinct", () => {
    const url = new URL("https://example.test/api/v3/treatments/history?limit=5");
    expect(parseApi3History(url, undefined, "Fri, 17 Jul 2026 08:00:00 GMT")).toMatchObject({
      since: Date.UTC(2026, 6, 17, 8),
      inclusive: true,
      limit: 5,
    });
    expect(parseApi3History(url, "1784275200123", null)).toMatchObject({
      since: 1_784_275_200_123,
      inclusive: false,
      limit: 5,
    });
    expect(() => parseApi3History(url, undefined, null)).toThrowError(API3_MESSAGES.badLastModified);
  });

  it("normalizes API3 dates and calculates the locked UUIDv5 identity", async () => {
    const document = parseApi3Document({
      date: "2026-07-17T08:07:08.576+02:00",
      app: "AAPS",
      device: "pump",
      eventType: "Correction Bolus",
    });
    normalizeApi3Date(document);
    validateApi3Common(document);
    expect(document).toMatchObject({
      date: Date.UTC(2026, 6, 17, 6, 7, 8, 576),
      utcOffset: 120,
      created_at: "2026-07-17T06:07:08.576Z",
    });
    const calculated = await calculateApi3Identifier(document);
    expect(calculated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await resolveApi3Identifier(document);
    expect(document.identifier).toBe(calculated);
    expect(await calculateApi3Identifier(document)).toBe(calculated);
  });

  it("rejects array and empty request shapes before any mutation", () => {
    expect(() => parseApi3Document([])).toThrowError(API3_MESSAGES.badBody);
    expect(() => parseApi3Document({})).toThrowError(API3_MESSAGES.badBody);
    expect(() => parseApi3Document({ date: Number.NaN })).toThrowError(API3_MESSAGES.badBody);
  });
});

describe("API3 response renderer", () => {
  it("uses the official JSON envelope and content type", async () => {
    const response = api3Json({ status: 200, result: [{ identifier: "one" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ status: 200, result: [{ identifier: "one" }] });
  });

  it("negotiates the three locked renderer formats and rejects unsupported media", async () => {
    expect(api3FormatFromRequest(new Request("https://example.test"))).toBe("json");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "" },
    }))).toBe("json");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "Application/JSON" },
    }))).toBe("json");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "text/csv;q=0.1, application/json;q=0.9" },
    }))).toBe("json");
    expect(api3FormatFromRequest(new Request("https://example.test"), "application/json"))
      .toBe("json");
    expect(() => api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "application/json;q=0" },
    }))).toThrowError(API3_MESSAGES.unsupportedFormat);
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "application/json;q=0, */*;q=1" },
    }))).toBe("csv");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "text/csv, application/json;q=0.5" },
    }))).toBe("csv");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "text/csv" },
    }))).toBe("csv");
    expect(api3FormatFromRequest(
      new Request("https://example.test"),
      "xml",
    )).toBe("xml");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "application/xml" },
    }))).toBe("xml");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "application/json;foo" },
    }))).toBe("json");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "text/csv;foo=" },
    }))).toBe("csv");
    expect(api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "application/xml;foo=*" },
    }))).toBe("xml");
    for (const accept of [" ", "   ", "\t", ",", "application/json;foo=bar", "application/json;q=", "application/json;q=abc"]) {
      const rawRequest = {
        headers: { get: (name: string) => name.toLowerCase() === "accept" ? accept : null },
      } as unknown as Request;
      expect(() => api3FormatFromRequest(rawRequest)).toThrowError(API3_MESSAGES.unsupportedFormat);
    }
    expect(() => api3FormatFromRequest({
      headers: { get: () => "application/json, application/json;q=abc" },
    } as unknown as Request)).toThrowError(API3_MESSAGES.unsupportedFormat);
    expect(api3FormatFromRequest({
      headers: { get: () => "application/json;q=abc, application/json" },
    } as unknown as Request)).toBe("json");
    expect(() => api3FormatFromRequest({
      headers: { get: () => "application/json ; q = .5" },
    } as unknown as Request)).toThrowError(API3_MESSAGES.unsupportedFormat);
    expect(() => api3FormatFromRequest(new Request("https://example.test", {
      headers: { Accept: "font/ttf" },
    }))).toThrowError(API3_MESSAGES.unsupportedFormat);

    const json = renderApi3("json", { identifier: "one" });
    expect(json.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("Vary")).toBe("Accept");
    expect(await json.json()).toEqual({ status: 200, result: { identifier: "one" } });

    const csv = renderApi3("csv", { identifier: "one", notes: "a,b" });
    expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("Vary")).toBe("Accept");
    expect(await csv.text()).toBe('identifier,notes\none,"a,b"\n');

    const xml = renderApi3("xml", { identifier: "one", notes: "a&b" });
    expect(xml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(xml.headers.get("Vary")).toBe("Accept");
    expect(await xml.text()).toBe(
      "<?xml version='1.0' encoding='utf-8'?>\n"
      + "<item>\n"
      + "  <identifier>one</identifier>\n"
      + "  <notes>a&amp;b</notes>\n"
      + "</item>\n",
    );
  });
});


describe("15.0.8 OpenAPI filter_parameters", () => {
  it.each(['filter_parameters', 'filter_parameters[]'])("expands repeated %s while preserving spaces and equals in values", (name) => {
    const url = new URL('https://example.test/api/v3/treatments');
    url.searchParams.append(name, 'carbs$gte=10 eventType$eq=Meal Bolus');
    url.searchParams.append(name, 'notes$eq=a=b c');
    expect(parseApi3Search(url).filters).toEqual([
      { field: 'carbs', operator: 'gte', value: 10 },
      { field: 'eventType', operator: 'eq', value: 'Meal Bolus' },
      { field: 'notes', operator: 'eq', value: 'a=b c' },
    ]);
  });
  it("keeps the last condition and rejects unsafe field paths", () => {
    const url = new URL('https://example.test/api/v3/entries?sgv$gt=10');
    url.searchParams.append('filter_parameters', 'sgv$gt=20');
    expect(parseApi3Search(url).filters).toEqual([{ field: 'sgv', operator: 'gt', value: 20 }]);
    url.searchParams.append('filter_parameters', 'a..b$eq=3');
    expect(() => parseApi3Search(url)).toThrow(/Invalid filter field/);
  });
});


it("encodes XML field names, preserves underscore fields and resolves encoded-name collisions", async () => {
  const unsafe = 'unsafe:name';
  const encoded = '_encoded_dW5zYWZlOm5hbWU';
  const xml = await renderApi3("xml", {
    _metadata: 'untrusted metadata',
    outer: [{ ['field><unexpected>extra</unexpected><field/']: '<markup remains text>' }],
    [unsafe]: 'unsafe-key value', [encoded]: 'ordinary-key value',
  }).text();
  expect(xml).toContain('<_metadata>untrusted metadata</_metadata>');
  expect(xml).not.toContain(' metadata=');
  expect(xml).not.toContain('<unexpected>');
  expect(xml).toContain('&lt;markup remains text&gt;');
  expect(xml).toContain(`<${encoded}>ordinary-key value</${encoded}>`);
  expect(xml).toContain(`<${encoded}_2>unsafe-key value</${encoded}_2>`);
});


it("denies read-only PUT before purification or a storage lookup", async () => {
  const url = new URL("https://example.test/api/v3/treatments/private-id");
  const response = await handleApi3Treatments(new Request(url, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a: '<b>' + 'x'.repeat(33000), b: '<b>' + 'y'.repeat(33000) }),
  }), url, new Proxy({}, { get() { throw new Error("storage must not be queried"); } }) as DurableObjectStub<EntryStore>,
  { sub: "reader", permissionGroups: [["api:treatments:read"]] }, { kind: "resource", identifier: "private-id" }, 1000);
  expect(response.status).toBe(403);
});
