import type { XaiUsageSnapshot } from "./usage-parse";

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function formatCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function effectivePercent(usage: XaiUsageSnapshot): number | undefined {
  if (usage.creditUsagePercent !== undefined) return usage.creditUsagePercent;
  if (
    usage.usedCents !== undefined
    && usage.monthlyLimitCents !== undefined
    && usage.monthlyLimitCents > 0
  ) {
    return Math.min(100, (usage.usedCents / usage.monthlyLimitCents) * 100);
  }
  return undefined;
}

/** Render only validated usage fields for the explicit command. */
export function renderXaiUsage(usage: XaiUsageSnapshot): string {
  const lines = ["xAI usage (unofficial, revision-pinned):"];
  const percent = effectivePercent(usage);
  if (usage.subscriptionTier) lines.push(`Subscription: ${usage.subscriptionTier}`);
  if (percent !== undefined) lines.push(`Included usage: ${formatPercent(percent)}`);
  if (usage.usedCents !== undefined || usage.monthlyLimitCents !== undefined) {
    lines.push(
      `Included credits: ${usage.usedCents !== undefined ? `${formatCents(usage.usedCents)} used` : "usage unavailable"}`
      + `${usage.monthlyLimitCents !== undefined ? ` of ${formatCents(usage.monthlyLimitCents)}` : ""}`,
    );
  }
  if (usage.currentPeriod?.start) lines.push(`Period start: ${usage.currentPeriod.start}`);
  if (usage.currentPeriod?.end) lines.push(`Reset: ${usage.currentPeriod.end}`);
  if (usage.onDemandUsedCents !== undefined || usage.onDemandCapCents !== undefined) {
    lines.push(
      `On-demand credits: ${usage.onDemandUsedCents !== undefined ? `${formatCents(usage.onDemandUsedCents)} used` : "usage unavailable"}`
      + `${usage.onDemandCapCents !== undefined ? ` of ${formatCents(usage.onDemandCapCents)}` : ""}`,
    );
  }
  if (usage.prepaidBalanceCents !== undefined) {
    lines.push(`Prepaid balance: ${formatCents(usage.prepaidBalanceCents)}`);
  }
  if (usage.onDemandEnabled !== undefined) {
    lines.push(`On-demand billing: ${usage.onDemandEnabled ? "enabled" : "disabled"}`);
  }
  if (usage.isUnifiedBillingUser !== undefined) {
    lines.push(`Usage pool: ${usage.isUnifiedBillingUser ? "unified" : "standard"}`);
  }
  if (usage.history.length > 0) lines.push(`Validated history periods: ${usage.history.length}`);
  if (lines.length === 1) lines.push("No supported usage fields were returned.");
  return lines.join("\n");
}

/** Render a compact footer value without account identity. */
export function renderXaiUsageStatus(usage: XaiUsageSnapshot): string {
  const percent = effectivePercent(usage);
  const parts = [
    percent !== undefined
      ? `${formatPercent(percent)} used`
      : usage.usedCents !== undefined && usage.monthlyLimitCents !== undefined
        ? `${formatCents(usage.usedCents)}/${formatCents(usage.monthlyLimitCents)}`
        : usage.prepaidBalanceCents !== undefined
          ? `${formatCents(usage.prepaidBalanceCents)} prepaid`
          : "usage available",
  ];
  if (usage.currentPeriod?.end) parts.push(`reset ${usage.currentPeriod.end.slice(0, 10)}`);
  return `xAI ${parts.join(" · ")}`;
}
