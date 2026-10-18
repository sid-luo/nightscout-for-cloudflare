export const DEVICE_STATUS_RECENT_READ_INDEX = "documents_devicestatus_recent";
export const TREATMENTS_API3_ORDER_READ_INDEX = "documents_treatments_api3_order";
export const COLD_READ_INDEX_NEW_KEY_LIMIT = 20_000;
export const COLD_READ_INDEX_CANONICAL_LIMIT = 100_000;

export interface ColdReadIndexCapabilities {
  deviceStatusRecent: boolean;
  treatmentsApi3Order: boolean;
}

interface IndexDefinition extends Record<string, SqlStorageValue> {
  rowid: number;
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

// Cache addresses only, never capability values or definitions. A schema
// rollback/drop can reuse a rowid, so every use verifies its current name/type
// before inspecting the definition and refreshing an invalid address hint.
const definitionAddresses = new WeakMap<SqlStorage, Map<string, number>>();

function indexDefinition(sql: SqlStorage, index: string): IndexDefinition | undefined {
  let addresses = definitionAddresses.get(sql);
  if (addresses === undefined) {
    addresses = new Map();
    definitionAddresses.set(sql, addresses);
  }
  const address = addresses.get(index);
  if (address !== undefined) {
    const row = sql.exec<IndexDefinition>(
      "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?", address,
    ).toArray()[0];
    if (row?.type === "index" && row.name === index) return row;
    addresses.delete(index);
  }
  const row = sql.exec<IndexDefinition>(
    "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1", index,
  ).toArray()[0];
  if (row?.type === "index" && row.name === index) addresses.set(index, row.rowid);
  return row;
}

function hasDefinition(
  sql: SqlStorage, index: string, columns: readonly (readonly [string, number])[], collection: string,
): boolean {
  const rows = sql.exec(`PRAGMA index_xinfo(${index})`).toArray().filter(row => row.key === 1);
  if (rows.length !== columns.length || !rows.every((row, position) => {
    const expected = columns[position]!;
    return row.name === expected[0] && row.desc === expected[1] && row.coll === "BINARY";
  })) return false;
  const definition = indexDefinition(sql, index);
  if (definition?.tbl_name !== "documents" || typeof definition.sql !== "string"
    || !/^\s*CREATE\s+INDEX\b/i.test(definition.sql)) return false;
  const predicate = /\bWHERE\b([\s\S]*)$/i.exec(definition.sql)?.[1];
  if (predicate === undefined) return false;
  const equality = /^\s*([a-z_][a-z_0-9]*)\s*=\s*('(?:[^']|'')*')\s*;?\s*$/i.exec(predicate);
  // SQL identifiers are case-insensitive; string literals are not. Trust
  // only the exact collection predicate, without added constraints or ORs.
  return equality?.[1]?.toLowerCase() === "collection" && equality[2] === `'${collection}'`;
}

/** Always inspect current SQL state so an outer rollback cannot leave a ready flag. */
export function readColdReadIndexCapabilities(sql: SqlStorage): ColdReadIndexCapabilities {
  return {
    deviceStatusRecent: hasDeviceStatusRecentReadIndex(sql),
    treatmentsApi3Order: hasTreatmentsApi3OrderReadIndex(sql),
  };
}

export function hasDeviceStatusRecentReadIndex(sql: SqlStorage): boolean {
  return hasDefinition(sql, DEVICE_STATUS_RECENT_READ_INDEX,
    [["collection", 0], ["sort_time", 1], ["updated_at", 1]], "devicestatus");
}

export function hasTreatmentsApi3OrderReadIndex(sql: SqlStorage): boolean {
  return hasDefinition(sql, TREATMENTS_API3_ORDER_READ_INDEX,
    [["collection", 0], ["sort_time", 1], ["srv_modified", 1], ["id", 0]], "treatments");
}

/**
 * Optional v33 performance assessment, inside the caller's schema transaction.
 * Building a partial native index still scans the complete canonical table.
 * Bound that cost and the aggregate number of newly indexed keys; retain all
 * older indexes and data when either budget requires deferral. No errors are
 * caught here: quota failure must roll back with the caller's migration marker.
 */
export function migrateColdReadIndexesV33(sql: SqlStorage): ColdReadIndexCapabilities {
  const capabilities = readColdReadIndexCapabilities(sql);
  if (capabilities.deviceStatusRecent && capabilities.treatmentsApi3Order) return capabilities;
  const oversized = sql.exec<{ present: number }>(`SELECT EXISTS(
    SELECT 1 FROM documents LIMIT 1 OFFSET ${COLD_READ_INDEX_CANONICAL_LIMIT}
  ) AS present`).one().present !== 0;
  if (oversized) return capabilities;

  let remaining = COLD_READ_INDEX_NEW_KEY_LIMIT;
  const countWithinBudget = (collection: string): number => sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM (
    SELECT 1 FROM documents WHERE collection = ? LIMIT ?
  )`, collection, remaining + 1).one().count;
  // One assessment has one aggregate key budget. Prefer API3 treatment time
  // ordering when both missing indexes cannot fit; existing indexes cost no
  // new keys and never reduce this assessment's remaining budget.
  if (!capabilities.treatmentsApi3Order) {
    const count = countWithinBudget("treatments");
    if (count <= remaining) {
      sql.exec(`CREATE INDEX IF NOT EXISTS ${TREATMENTS_API3_ORDER_READ_INDEX}
        ON documents(collection, sort_time DESC, srv_modified DESC, id ASC)
        WHERE collection = 'treatments'`);
      remaining -= count;
    }
  }
  if (!capabilities.deviceStatusRecent) {
    const count = countWithinBudget("devicestatus");
    if (count <= remaining) {
      // Do not add id: legacy SQL exposes the original implicit rowid order
      // for exact sort_time/updated_at ties. The trailing rowid remains ASC.
      sql.exec(`CREATE INDEX IF NOT EXISTS ${DEVICE_STATUS_RECENT_READ_INDEX}
        ON documents(collection, sort_time DESC, updated_at DESC)
        WHERE collection = 'devicestatus'`);
      remaining -= count;
    }
  }
  return readColdReadIndexCapabilities(sql);
}
