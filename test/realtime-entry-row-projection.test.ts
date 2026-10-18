import { describe, expect, it } from "vitest";
import { projectRealtimeEntryRow } from "../src/realtime/entry-row-projection";

const fields = [
  "_id", "date", "sgv", "mbg", "device", "direction", "filtered",
  "unfiltered", "noise", "rssi", "scale", "intercept", "slope",
] as const;

const rawRow = (body: string) => ({
  id: "storage-id", body, sort_time: 100, updated_at: 200, metadata: { revision: 3 },
});

describe("fixed realtime entry row projection", () => {
  it("preserves all consumed own fields and row metadata while removing unused canonical fields", () => {
    const document = {
      _id: "body-id", date: 99, sgv: "110", mbg: false,
      device: ["CGM", null], direction: { name: "Flat" }, filtered: "123",
      unfiltered: [123], noise: true, rssi: null, scale: "1.0", intercept: 0, slope: 2,
      identifier: "public-identifier", dateString: "ignored", sysTime: "ignored",
      utcOffset: 480, type: "sgv", app: "uploader", srvCreated: 1, srvModified: 2,
    };
    const original = Object.freeze(rawRow(JSON.stringify(document)));
    const projected = projectRealtimeEntryRow(original);
    expect(projected).not.toBe(original);
    expect({ ...projected, body: original.body }).toEqual(original);
    expect(projected.metadata).toBe(original.metadata);
    expect(JSON.parse(projected.body)).toEqual(Object.fromEntries(fields.map(field => [field, document[field]])));
    expect(original.body).toBe(JSON.stringify(document));
    // The body id/date need not agree with the storage id/sort_time.
    expect(JSON.parse(projected.body)).toMatchObject({ _id: "body-id", date: 99 });
  });

  it("keeps missing fields missing and preserves null, booleans, arrays, objects and coercion inputs", () => {
    const values: unknown[] = [null, true, false, 0, 1, "", "0", " 110 ", "0x10",
      [], [null], ["1", "2"], { amount: "3" }, { toJSON: "data" }];
    for (const value of values) {
      const original = rawRow(JSON.stringify({ _id: "id", date: 100, sgv: value, scale: value }));
      const projected = JSON.parse(projectRealtimeEntryRow(original).body) as Record<string, unknown>;
      expect(projected).toEqual({ _id: "id", date: 100, sgv: value, scale: value });
      expect(Object.hasOwn(projected, "device")).toBe(false);
      expect(Object.hasOwn(projected, "mbg")).toBe(false);
      expect(Boolean(projected.sgv)).toBe(Boolean(value));
      expect(Number(projected.sgv)).toBe(Number(value));
      expect(String(projected.scale)).toBe(String(value));
    }
    const nested = rawRow('{"_id":"id","date":100,"device":{"__proto__":{"value":1}},"extra":true}');
    expect(JSON.parse(projectRealtimeEntryRow(nested).body)).toEqual(JSON.parse(nested.body.replace(',"extra":true', "")));
  });

  it("drops a large unrelated subtree without walking or retaining it", () => {
    const original = rawRow(JSON.stringify({ _id: "id", date: 100, sgv: 110,
      unrelated: { text: "x".repeat(600_000), rows: Array.from({ length: 10_000 }, () => ({})) },
    }));
    const projected = projectRealtimeEntryRow(original);
    expect(projected).not.toBe(original);
    expect(projected.body).toBe('{"_id":"id","date":100,"sgv":110}');
    expect(projected.body.length).toBeLessThan(100);
    const unusedUnsafeNumber = rawRow('{"_id":"id","date":100,"sgv":110,"ignored":1e309}');
    expect(projectRealtimeEntryRow(unusedUnsafeNumber).body).toBe(projected.body);
  });

  it("preserves the raw row for non-finite numbers or negative zero at any selected depth", () => {
    for (const body of [
      '{"_id":"id","date":1e309,"sgv":110}',
      '{"_id":"id","date":100,"filtered":-1e309}',
      '{"_id":"id","date":-0,"sgv":110}',
      '{"_id":"id","date":100,"device":[{"nested":1e309}]}',
      '{"_id":"id","date":100,"scale":{"nested":[-0]}}',
    ]) {
      const original = rawRow(body);
      expect(projectRealtimeEntryRow(original)).toBe(original);
    }
  });

  it("leaves invalid JSON, non-object bodies and original strict-field validation to the caller", () => {
    for (const body of ["{", "null", "true", "17", '"text"', "[]", '[{"sgv":110}]']) {
      const original = rawRow(body);
      expect(projectRealtimeEntryRow(original)).toBe(original);
    }
    for (const document of [{ sgv: 110 }, { _id: 7, date: "100", sgv: 110 }, { _id: null, date: null }]) {
      const original = rawRow(JSON.stringify({ ...document, ignored: true }));
      expect(JSON.parse(projectRealtimeEntryRow(original).body)).toEqual(document);
    }
  });

  it("falls back rather than adding errors for excessive selected depth, nodes or strings", () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 80; depth++) deep = { nested: deep };
    for (const value of [deep, Array.from({ length: 9_000 }, () => 0), "x".repeat(300_000)]) {
      const original = rawRow(JSON.stringify({ _id: "id", date: 100, device: value }));
      expect(projectRealtimeEntryRow(original)).toBe(original);
    }
    const accessor = { get body(): string { throw new Error("body access failed"); }, id: "id" };
    expect(projectRealtimeEntryRow(accessor)).toBe(accessor);
  });
});
