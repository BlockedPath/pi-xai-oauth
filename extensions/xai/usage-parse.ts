import {
  XAI_USAGE_MAX_HISTORY_PERIODS,
  XAI_USAGE_MAX_JSON_ARRAY_ITEMS,
  XAI_USAGE_MAX_JSON_DEPTH,
  XAI_USAGE_MAX_JSON_NODES,
  XAI_USAGE_MAX_JSON_OBJECT_KEYS,
} from "./constants";
import { hasControlCharacter, objectValue } from "./validate";

const MAX_USER_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_CENTS = 1_000_000_000_000;
const MIN_BILLING_YEAR = 2000;
const MAX_BILLING_YEAR = 2200;
const USER_ID_PATTERN = /^[\x21-\x7e]+$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export interface XaiUsagePeriod {
  type?: string;
  start?: string;
  end?: string;
}

export interface XaiUsageHistoryPeriod {
  period?: XaiUsagePeriod;
  billingCycle?: { year: number; month: number };
  includedUsedCents?: number;
  onDemandUsedCents?: number;
  totalUsedCents?: number;
}

export interface XaiUsageSnapshot {
  creditUsagePercent?: number;
  currentPeriod?: XaiUsagePeriod;
  monthlyLimitCents?: number;
  usedCents?: number;
  onDemandCapCents?: number;
  onDemandUsedCents?: number;
  prepaidBalanceCents?: number;
  isUnifiedBillingUser?: boolean;
  onDemandEnabled?: boolean;
  subscriptionTier?: string;
  history: XaiUsageHistoryPeriod[];
}

type XaiUsageErrorCode =
  | "auth"
  | "cancelled"
  | "http"
  | "invalid"
  | "oversize"
  | "timeout"
  | "transport";

/** A user-safe usage failure that never includes response bodies, credentials, or identity. */
export class XaiUsageError extends Error {
  readonly code: XaiUsageErrorCode;
  readonly status?: number;

  constructor(code: XaiUsageErrorCode, message: string, status?: number) {
    super(message);
    this.name = "XaiUsageError";
    this.code = code;
    this.status = status;
  }
}

interface JsonBudget {
  nodes: number;
}

function assertBoundedJson(value: unknown, depth = 0, budget: JsonBudget = { nodes: 0 }): void {
  if (depth > XAI_USAGE_MAX_JSON_DEPTH || ++budget.nodes > XAI_USAGE_MAX_JSON_NODES) {
    throw new XaiUsageError("invalid", "xAI usage returned an over-complex response.");
  }
  if (Array.isArray(value)) {
    if (value.length > XAI_USAGE_MAX_JSON_ARRAY_ITEMS) {
      throw new XaiUsageError("invalid", "xAI usage returned too many response entries.");
    }
    for (const item of value) assertBoundedJson(item, depth + 1, budget);
    return;
  }
  const obj = objectValue(value);
  if (!obj) return;
  const values = Object.values(obj);
  if (values.length > XAI_USAGE_MAX_JSON_OBJECT_KEYS) {
    throw new XaiUsageError("invalid", "xAI usage returned too many response fields.");
  }
  for (const item of values) assertBoundedJson(item, depth + 1, budget);
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH && !hasControlCharacter(label)
    ? label
    : undefined;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH) return undefined;
  const match = value.match(RFC3339_PATTERN);
  if (!match) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function boundedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function boundedCents(value: unknown): number | undefined {
  const wrapper = objectValue(value);
  if (!wrapper) return undefined;
  const cents = wrapper.val === undefined ? 0 : wrapper.val;
  return typeof cents === "number"
    && Number.isSafeInteger(cents)
    && cents >= 0
    && cents <= MAX_CENTS
    ? cents
    : undefined;
}

function usagePeriod(value: unknown): XaiUsagePeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: XaiUsagePeriod = {};
  const type = boundedLabel(obj.type);
  const start = boundedTimestamp(obj.start);
  const end = boundedTimestamp(obj.end);
  if (type) result.type = type;
  if (start) result.start = start;
  if (end) result.end = end;
  return Object.keys(result).length > 0 ? result : undefined;
}

function billingCycle(value: unknown): { year: number; month: number } | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const { year, month } = obj;
  return Number.isSafeInteger(year)
    && Number.isSafeInteger(month)
    && (year as number) >= MIN_BILLING_YEAR
    && (year as number) <= MAX_BILLING_YEAR
    && (month as number) >= 1
    && (month as number) <= 12
    ? { year: year as number, month: month as number }
    : undefined;
}

function historyPeriod(value: unknown): XaiUsageHistoryPeriod | undefined {
  const obj = objectValue(value);
  if (!obj) return undefined;
  const result: XaiUsageHistoryPeriod = {};
  const period = usagePeriod(obj.period);
  const cycle = billingCycle(obj.billingCycle);
  const included = boundedCents(obj.includedUsed);
  const onDemand = boundedCents(obj.onDemandUsed);
  const total = boundedCents(obj.totalUsed);
  if (period) result.period = period;
  if (cycle) result.billingCycle = cycle;
  if (included !== undefined) result.includedUsedCents = included;
  if (onDemand !== undefined) result.onDemandUsedCents = onDemand;
  if (total !== undefined) result.totalUsedCents = total;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Extract a transient header-safe user ID from the authenticated `/user` response. */
export function parseXaiUserId(value: unknown): string {
  assertBoundedJson(value);
  const userId = objectValue(value)?.userId;
  if (
    typeof userId !== "string"
    || !userId
    || userId.length > MAX_USER_ID_LENGTH
    || !USER_ID_PATTERN.test(userId)
  ) {
    throw new XaiUsageError(
      "invalid",
      "xAI account identity could not be verified; billing was not requested.",
    );
  }
  return userId;
}

/** Parse the bounded observed credits response without retaining its raw representation. */
export function parseXaiUsage(value: unknown): XaiUsageSnapshot {
  assertBoundedJson(value);
  const root = objectValue(value);
  if (!root) throw new XaiUsageError("invalid", "xAI usage returned an invalid response.");
  if (root.config !== undefined && root.config !== null && !objectValue(root.config)) {
    throw new XaiUsageError("invalid", "xAI usage returned an invalid response.");
  }
  const config = objectValue(root.config);
  const snapshot: XaiUsageSnapshot = { history: [] };
  if (typeof root.onDemandEnabled === "boolean") snapshot.onDemandEnabled = root.onDemandEnabled;
  const tier = boundedLabel(root.subscriptionTier);
  if (tier) snapshot.subscriptionTier = tier;
  if (!config) return snapshot;

  const history = config.history;
  if (history !== undefined && !Array.isArray(history)) {
    throw new XaiUsageError("invalid", "xAI usage returned invalid billing history.");
  }
  if (Array.isArray(history) && history.length > XAI_USAGE_MAX_HISTORY_PERIODS) {
    throw new XaiUsageError("invalid", "xAI usage returned too many billing periods.");
  }

  const percent = boundedPercent(config.creditUsagePercent);
  const currentPeriod = usagePeriod(config.currentPeriod);
  const monthlyLimit = boundedCents(config.monthlyLimit);
  const used = boundedCents(config.used);
  const onDemandCap = boundedCents(config.onDemandCap);
  const onDemandUsed = boundedCents(config.onDemandUsed);
  const prepaid = boundedCents(config.prepaidBalance);
  if (percent !== undefined) snapshot.creditUsagePercent = percent;
  if (currentPeriod) snapshot.currentPeriod = currentPeriod;
  if (monthlyLimit !== undefined) snapshot.monthlyLimitCents = monthlyLimit;
  if (used !== undefined) snapshot.usedCents = used;
  if (onDemandCap !== undefined) snapshot.onDemandCapCents = onDemandCap;
  if (onDemandUsed !== undefined) snapshot.onDemandUsedCents = onDemandUsed;
  if (prepaid !== undefined) snapshot.prepaidBalanceCents = prepaid;
  if (typeof config.isUnifiedBillingUser === "boolean") {
    snapshot.isUnifiedBillingUser = config.isUnifiedBillingUser;
  }
  const fallbackStart = boundedTimestamp(config.billingPeriodStart);
  const fallbackEnd = boundedTimestamp(config.billingPeriodEnd);
  if (!snapshot.currentPeriod && (fallbackStart || fallbackEnd)) {
    snapshot.currentPeriod = {
      ...(fallbackStart ? { start: fallbackStart } : {}),
      ...(fallbackEnd ? { end: fallbackEnd } : {}),
    };
  }
  if (Array.isArray(history)) {
    snapshot.history = history
      .map(historyPeriod)
      .filter((entry): entry is XaiUsageHistoryPeriod => entry !== undefined);
  }
  return snapshot;
}
