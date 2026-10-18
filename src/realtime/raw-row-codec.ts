import { Buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const ROW_METADATA_BYTES = 128;
const FIELD_METADATA_BYTES = 32;
const COMPRESSED_BODY_METADATA_BYTES = 64;
const SHARED_DICTIONARY_REFERENCE_BYTES = 8;
const MAX_COMPRESS_BODY_CODE_UNITS = 65_536;

// Generic JSON key tokens only: no user data, identifiers or timestamps. Keep
// the frequent frame fields nearest the dictionary end for shorter distances.
const COMMON_JSON_KEY_TOKENS = '"identifier":,"dateString":,"carbs":,"insulin":,"glucose":,"notes":,"enteredBy":,"duration":,"profile":,"utcOffset":,"type":,"sgv":,"mbg":,"direction":,"filtered":,"unfiltered":,"noise":,"rssi":,"pump":,"battery":,"percent":,"clock":,"reservoir":,"status":,"openaps":,"suggested":,"enacted":,"timestamp":,"predBGs":,"IOB":,"COB":,"UAM":,"ZT":,"configuration":,"extended":,"nameValuePairs":,"Version":,"LastBolus":,"LastBolusAmount":,"BaseBasalRate":,"ActiveProfile":,"srvModified":,"srvCreated":,"isValid":,"_id":,"created_at":,"date":,"eventType":,"device":,"uploaderBattery":';
const SHARED_DICTIONARY = Uint8Array.from(Buffer.from(COMMON_JSON_KEY_TOKENS, "utf16le"));
export const PACKED_SQL_ROW_DICTIONARY_BYTES = SHARED_DICTIONARY.byteLength;
// Conservatively covers the exact dictionary buffer, source string and headers.
// A containing cache charges this once per entry that retains compressed rows.
export const PACKED_SQL_ROW_SHARED_BYTES = 4096;

/** A private lossless cache representation; never exposed as a stored/public document. */
export interface PackedSqlRow<Row> {
  readonly row: Row;
  readonly compressedBody?: Uint8Array;
  readonly bodyCodeUnits?: number;
  readonly bytes: number;
}

function scalarRowBytes(row: object, compressedBody?: Uint8Array): number | null {
  if (Object.getOwnPropertySymbols(row).length !== 0) return null;
  let bytes = ROW_METADATA_BYTES;
  for (const [field, value] of Object.entries(row)) {
    bytes += FIELD_METADATA_BYTES + 2 * field.length;
    if (field === "body" && compressedBody !== undefined) {
      bytes += COMPRESSED_BODY_METADATA_BYTES + SHARED_DICTIONARY_REFERENCE_BYTES + compressedBody.byteLength;
    } else if (typeof value === "string") bytes += 2 * value.length;
    else if (value === null || typeof value === "number" || typeof value === "boolean") bytes += 8;
    else return null;
  }
  return bytes;
}

/**
 * Retain raw values, including UTF-16 lone surrogates and numeric -0. Only a
 * bounded body string is compressed, and only when its exact retained buffer
 * plus metadata is smaller. No parsed JSON or schema-dependent field removal.
 */
export function packSqlRow<Row extends object>(row: Row, compress = true): PackedSqlRow<Row> | null {
  const rawBytes = scalarRowBytes(row);
  if (rawBytes === null) return null;
  const raw = { ...row };
  const body = (row as Record<string, unknown>).body;
  if (compress && typeof body === "string" && body.length >= 128 && body.length <= MAX_COMPRESS_BODY_CODE_UNITS) {
    try {
      const compressed = deflateRawSync(Buffer.from(body, "utf16le"), {
        level: 1, chunkSize: 1024, dictionary: SHARED_DICTIONARY,
      });
      if (compressed.byteLength + COMPRESSED_BODY_METADATA_BYTES + SHARED_DICTIONARY_REFERENCE_BYTES < 2 * body.length) {
        // Node buffers can be views into much larger zlib output allocations.
        // Copy into an exactly-sized buffer before accounting/retaining it.
        const data = Uint8Array.from(compressed);
        const packedRow = { ...raw, body: "" } as Row;
        return { row: packedRow, compressedBody: data, bodyCodeUnits: body.length,
          bytes: scalarRowBytes(packedRow, data)! };
      }
    } catch {
      // Optional compression must never change the original read/error path.
    }
  }
  return { row: raw, bytes: rawBytes };
}

export function unpackSqlRow<Row extends object>(packed: PackedSqlRow<Row>): Row {
  if (packed.compressedBody === undefined) return { ...packed.row };
  const expectedBytes = 2 * packed.bodyCodeUnits!;
  const decoded = inflateRawSync(packed.compressedBody, {
    maxOutputLength: expectedBytes, chunkSize: 1024, dictionary: SHARED_DICTIONARY,
  });
  if (decoded.byteLength !== expectedBytes) throw new Error("invalid cached SQL body length");
  return { ...packed.row, body: decoded.toString("utf16le") } as Row;
}
