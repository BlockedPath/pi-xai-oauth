/** MIME types accepted for image-edit references and generated output. */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg"] as const;

/** Source-backed xAI Imagine reference-image limits. */
export const MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES = 400 * 1024;
export const MEDIA_REFERENCE_COMPRESS_MAX_SIDE_PX = 768;
export const MEDIA_REFERENCE_COMPRESS_MIN_SIDE_PX = 256;
export const MEDIA_REFERENCE_QUALITY_STEPS = [80, 65, 50, 35] as const;
export const MEDIA_MAX_SOURCE_PIXELS = 12_000_000;

/** Package-owned input and request budgets. */
export const MEDIA_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MEDIA_MAX_DATA_URL_CHARS = 12 * 1024 * 1024;
export const IMAGE_EDIT_MAX_REFERENCES = 3;
export const IMAGE_EDIT_MAX_AGGREGATE_REFERENCE_BYTES =
  3 * MEDIA_REFERENCE_PASSTHROUGH_MAX_BYTES;
export const IMAGE_EDIT_MAX_PROMPT_CHARS = 4_000;
export const IMAGE_EDIT_MAX_PROMPT_BYTES = 16 * 1024;
export const IMAGE_EDIT_MAX_REQUEST_JSON_BYTES = 3 * 1024 * 1024;

/** Package-owned network and response budgets. */
export const IMAGE_EDIT_REQUEST_TIMEOUT_MS = 120_000;
export const IMAGE_EDIT_MAX_RESPONSE_JSON_BYTES = 24 * 1024 * 1024;
export const IMAGE_EDIT_MAX_OUTPUT_BASE64_CHARS = 24 * 1024 * 1024;
export const IMAGE_EDIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const IMAGE_EDIT_MAX_OUTPUT_PIXELS = 16_000_000;
export const IMAGE_EDIT_MAX_OUTPUT_SIDE_PX = 4_096;

/** Fixed source-backed image-edit request fields. */
export const IMAGE_EDIT_MODEL = "grok-imagine-image-2.0";
export const IMAGE_EDIT_RESOLUTION = "1k";
export const IMAGE_EDIT_RESPONSE_FORMAT = "b64_json";
export const IMAGE_EDIT_OUTPUT_COUNT = 1;

/** Source-backed image-to-video request and transport limits. */
export const IMAGE_TO_VIDEO_MODEL = "grok-imagine-video-1.5-preview";
export const IMAGE_TO_VIDEO_DURATIONS = [6, 10] as const;
export const IMAGE_TO_VIDEO_RESOLUTIONS = ["480p", "720p"] as const;
export const IMAGE_TO_VIDEO_DEFAULT_DURATION = 6;
export const IMAGE_TO_VIDEO_DEFAULT_RESOLUTION = "480p";
export const IMAGE_TO_VIDEO_MAX_PROMPT_CHARS = 4_000;
export const IMAGE_TO_VIDEO_MAX_PROMPT_BYTES = 16 * 1024;
export const IMAGE_TO_VIDEO_MAX_JSON_BYTES = 64 * 1024;
export const IMAGE_TO_VIDEO_CREATE_TIMEOUT_MS = 60_000;
export const IMAGE_TO_VIDEO_POLL_TIMEOUT_MS = 30_000;
export const IMAGE_TO_VIDEO_POLL_INTERVAL_MS = 5_000;
export const IMAGE_TO_VIDEO_GENERATION_TIMEOUT_MS = 300_000;
export const IMAGE_TO_VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
export const IMAGE_TO_VIDEO_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const IMAGE_TO_VIDEO_MAX_DOWNLOAD_URL_CHARS = 8 * 1024;
export const IMAGE_TO_VIDEO_MP4_PREFIX_BYTES = 4 * 1024;

/** Safe output permissions. */
export const IMAGE_EDIT_OUTPUT_DIRECTORY_MODE = 0o700;
export const IMAGE_EDIT_OUTPUT_FILE_MODE = 0o600;
