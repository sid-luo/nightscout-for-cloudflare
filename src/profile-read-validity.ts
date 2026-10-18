import type { LegacyReadCache } from "./legacy-read-cache";

const KEY = "\0profile-read-validity:v1";
const BATCH_ROWS = 5000;
const MAX_BODY_BYTES = 128 * 1024;
const VOLATILE_ROWS = 10000;
const VOLATILE_WORK_BYTES = 4 * 1024 * 1024;
interface Row extends Record<string, SqlStorageValue> { id: string; body: SqlStorageValue; valid_json: number }
type Progress = [number, "partial" | "complete" | "rejected", string | null];
interface Scan { after: string | null; done: boolean; rejected: boolean }
type Tail = { kind: "empty" } | { kind: "rejected" } | { kind: "row"; id: string; workBytes: number };

/** Whole-collection validity only; mutable activations never retain a successful proof. */
export class ProfileReadValidity {
  private anchor: number | undefined;
  private unsafe = true;
  private initialized = false;
  private volatileRefused = false;

  constructor(private readonly sql: SqlStorage, private readonly cache: LegacyReadCache) {}

  /** Seal once after constructor migrations and recovery; never after a write. */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const changes = this.changes();
      if (Number.isSafeInteger(changes) && changes >= 0) { this.anchor = changes; this.unsafe = false; }
    } catch { /* An unavailable optional marker leaves the original read path. */ }
  }

  private changes(): number {
    return this.sql.exec<{ changes: number }>("SELECT total_changes() AS changes").one().changes;
  }

  /** Rollback does not reset total_changes, so any row-DML change stays unsafe. */
  isCurrent(): boolean {
    if (this.unsafe || this.anchor === undefined) return false;
    if (this.changes() !== this.anchor) { this.unsafe = true; return false; }
    return true;
  }

  /** The callback must finish synchronously, without yielding to another request. */
  withCurrentRead<T>(read: () => T): { value: T } | undefined {
    if (this.ensure()) {
      const value = read();
      return this.isCurrent() ? { value } : undefined;
    }
    // Keep the existing read-only partial/rejected policy. Only a DML-invalidated
    // activation can use this per-request proof; never re-seal its old anchor.
    if (!this.unsafe || this.anchor === undefined || this.volatileRefused) return undefined;
    const generation = this.cache.generation;
    const changes = this.changes();
    if (!Number.isSafeInteger(changes) || changes < 0) {
      this.volatileRefused = true;
      return undefined;
    }
    // The greatest PK is part of this same proof, rather than an extra sample.
    // An unsupported tail can decline before walking the complete prefix.
    const tail = this.scanTail();
    const proof: Scan = tail.kind === "empty" ? { after: null, done: true, rejected: false }
      : tail.kind === "rejected" ? { after: null, done: false, rejected: true }
        : this.scan(null, VOLATILE_ROWS - 1, VOLATILE_WORK_BYTES - tail.workBytes, tail.id);
    if (!proof.done || proof.rejected) {
      // This flag only declines optional work. It never authorizes a cached read,
      // so a refusal inside a transaction may safely survive its rollback.
      this.volatileRefused = true;
      return undefined;
    }
    if (generation !== this.cache.generation || changes !== this.changes()) return undefined;
    const value = read();
    return generation === this.cache.generation && changes === this.changes() ? { value } : undefined;
  }

  ensure(): boolean {
    if (!this.isCurrent()) return false;
    const generation = this.cache.generation;
    let after: string | null = null;
    const serialized = this.cache.get(KEY);
    if (serialized !== undefined) {
      try {
        const value: unknown = JSON.parse(serialized);
        if (!Array.isArray(value) || value.length !== 3 || value[0] !== this.anchor
          || !["partial", "complete", "rejected"].includes(value[1] as string)
          || !(value[2] === null || typeof value[2] === "string")) return false;
        const progress = value as Progress;
        if (progress[1] === "complete") return true;
        if (progress[1] === "rejected") return false;
        after = progress[2];
      } catch { return false; }
    }
    const proof = this.scan(after, BATCH_ROWS);
    if (generation !== this.cache.generation || !this.isCurrent()) return false;
    const progress: Progress = [this.anchor!, proof.rejected ? "rejected" : proof.done ? "complete" : "partial", proof.after];
    const admitted = this.cache.set(KEY, JSON.stringify(progress));
    return admitted && proof.done && !proof.rejected;
  }

  /** Retain only scalar proof metadata; no tail body survives into the prefix. */
  private scanTail(): Tail {
    let iterator: Iterator<Row> | undefined;
    let done = false, throwing = false;
    try {
      const supported = `typeof(body)='text' AND length(CAST(body AS BLOB))<=${MAX_BODY_BYTES}`;
      iterator = this.sql.exec<Row>(`SELECT id,
        CASE WHEN ${supported} THEN body ELSE NULL END AS body,
        CASE WHEN ${supported} THEN json_valid(body) ELSE 0 END AS valid_json FROM documents
        WHERE collection='profile' ORDER BY id DESC LIMIT 1`)[Symbol.iterator]();
      const next = iterator.next();
      if (next.done) { done = true; return { kind: "empty" }; }
      const row = next.value;
      if (typeof row.id !== "string" || !/^[\x20-\x7e]{1,128}$/.test(row.id)
        || typeof row.body !== "string" || row.valid_json !== 1) return { kind: "rejected" };
      const workBytes = row.body.length * 2;
      if (workBytes > VOLATILE_WORK_BYTES) return { kind: "rejected" };
      try { JSON.parse(row.body); } catch { return { kind: "rejected" }; }
      // LIMIT 1 must have genuinely finished before publishing any proof.
      if (!iterator.next().done) return { kind: "rejected" };
      done = true;
      return { kind: "row", id: row.id, workBytes };
    } catch (error) { throwing = true; throw error; }
    finally {
      if (!done && iterator !== undefined) {
        try { iterator.return?.(); } catch (error) { if (!throwing) throw error; }
      }
    }
  }

  private scan(after: string | null, maxRows: number, maxWorkBytes?: number, before?: string): Scan {
    let iterator: Iterator<Row> | undefined;
    let done = false, throwing = false, processed = 0, rejected = false;
    let workBytes = 0;
    try {
      const supported = `typeof(body)='text' AND length(CAST(body AS BLOB))<=${MAX_BODY_BYTES}`;
      iterator = this.sql.exec<Row>(`SELECT id,
        CASE WHEN ${supported} THEN body ELSE NULL END AS body,
        CASE WHEN ${supported} THEN json_valid(body) ELSE 0 END AS valid_json FROM documents
        WHERE collection='profile'${after === null ? "" : " AND id > ?"}${before === undefined ? "" : " AND id < ?"}
        ORDER BY id ASC LIMIT ${maxRows + 1}`, ...(after === null ? [] : [after]),
      ...(before === undefined ? [] : [before]))[Symbol.iterator]();
      for (;;) {
        const next = iterator.next();
        if (next.done) { done = true; break; }
        if (processed === maxRows) break;
        const row = next.value;
        // Keyset bindings must round-trip to the exact SQLite BINARY key.
        // Unsupported historical ids/body sizes decline only this shortcut.
        if (typeof row.id !== "string" || !/^[\x20-\x7e]{1,128}$/.test(row.id)
          || typeof row.body !== "string" || row.valid_json !== 1) { rejected = true; break; }
        workBytes += row.body.length * 2;
        if (maxWorkBytes !== undefined && workBytes > maxWorkBytes) { rejected = true; break; }
        try { JSON.parse(row.body); } catch { rejected = true; break; }
        after = row.id; processed++;
      }
    } catch (error) { throwing = true; throw error; }
    finally {
      if (!done && iterator !== undefined) {
        try { iterator.return?.(); } catch (error) { if (!throwing) throw error; }
      }
    }
    return { after, done, rejected };
  }
}
