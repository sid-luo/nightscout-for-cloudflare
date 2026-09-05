const DURABLE_OBJECT_WRITE_QUOTA_MESSAGE_TEXT =
  "Exceeded allowed rows written in Durable Objects free tier.";

const DURABLE_OBJECT_WRITE_QUOTA_MESSAGE =
  /(?:^|:\s*)Exceeded allowed rows written in Durable Objects free tier\.?$/;

export class DurableObjectWriteQuotaError extends Error {
  constructor() {
    super(DURABLE_OBJECT_WRITE_QUOTA_MESSAGE_TEXT);
    this.name = "DurableObjectWriteQuotaError";
  }
}

/**
 * Cloudflare propagates the platform Error message across Durable Object RPC,
 * but does not preserve arbitrary custom properties. Match only the exact
 * SQLite Durable Objects Free write-quota message observed at that boundary.
 */
export function isDurableObjectWriteQuotaError(error: unknown): boolean {
  return error instanceof Error
    && DURABLE_OBJECT_WRITE_QUOTA_MESSAGE.test(error.message.trim());
}

/** Next Cloudflare Free-plan reset boundary at 00:00 UTC. */
export function durableObjectWriteQuotaResetAt(nowMs = Date.now()): number {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
}

/** Seconds until Cloudflare's next daily Free-plan reset at 00:00 UTC. */
export function durableObjectWriteQuotaRetryAfterSeconds(
  nowMs = Date.now(),
): number {
  const reset = durableObjectWriteQuotaResetAt(nowMs);
  return Math.max(1, Math.min(86_400, Math.ceil((reset - nowMs) / 1_000)));
}

/** Exact platform read-quota failure; keep it distinct from write-only mode. */
export function isDurableObjectReadQuotaError(error: unknown): boolean {
  return error instanceof Error
    && /(?:^|:\s*)Exceeded allowed rows read in Durable Objects free tier\.?$/.test(error.message.trim());
}
