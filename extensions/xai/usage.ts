/**
 * SuperGrok / Grok Build account usage (weekly/monthly credit pool).
 *
 * Mirrors the official Grok Build CLI `/usage` surface by calling:
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * Commands: /xai-usage [show|manage|refresh]
 * Footer:   "xAI Weekly N%" (account pool; independent of the active model)
 *
 * The billing endpoint is used by the open-source Grok Build CLI; it is not a
 * public docs.x.ai REST resource. Parsing fails soft if the payload changes.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveXaiCredential } from "./auth";
import { XAI_CLIENT_IDENTIFIER, XAI_CLIENT_VERSION, XAI_CLI_BASE_URL } from "./constants";

export const XAI_USAGE_STATUS_KEY = "xai-usage";
export const XAI_BILLING_URL = `${XAI_CLI_BASE_URL}/billing?format=credits`;
export const XAI_USAGE_MANAGE_URL = "https://grok.com/?_s=usage";
export const XAI_USAGE_UPGRADE_URL = "https://grok.com/supergrok?referrer=pi-xai-oauth";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Background billing refresh interval while a session is open. */
const AUTO_REFRESH_MS = 60 * 60 * 1000;

export interface Cent {
  val?: number;
}

export interface UsagePeriod {
  type?: string;
  start?: string;
  end?: string;
}

export interface BillingConfig {
  creditUsagePercent?: number;
  currentPeriod?: UsagePeriod;
  monthlyLimit?: Cent;
  used?: Cent;
  onDemandCap?: Cent;
  onDemandUsed?: Cent;
  prepaidBalance?: Cent;
  isUnifiedBillingUser?: boolean;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
}

export interface BillingConfigResponse {
  config?: BillingConfig | null;
  onDemandEnabled?: boolean | null;
  subscriptionTier?: string | null;
  subscription_tier?: string | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  usagePct: number;
  periodType?: string;
  periodStart?: string;
  periodEnd?: string;
  prepaidBalanceCents?: number;
  onDemandCapCents?: number;
  onDemandUsedCents?: number;
  payAsYouGo: boolean;
  isUnifiedBillingUser?: boolean;
  subscriptionTier?: string;
  productLines: string[];
}

interface UsageRuntime {
  cache: UsageSnapshot | null;
  inFlight: Promise<UsageSnapshot> | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
}

const runtime: UsageRuntime = {
  cache: null,
  inFlight: null,
  refreshTimer: null,
};

const usageRegistrations = new WeakSet<object>();

/** Register `/xai-usage` and session footer refresh (once per ExtensionAPI). */
export function registerXaiUsage(pi: ExtensionAPI): void {
  if (usageRegistrations.has(pi as object)) return;
  usageRegistrations.add(pi as object);

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    await handleXaiUsageCommand(args, ctx);
  };

  const getArgumentCompletions = (argumentPrefix: string) => {
    const options = ["show", "manage", "refresh"];
    const prefix = argumentPrefix.trim().toLowerCase();
    return options.filter((option) => option.startsWith(prefix)).map((option) => ({
      value: option,
      label: option,
    }));
  };

  pi.registerCommand("xai-usage", {
    description: "Show SuperGrok / Grok Build weekly usage limit",
    getArgumentCompletions,
    handler,
  });

  if (typeof (pi as any).on === "function") {
    (pi as any).on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      void refreshUsageQuiet(ctx, false);
      stopAutoRefresh();
      runtime.refreshTimer = setInterval(() => {
        void refreshUsageQuiet(ctx, true);
      }, AUTO_REFRESH_MS);
      if (typeof runtime.refreshTimer === "object" && runtime.refreshTimer && "unref" in runtime.refreshTimer) {
        (runtime.refreshTimer as NodeJS.Timeout).unref?.();
      }
    });

    (pi as any).on("session_shutdown", async () => {
      stopAutoRefresh();
      runtime.cache = null;
      runtime.inFlight = null;
    });
  }
}

function stopAutoRefresh(): void {
  if (runtime.refreshTimer) {
    clearInterval(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }
}

export async function handleXaiUsageCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg === "manage") {
    ctx.ui.notify(
      ["Open billing / usage management:", XAI_USAGE_MANAGE_URL, "", "Upgrade SuperGrok:", XAI_USAGE_UPGRADE_URL].join(
        "\n",
      ),
      "info",
    );
    return;
  }

  const force = arg === "refresh";
  if (arg && arg !== "show" && arg !== "refresh") {
    ctx.ui.notify("Usage: /xai-usage [show|manage|refresh]", "error");
    return;
  }

  try {
    const snap = await getUsage(ctx, force);
    paintStatus(ctx, snap);
    ctx.ui.notify(formatUsageSummary(snap), "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.setStatus(XAI_USAGE_STATUS_KEY, undefined);
    ctx.ui.notify(`xAI usage unavailable: ${message}`, "error");
  }
}

async function refreshUsageQuiet(ctx: ExtensionContext, force: boolean): Promise<void> {
  try {
    const snap = await getUsage(ctx, force);
    paintStatus(ctx, snap);
  } catch {
    // Silent: user can run /xai-usage for diagnostics.
  }
}

export async function getUsage(ctx: ExtensionContext, force: boolean): Promise<UsageSnapshot> {
  if (!force && runtime.cache && Date.now() - runtime.cache.fetchedAt < CACHE_TTL_MS) {
    return runtime.cache;
  }
  if (!force && runtime.inFlight) return runtime.inFlight;

  runtime.inFlight = (async () => {
    const credential = await resolveXaiCredential(ctx);
    const token = credential?.token?.trim();
    if (!token) {
      throw new Error("No xAI OAuth token found. Run `/login xai-auth` (or `grok login`), then retry.");
    }

    const response = await fetch(XAI_BILLING_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": `${XAI_CLIENT_IDENTIFIER}/${XAI_CLIENT_VERSION}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      const detail = extractErrorDetail(text) || `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`${detail}. Re-auth with /login xai-auth.`);
      }
      throw new Error(detail);
    }

    let body: BillingConfigResponse;
    try {
      body = JSON.parse(text) as BillingConfigResponse;
    } catch {
      throw new Error("Billing response was not valid JSON");
    }

    const snap = billingResponseToSnapshot(body, Date.now());
    runtime.cache = snap;
    return snap;
  })();

  try {
    return await runtime.inFlight;
  } finally {
    runtime.inFlight = null;
  }
}

/** Pure: map billing JSON into a display snapshot. */
export function billingResponseToSnapshot(body: BillingConfigResponse, fetchedAt = Date.now()): UsageSnapshot {
  const config = body.config || {};
  const period = config.currentPeriod;

  const usagePct = normalizePct(
    config.creditUsagePercent ?? deriveLegacyPct(config.used?.val, config.monthlyLimit?.val) ?? 0,
  );

  const onDemandCap = config.onDemandCap?.val ?? 0;
  const onDemandUsed = config.onDemandUsed?.val ?? 0;
  const payAsYouGo = Math.abs(onDemandCap) > 0;

  const productLines = (config.productUsage || [])
    .filter((product) => product && (product.product || product.usagePercent != null))
    .map((product) => {
      const name = product.product || "product";
      const pct = product.usagePercent != null ? `${normalizePct(product.usagePercent)}%` : "?";
      return `${name}: ${pct}`;
    });

  const tier = body.subscriptionTier || body.subscription_tier || undefined;

  return {
    fetchedAt,
    usagePct,
    periodType: period?.type || undefined,
    periodStart: period?.start || config.billingPeriodStart || undefined,
    periodEnd: period?.end || config.billingPeriodEnd || undefined,
    prepaidBalanceCents: config.prepaidBalance?.val,
    onDemandCapCents: onDemandCap || undefined,
    onDemandUsedCents: onDemandUsed || undefined,
    payAsYouGo,
    isUnifiedBillingUser: config.isUnifiedBillingUser,
    subscriptionTier: typeof tier === "string" ? tier : undefined,
    productLines,
  };
}

export function formatUsageSummary(snap: UsageSnapshot): string {
  // Floor % like Grok Build (never show 100 until truly exhausted).
  const pct = Math.floor(snap.usagePct);
  const lines: string[] = [];
  lines.push(`${usageLabel(snap.periodType)}: ${pct}%`);

  const reset = formatPeriodEnd(snap.periodEnd);
  if (reset) lines.push(`Next reset: ${reset}`);

  if (snap.subscriptionTier) lines.push(`Plan: ${snap.subscriptionTier}`);

  if (snap.isUnifiedBillingUser != null) {
    lines.push(`Billing: ${snap.isUnifiedBillingUser ? "unified pool" : "legacy / PAYG"}`);
  }

  const prepaid = snap.prepaidBalanceCents;
  if (prepaid != null && Math.abs(prepaid) > 0) {
    lines.push("");
    lines.push(`Credits: ${fmtDollarsFromCents(prepaid)}`);
  }

  if (snap.payAsYouGo) {
    const used = snap.onDemandUsedCents ?? 0;
    const cap = snap.onDemandCapCents ?? 0;
    lines.push("");
    lines.push(`Pay-as-you-go: ${fmtDollarsFromCents(used)} used of ${fmtDollarsFromCents(cap)} limit`);
  }

  if (snap.productLines.length > 0) {
    lines.push("");
    lines.push("By product:");
    for (const line of snap.productLines) lines.push(`  ${line}`);
  }

  lines.push("");
  lines.push(`Manage: ${XAI_USAGE_MANAGE_URL}`);
  if (pct >= 80) lines.push(`Upgrade: ${XAI_USAGE_UPGRADE_URL}`);
  lines.push(`Fetched: ${new Date(snap.fetchedAt).toLocaleTimeString()}`);

  return lines.join("\n");
}

export function formatUsageStatus(snap: UsageSnapshot): string {
  const pct = Math.floor(snap.usagePct);
  const period = footerPeriodLabel(snap.periodType);
  return period ? `xAI ${period} ${pct}%` : `xAI ${pct}%`;
}

function paintStatus(ctx: ExtensionContext | ExtensionCommandContext, snap: UsageSnapshot): void {
  ctx.ui.setStatus(XAI_USAGE_STATUS_KEY, formatUsageStatus(snap));
}

function usageLabel(periodType?: string): string {
  const type = (periodType || "").toUpperCase();
  if (type.includes("WEEKLY")) return "Weekly limit";
  if (type.includes("MONTHLY")) return "Monthly limit";
  return "Usage";
}

function footerPeriodLabel(periodType?: string): string | undefined {
  const type = (periodType || "").toUpperCase();
  if (type.includes("WEEKLY")) return "Weekly";
  if (type.includes("MONTHLY")) return "Monthly";
  return undefined;
}

function formatPeriodEnd(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDollarsFromCents(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  if (dollars === Math.trunc(dollars)) return `$${dollars.toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

function deriveLegacyPct(used?: number, limit?: number): number | undefined {
  if (used == null || limit == null) return undefined;
  const absoluteUsed = Math.abs(used);
  const absoluteLimit = Math.abs(limit);
  if (absoluteLimit <= 0) return undefined;
  return (absoluteUsed / absoluteLimit) * 100;
}

function normalizePct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function extractErrorDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as any;
    if (typeof parsed?.error === "string") return parsed.error;
    if (typeof parsed?.error?.message === "string") return parsed.error.message;
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // ignore
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

/** Test helper: clear module runtime state. */
export function resetXaiUsageRuntimeForTests(): void {
  stopAutoRefresh();
  runtime.cache = null;
  runtime.inFlight = null;
}
