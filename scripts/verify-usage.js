#!/usr/bin/env node

const assert = require("assert");
const path = require("path");
const { createJiti } = require("jiti");

const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(__filename, { interopDefault: true });
const {
  billingResponseToSnapshot,
  formatUsageStatus,
  formatUsageSummary,
  XAI_BILLING_URL,
  XAI_USAGE_MANAGE_URL,
  resetXaiUsageRuntimeForTests,
} = jiti(path.join(repoRoot, "extensions", "xai", "usage.ts"));

function testBillingSnapshotWeekly() {
  const snap = billingResponseToSnapshot(
    {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-13T09:30:46.497923+00:00",
          end: "2026-07-20T09:30:46.497923+00:00",
        },
        creditUsagePercent: 4.7,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [{ product: "GrokBuild", usagePercent: 4.0 }],
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
      },
      subscriptionTier: "SuperGrok",
    },
    Date.parse("2026-07-16T12:00:00.000Z"),
  );

  assert.strictEqual(snap.usagePct, 4.7);
  assert.strictEqual(snap.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
  assert.strictEqual(snap.isUnifiedBillingUser, true);
  assert.strictEqual(snap.payAsYouGo, false);
  assert.deepStrictEqual(snap.productLines, ["GrokBuild: 4%"]);
  assert.strictEqual(formatUsageStatus(snap), "xAI Weekly 4%");

  const summary = formatUsageSummary(snap);
  assert.match(summary, /Weekly limit: 4%/);
  assert.match(summary, /Billing: unified pool/);
  assert.match(summary, /By product:/);
  assert.match(summary, /GrokBuild: 4%/);
  assert.ok(summary.includes(XAI_USAGE_MANAGE_URL));
  assert.ok(!summary.includes("Upgrade:"), "upgrade line only at high usage");
}

function testBillingSnapshotHighUsageUpgrade() {
  const snap = billingResponseToSnapshot({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
      creditUsagePercent: 81.2,
      isUnifiedBillingUser: true,
    },
  });
  assert.strictEqual(formatUsageStatus(snap), "xAI Monthly 81%");
  assert.match(formatUsageSummary(snap), /Upgrade:/);
}

function testLegacyMonthlyFields() {
  const snap = billingResponseToSnapshot({
    config: {
      monthlyLimit: { val: 1000 },
      used: { val: 250 },
      billingPeriodEnd: "2026-08-01T00:00:00.000Z",
    },
  });
  assert.strictEqual(snap.usagePct, 25);
  assert.strictEqual(snap.periodEnd, "2026-08-01T00:00:00.000Z");
}

function testPayAsYouGoAndCredits() {
  const snap = billingResponseToSnapshot({
    config: {
      creditUsagePercent: 10,
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 1234 },
      prepaidBalance: { val: -1500 },
      isUnifiedBillingUser: false,
    },
  });
  assert.strictEqual(snap.payAsYouGo, true);
  const summary = formatUsageSummary(snap);
  assert.match(summary, /Credits: \$15/);
  assert.match(summary, /Pay-as-you-go: \$12\.34 used of \$50 limit/);
  assert.match(summary, /legacy \/ PAYG/);
}

function testBillingUrl() {
  assert.strictEqual(XAI_BILLING_URL, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
}

function testCommandRegistration() {
  resetXaiUsageRuntimeForTests();
  const { registerXaiUsage } = jiti(path.join(repoRoot, "extensions", "xai", "usage.ts"));
  const commands = new Map();
  const events = [];
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      events.push([event, handler]);
    },
  };
  registerXaiUsage(pi);
  registerXaiUsage(pi); // idempotent
  assert.ok(commands.has("xai-usage"), "should register /xai-usage");
  assert.ok(!commands.has("usage"), "should not register bare /usage");
  assert.ok(!commands.has("cost"), "should not register /cost");
  assert.ok(events.some(([name]) => name === "session_start"));
  assert.ok(events.some(([name]) => name === "session_shutdown"));

  const completions = commands.get("xai-usage").getArgumentCompletions("re");
  assert.deepStrictEqual(
    completions.map((item) => item.value),
    ["refresh"],
  );
}

async function main() {
  testBillingUrl();
  testBillingSnapshotWeekly();
  testBillingSnapshotHighUsageUpgrade();
  testLegacyMonthlyFields();
  testPayAsYouGoAndCredits();
  testCommandRegistration();
  console.log("verify-usage: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
