/** Build a simple user text input array for xAI Responses requests. */
export function xaiTextInput(text: string): Array<{ role: "user"; content: string }> {
  return [{ role: "user", content: text }];
}

/**
 * The shared JSON-schema shape for one bounded image reference: either a
 * workspace path or a strict PNG/JPEG data URL, never both.
 */
export const XAI_IMAGE_REFERENCE_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { path: { type: "string", description: "PNG/JPEG path inside the current workspace" } },
      required: ["path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { data_url: { type: "string", description: "Strict bounded PNG/JPEG base64 data URL" } },
      required: ["data_url"],
      additionalProperties: false,
    },
  ],
} as const;

/** Return a pi tool error result with optional structured details. */
export function xaiToolError(message: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: message }], details };
}
