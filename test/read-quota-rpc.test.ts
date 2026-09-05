import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";

it("preserves platform read-quota errors through API3 reads and writes for HTTP classification", async () => {
  const stub = env.ENTRY_STORE.getByName(`read-quota-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: EntryStore, state) => {
    const error = new Error("Exceeded allowed rows read in Durable Objects free tier.");
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation(() => { throw error; });
    try {
      await expect(instance.api3QueryCollection("devicestatus")).rejects.toThrow(error.message);
      await expect(instance.api3CreateDocument("devicestatus", JSON.stringify({
        identifier: "quota-test", date: Date.now(), utcOffset: 0, app: "synthetic",
      }), JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true }))).rejects.toThrow(error.message);
    } finally { spy.mockRestore(); }
  });
});
