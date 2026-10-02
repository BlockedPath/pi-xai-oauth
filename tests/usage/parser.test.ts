import { describe, expect, it } from "vitest";
import { parseXaiUsage, parseXaiUserId } from "../../extensions/xai/usage-parse";
import {
  renderXaiUsage,
  renderXaiUsageStatus,
} from "../../extensions/xai/usage-render";
import newCredits from "../fixtures/usage/credits-new.json";
import legacyCredits from "../fixtures/usage/credits-legacy.json";
import identity from "../fixtures/usage/identity.json";

describe("xAI usage parsing", () => {
  it("extracts only a bounded header-safe identity", () => {
    expect(parseXaiUserId(identity)).toBe("user-fixture-82");
    for (const invalid of [
      {},
      { userId: "" },
      { userId: "user\r\nx-userid: attacker" },
      { userId: "x".repeat(257) },
      { userId: 82 },
    ]) {
      expect(() => parseXaiUserId(invalid)).toThrow(/identity could not be verified/);
    }
  });

  it("parses and renders the observed credits shape", () => {
    const usage = parseXaiUsage(newCredits);
    expect(usage).toMatchObject({
      creditUsagePercent: 42.5,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        end: "2026-07-20T00:00:00Z",
      },
      onDemandCapCents: 5000,
      onDemandUsedCents: 300,
      prepaidBalanceCents: 1250,
      isUnifiedBillingUser: true,
      onDemandEnabled: true,
      subscriptionTier: "SuperGrok",
    });
    expect(usage.history).toHaveLength(1);
    expect(renderXaiUsage(usage)).toContain("Included usage: 42.5%");
    expect(renderXaiUsage(usage)).toContain("Reset: 2026-07-20T00:00:00Z");
    expect(renderXaiUsageStatus(usage)).toBe("xAI 42.5% used · reset 2026-07-20");
  });

  it("supports only observed legacy fallbacks and proto zero-cent wrappers", () => {
    const usage = parseXaiUsage(legacyCredits);
    expect(usage).toMatchObject({
      monthlyLimitCents: 2000,
      usedCents: 500,
      onDemandCapCents: 500,
      onDemandUsedCents: 0,
      currentPeriod: {
        start: "2026-07-01T00:00:00Z",
        end: "2026-08-01T00:00:00Z",
      },
    });
    expect(usage.history[0]).toMatchObject({
      billingCycle: { year: 2026, month: 6 },
      includedUsedCents: 1800,
      totalUsedCents: 1800,
    });
    expect(renderXaiUsage(usage)).toContain("Included usage: 25%");
  });

  it("handles null/missing config and ignores unsupported or out-of-range optional values", () => {
    expect(parseXaiUsage({ config: null, subscriptionTier: "Pro" })).toEqual({
      history: [],
      subscriptionTier: "Pro",
    });
    expect(parseXaiUsage({})).toEqual({ history: [] });
    expect(parseXaiUsage({
      config: {
        creditUsagePercent: 101,
        monthlyLimit: { val: -1 },
        used: { val: Number.MAX_SAFE_INTEGER },
        currentPeriod: { end: "not-a-time" },
        billingPeriodStart: "2026-02-30T00:00:00Z",
        billingPeriodEnd: "2026-01-01T24:00:00Z",
        history: [{ billingCycle: { year: 1900, month: 13 } }],
      },
      subscriptionTier: "x".repeat(81),
    })).toEqual({ history: [] });
  });

  it("rejects malformed, over-deep, and over-count response shapes", () => {
    expect(() => parseXaiUsage([])).toThrow(/invalid response/);
    expect(() => parseXaiUsage({ config: "bad" })).toThrow(/invalid response/);
    expect(() => parseXaiUsage({ config: { history: {} } })).toThrow(/invalid billing history/);
    expect(() => parseXaiUsage({
      config: { history: Array.from({ length: 25 }, () => ({})) },
    })).toThrow(/too many billing periods/);
    expect(() => parseXaiUsage({ unrelated: Array.from({ length: 65 }, () => 1) }))
      .toThrow(/too many response entries/);
    expect(parseXaiUsage(Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`field${index}`, null]),
    ))).toEqual({ history: [] });
    expect(() => parseXaiUsage(Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`field${index}`, null]),
    ))).toThrow(/too many response fields/);

    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 14; index += 1) nested = { nested };
    expect(() => parseXaiUsage(nested)).toThrow(/over-complex response/);

    const tree = (depth: number): unknown =>
      depth === 0 ? null : { left: tree(depth - 1), right: tree(depth - 1) };
    expect(() => parseXaiUsage(tree(11))).toThrow(/over-complex response/);
  });

  it("accepts real leap days but omits impossible calendar timestamps", () => {
    expect(parseXaiUsage({
      config: { billingPeriodStart: "2024-02-29T00:00:00Z" },
    }).currentPeriod).toEqual({ start: "2024-02-29T00:00:00Z" });
    expect(parseXaiUsage({
      config: {
        billingPeriodStart: "2026-02-30T00:00:00Z",
        billingPeriodEnd: "2026-01-01T24:00:00Z",
      },
    }).currentPeriod).toBeUndefined();
  });
});
