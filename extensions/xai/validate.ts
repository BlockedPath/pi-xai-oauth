const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** Whether a value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the value as a plain record, or `undefined` for null, arrays, and primitives. */
export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Return a safe positive integer no larger than `maximum`, otherwise `undefined`. */
export function positiveInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

/** Whether text contains an ASCII control character (U+0000–U+001F or U+007F). */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}
