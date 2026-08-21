import packageMetadata from "../../package.json";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_AUTHORIZATION_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_DEVICE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_OAUTH_JWKS_URL = `${XAI_OAUTH_ISSUER}/.well-known/jwks.json`;
export const XAI_OAUTH_ID_TOKEN_ALGORITHM = "ES256";
export const XAI_OAUTH_PKCE_METHOD = "S256";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"; // gitleaks:allow — public OAuth client identifier
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
export const XAI_OAUTH_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const XAI_OAUTH_DEVICE_DEFAULT_INTERVAL_SECONDS = 5;
export const XAI_OAUTH_DEVICE_MIN_INTERVAL_SECONDS = 1;
export const XAI_OAUTH_DEVICE_SLOW_DOWN_SECONDS = 5;
export const XAI_OAUTH_DEVICE_MAX_DURATION_MS = 15 * 60 * 1000;
export const XAI_OAUTH_DEVICE_REQUEST_TIMEOUT_MS = 15 * 1000;
export const XAI_OAUTH_DEVICE_MAX_RESPONSE_BYTES = 64 * 1024;
export const XAI_OAUTH_DEVICE_VERIFICATION_ORIGINS = [XAI_OAUTH_ISSUER, "https://accounts.x.ai"] as const;

export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
export const XAI_CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
export const XAI_CLI_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models-v2";
export const XAI_CLI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const XAI_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const XAI_IMAGES_GENERATIONS_URL = "https://api.x.ai/v1/images/generations";
export const XAI_IMAGES_EDITS_URL = "https://api.x.ai/v1/images/edits";
export const XAI_VIDEOS_GENERATIONS_URL = "https://api.x.ai/v1/videos/generations";
export const XAI_VIDEOS_STATUS_PREFIX = "https://api.x.ai/v1/videos/";

export const XAI_MODEL_CATALOG_CACHE_SCHEMA = 2;
export const XAI_MODEL_CATALOG_FRESH_TTL_MS = 15 * 60 * 1000;
export const XAI_MODEL_CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const XAI_MODEL_CATALOG_TIMEOUT_MS = 5 * 1000;
export const XAI_MODEL_CATALOG_MAX_BYTES = 1024 * 1024;

export const XAI_USAGE_TIMEOUT_MS = 15 * 1000;
export const XAI_USAGE_MAX_RESPONSE_BYTES = 64 * 1024;
export const XAI_USAGE_MAX_JSON_DEPTH = 12;
export const XAI_USAGE_MAX_JSON_ARRAY_ITEMS = 64;
export const XAI_USAGE_MAX_JSON_OBJECT_KEYS = 64;
export const XAI_USAGE_MAX_JSON_NODES = 2048;
export const XAI_USAGE_MAX_HISTORY_PERIODS = 24;
export const XAI_USAGE_STATUS_MIN_REFRESH_MS = 60 * 1000;

export const XAI_CLIENT_IDENTIFIER = packageMetadata.name;
export const XAI_PACKAGE_VERSION = packageMetadata.version;
export const XAI_PROXY_CLIENT_VERSION = XAI_PACKAGE_VERSION;
export const XAI_CLIENT_VERSION = XAI_PROXY_CLIENT_VERSION;
export const XAI_USER_AGENT = `${XAI_CLIENT_IDENTIFIER}/${XAI_PACKAGE_VERSION}`;
export const XAI_GROK_BUILD_REVIEWED_REVISION = "b189869b7755d2b482969acf6c92da3ecfeffd36";
export const XAI_PROVIDER_ID = "xai-auth";
export const XAI_BUNDLED_PROVIDER_ID = "xai";
export const XAI_TOOL_COMPATIBLE_PROVIDER_IDS = [
  XAI_PROVIDER_ID,
  XAI_BUNDLED_PROVIDER_ID,
] as const;

export type XaiToolCompatibleProviderId = (typeof XAI_TOOL_COMPATIBLE_PROVIDER_IDS)[number];

/** Return whether a provider can use this package's opt-in network tools. */
export function isXaiToolCompatibleProvider(
  provider: unknown,
): provider is XaiToolCompatibleProviderId {
  return XAI_TOOL_COMPATIBLE_PROVIDER_IDS.some((providerId) => provider === providerId);
}
export const DEFAULT_XAI_MODEL = "grok-4.6";
export const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image-2.0";

/** Private pi dispatch names mapped to the official Grok model-facing surface. */
export const XAI_GROK_NATIVE_TOOL_NAME_MAP = {
  xai_grok_read_file: "read_file",
  xai_grok_search_replace: "search_replace",
  xai_grok_list_dir: "list_dir",
  xai_grok_grep: "grep",
  xai_grok_run_terminal_command: "run_terminal_command",
  xai_grok_web_search: "web_search",
} as const;

/** Collision-free local Grok tools enabled automatically for xAI models. */
export const XAI_GROK_NATIVE_AUTO_TOOL_NAMES = [
  "xai_grok_read_file",
  "xai_grok_search_replace",
  "xai_grok_list_dir",
  "xai_grok_grep",
  "xai_grok_run_terminal_command",
] as const;

/** Public model-facing name for Grok-native xAI web search. */
export const XAI_GROK_NATIVE_WEB_SEARCH_NAME = "web_search";

/** Private pi dispatch name used to avoid collisions with other `web_search` extensions. */
export const XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME = "xai_grok_web_search";

/** All public Grok-native model-facing tool names, including opt-in web search. */
export const XAI_GROK_NATIVE_TOOL_NAMES = Object.values(XAI_GROK_NATIVE_TOOL_NAME_MAP);

export const XAI_GROK_CLI_AUTH_SCOPE_KEY = `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
export const XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";
