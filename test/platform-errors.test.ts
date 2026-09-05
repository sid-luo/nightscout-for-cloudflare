import { describe, expect, it } from "vitest";
import {
  DurableObjectWriteQuotaError,
  durableObjectWriteQuotaResetAt,
  durableObjectWriteQuotaRetryAfterSeconds,
  isDurableObjectWriteQuotaError,
  isDurableObjectReadQuotaError,
} from "../src/platform-errors";

describe("Cloudflare platform error contracts", () => {
  it("recognizes only the SQLite Durable Objects Free rows-written quota", () => {
    expect(isDurableObjectWriteQuotaError(
      new Error("Exceeded allowed rows written in Durable Objects free tier."),
    )).toBe(true);
    expect(isDurableObjectWriteQuotaError(
      new DurableObjectWriteQuotaError(),
    )).toBe(true);
    expect(isDurableObjectWriteQuotaError(
      new Error(
        "Error: Exceeded allowed rows written in Durable Objects free tier",
      ),
    )).toBe(true);

    expect(isDurableObjectWriteQuotaError(
      new Error("Exceeded allowed rows read in Durable Objects free tier."),
    )).toBe(false);
    expect(isDurableObjectWriteQuotaError(
      new Error("Exceeded allowed rows written in D1 free tier."),
    )).toBe(false);
    expect(isDurableObjectWriteQuotaError(new Error("quota exceeded"))).toBe(false);
    expect(isDurableObjectWriteQuotaError("Exceeded allowed rows written")).toBe(false);
  });

  it("distinguishes read quota from write quota and unrelated failures", () => {
    expect(isDurableObjectReadQuotaError(new Error(
      "Exceeded allowed rows read in Durable Objects free tier.",
    ))).toBe(true);
    expect(isDurableObjectReadQuotaError(new Error(
      "Error: Exceeded allowed rows read in Durable Objects free tier",
    ))).toBe(true);
    expect(isDurableObjectReadQuotaError(new DurableObjectWriteQuotaError())).toBe(false);
    expect(isDurableObjectReadQuotaError(new Error("quota exceeded"))).toBe(false);
    expect(isDurableObjectReadQuotaError(new Error(
      "Exceeded allowed rows read in D1 free tier.",
    ))).toBe(false);
  });

  it("calculates Retry-After to the next 00:00 UTC reset", () => {
    expect(durableObjectWriteQuotaResetAt(
      Date.parse("2026-07-25T23:59:30.000Z"),
    )).toBe(Date.parse("2026-07-26T00:00:00.000Z"));
    expect(durableObjectWriteQuotaRetryAfterSeconds(
      Date.parse("2026-07-25T23:59:30.000Z"),
    )).toBe(30);
    expect(durableObjectWriteQuotaRetryAfterSeconds(
      Date.parse("2026-07-25T00:00:00.001Z"),
    )).toBe(86_400);
  });
});
