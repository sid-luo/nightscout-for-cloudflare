import { describe, expect, it } from "vitest";
import { PACKED_SQL_ROW_DICTIONARY_BYTES, PACKED_SQL_ROW_SHARED_BYTES, packSqlRow, unpackSqlRow } from "../src/realtime/raw-row-codec";

describe("lossless bounded raw SQL row representation", () => {
  it("roundtrips full body text, numeric values and key order in actual workerd", () => {
    const bodies = ["short", "", '{"prediction":' + JSON.stringify(Array(200).fill(123)) + '}',
      ('\ud800\udc00\ud800A\udc00中文🚀\u0000').repeat(100), ('not valid json \ud800').repeat(100)];
    for (const body of bodies) {
      const row = { id: "canonical", body, sort_time: 10, updated_at: -0, nullable: null, valid: false };
      const packed = packSqlRow(row)!;
      const decoded = unpackSqlRow(packed);
      expect(decoded).toEqual(row);
      expect(Object.keys(decoded)).toEqual(Object.keys(row));
      expect(Object.is(decoded.updated_at, -0)).toBe(true);
      if (packed.compressedBody !== undefined) {
        expect(packed.compressedBody.buffer.byteLength).toBe(packed.compressedBody.byteLength);
        expect(packed.bytes).toBeLessThan(2 * body.length + 600);
        expect((packed.row as typeof row).body).toBe("");
      }
      decoded.body = "mutated";
      expect(unpackSqlRow(packed).body).toBe(body);
    }
    const compressible = packSqlRow({ id: "x", body: "abc".repeat(5000), sort_time: 1 })!;
    expect(compressible.compressedBody).toBeDefined();
    expect(compressible.bytes).toBeLessThan(1000);
  });
  it("keeps oversized/incompressible text raw and rejects unsupported mutable values", () => {
    const large = { id: "x", body: "x".repeat(65_537), sort_time: 1 };
    expect(packSqlRow(large)!.compressedBody).toBeUndefined();
    expect(unpackSqlRow(packSqlRow(large)!)).toEqual(large);
    expect(packSqlRow({ id: "x", body: "text", sort_time: 1, extra: { mutable: true } })).toBeNull();
    expect(packSqlRow({ id: "x", body: "text", sort_time: 1, [Symbol("private")]: true })).toBeNull();
    let state = 123456;
    const random = Array.from({ length: 30_000 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(state & 0xffff);
    }).join("");
    const row = { id: "x", body: random, sort_time: 1 };
    expect(unpackSqlRow(packSqlRow(row)!)).toEqual(row);
  });

  it("can retain ordinary hot-path rows raw without paying compression CPU", () => {
    const row = { id: "raw-choice", body: "{\"notes\":\"" + "x".repeat(1000) + "\"}", sort_time: 1 };
    const raw = packSqlRow(row, false)!;
    expect(raw.compressedBody).toBeUndefined();
    expect(raw.row).toEqual(row);
    expect(unpackSqlRow(raw)).toEqual(row);
    expect(raw.bytes).toBeGreaterThan(packSqlRow(row)!.bytes);
  });

  it("roundtrips complete bodies with a shared generic-key dictionary in actual workerd", () => {
    expect(PACKED_SQL_ROW_DICTIONARY_BYTES).toBe(1154);
    expect(PACKED_SQL_ROW_SHARED_BYTES).toBe(4096);
    expect(PACKED_SQL_ROW_SHARED_BYTES).toBeGreaterThan(2 * PACKED_SQL_ROW_DICTIONARY_BYTES);
    const row = { id: "000000000000000000000fa0", body: '{"_id":"000000000000000000000fa0",'
      + '"created_at":"2026-10-17T12:20:00.000Z","date":1792239600000,"eventType":"Note",'
      + '"device":"synthetic-device","uploaderBattery":90,"notes":"\\ud800 unicode 中文 🚀"}', sort_time: 1792239600000 };
    const packed = packSqlRow(row)!;
    expect(packed.compressedBody).toBeDefined();
    expect(packed.compressedBody!.buffer.byteLength).toBe(packed.compressedBody!.byteLength);
    expect(unpackSqlRow(packed)).toEqual(row);
    expect(Object.keys(unpackSqlRow(packed))).toEqual(Object.keys(row));
    expect(packed.bytes).toBeGreaterThanOrEqual(packed.compressedBody!.byteLength + 64 + 8);
    // Neither decoding nor caller mutation can modify the shared dictionary or
    // any other packed row. Strings and non-JSON text stay exact UTF-16 values.
    const other = packSqlRow({ ...row, body: ('not JSON \ud800\udc00\ud800A\udc00').repeat(100) })!;
    unpackSqlRow(packed).body = "caller mutation";
    expect(unpackSqlRow(packed).body).toBe(row.body);
    expect(unpackSqlRow(other).body).toBe(('not JSON \ud800\udc00\ud800A\udc00').repeat(100));
  });
});
