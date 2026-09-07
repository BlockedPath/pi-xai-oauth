import { describe, expect, it } from "vitest";
import { parseXaiUsage, renderXaiUsageCsv } from "../../extensions/xai/usage";
import { XAI_USAGE_MAX_HISTORY_PERIODS } from "../../extensions/xai/constants";
import newCredits from "../fixtures/usage/credits-new.json";
import legacyCredits from "../fixtures/usage/credits-legacy.json";

const header = "record_type,period_type,period_start,period_end,billing_year,billing_month,"
  + "subscription_tier,credit_usage_percent,monthly_limit_cents,included_used_cents,"
  + "on_demand_cap_cents,on_demand_used_cents,total_used_cents,prepaid_balance_cents,"
  + "on_demand_enabled,is_unified_billing_user";

describe("xAI usage CSV rendering", () => {
  it("exports current and historical normalized fields with stable headers and CRLF records", () => {
    expect(renderXaiUsageCsv(parseXaiUsage(newCredits))).toBe([
      header,
      "current,USAGE_PERIOD_TYPE_WEEKLY,2026-07-13T00:00:00Z,2026-07-20T00:00:00Z,,,SuperGrok,42.5,,,5000,300,,1250,true,true",
      "history,USAGE_PERIOD_TYPE_WEEKLY,2026-07-06T00:00:00Z,2026-07-13T00:00:00Z,,,,,,,,120,,,,",
      "",
    ].join("\r\n"));
  });

  it("keeps legacy cents exact and does not invent a percentage or historical subscription", () => {
    expect(renderXaiUsageCsv(parseXaiUsage(legacyCredits))).toBe([
      header,
      "current,,2026-07-01T00:00:00Z,2026-08-01T00:00:00Z,,,,,2000,500,500,0,,,,",
      "history,,,,2026,6,,,,1800,,0,1800,,,",
      "",
    ].join("\r\n"));
  });

  it("leaves missing values blank but preserves zero and false", () => {
    const empty = renderXaiUsageCsv(parseXaiUsage({}));
    expect(empty).toBe(`${header}\r\ncurrent${",".repeat(15)}\r\n`);
    const usage = parseXaiUsage({
      config: { creditUsagePercent: 0, used: {}, isUnifiedBillingUser: false },
      onDemandEnabled: false,
    });
    const cells = renderXaiUsageCsv(usage).split("\r\n")[1].split(",");
    expect(cells).toHaveLength(16);
    expect(cells[7]).toBe("0");
    expect(cells[9]).toBe("0");
    expect(cells.slice(14)).toEqual(["false", "false"]);
  });

  it("quotes commas, doubles quotes, and preserves Unicode labels", () => {
    const usage = parseXaiUsage({ subscriptionTier: 'Super, "Grok" 日本語' });
    expect(renderXaiUsageCsv(usage)).toContain('"Super, ""Grok"" 日本語"');
  });

  it.each(["=1+1", "+1+1", "-1+1", "@SUM(1,2)", "  =1+1", "\u00a0+1+1"])(
    "neutralizes spreadsheet formulas in all free-text columns: %s",
    (label) => {
      const usage = parseXaiUsage({
        subscriptionTier: label,
        config: { currentPeriod: { type: label }, history: [{ period: { type: label } }] },
      });
      const csv = renderXaiUsageCsv(usage);
      expect(csv.split(`'${label.trim()}`)).toHaveLength(4);
      expect(csv).not.toContain(`,${label.trim()},`);
    },
  );

  it("escapes record delimiters defensively while the parser rejects control-bearing labels", () => {
    expect(renderXaiUsageCsv({ history: [], subscriptionTier: "one\r\ntwo" }))
      .toContain('"one\r\ntwo"');
    expect(renderXaiUsageCsv(parseXaiUsage({ subscriptionTier: "one\r\ntwo" })))
      .not.toContain("one");
  });

  it("never enumerates identity, headers, unknown fields, or raw bodies", () => {
    const extra = {
      userId: "PRIVATE_ID",
      email: "PRIVATE_EMAIL",
      headers: { Authorization: "Bearer PRIVATE_TOKEN" },
      rawBody: "PRIVATE_RAW_BODY",
    };
    const parsed = parseXaiUsage({
      ...extra,
      ...newCredits,
      config: { ...newCredits.config, ...extra },
    });
    const usage = {
      ...parsed,
      ...extra,
      currentPeriod: { ...parsed.currentPeriod, ...extra },
      history: parsed.history.map((entry) => ({ ...entry, ...extra })),
    };
    expect(renderXaiUsageCsv(usage)).toBe(renderXaiUsageCsv(parseXaiUsage(newCredits)));
    expect(renderXaiUsageCsv(usage)).not.toMatch(/PRIVATE_|Bearer|userId|headers|rawBody/);
  });

  it("exports at most the parser's bounded history without pagination or truncation", () => {
    const history = Array.from({ length: XAI_USAGE_MAX_HISTORY_PERIODS }, (_, index) => ({
      totalUsed: { val: index },
    }));
    const csv = renderXaiUsageCsv(parseXaiUsage({ config: { history } }));
    const records = csv.trimEnd().split("\r\n");
    expect(records).toHaveLength(XAI_USAGE_MAX_HISTORY_PERIODS + 2);
    expect(records.every((record) => record.split(",").length === 16)).toBe(true);
    expect(records.slice(2).map((record) => record.split(",")[12]))
      .toEqual(history.map((entry) => String(entry.totalUsed.val)));
    expect(() => parseXaiUsage({ config: { history: [...history, {}] } }))
      .toThrow(/too many billing periods/);
  });
});
