import {
  XAI_API_BASE_URL,
  XAI_CLI_BASE_URL,
  XAI_CLI_RESPONSES_URL,
  XAI_IMAGES_EDITS_URL,
  XAI_IMAGES_GENERATIONS_URL,
  XAI_RESPONSES_URL,
  XAI_STT_STREAM_URL,
  XAI_STT_URL,
  XAI_TTS_URL,
  XAI_VIDEOS_GENERATIONS_URL,
  XAI_VIDEOS_STATUS_PREFIX,
} from "./constants";

export type XaiCredentialKind = "oauth-session" | "api-key";

export interface XaiCredential {
  kind: XaiCredentialKind;
  token: string;
  /** Host means the active model belongs to Pi's built-in catalog, not this package's catalog. */
  catalogScope?: "host";
}

export type XaiRequestKind =
  | "responses"
  | "image-generation"
  | "image-edit"
  | "video-generation-create"
  | "video-generation-status"
  | "text-to-speech"
  | "speech-to-text"
  | "speech-to-text-stream";

export interface XaiRoute {
  baseUrl: string;
  url: string;
}

const XAI_ROUTES: Record<XaiCredentialKind, Record<XaiRequestKind, XaiRoute>> = {
  "oauth-session": {
    responses: { baseUrl: XAI_CLI_BASE_URL, url: XAI_CLI_RESPONSES_URL },
    // Official Grok Build sends Imagine requests directly to api.x.ai for
    // both OAuth sessions and BYOK credentials rather than via the chat proxy.
    "image-generation": { baseUrl: XAI_API_BASE_URL, url: XAI_IMAGES_GENERATIONS_URL },
    "image-edit": { baseUrl: XAI_API_BASE_URL, url: XAI_IMAGES_EDITS_URL },
    "video-generation-create": { baseUrl: XAI_API_BASE_URL, url: XAI_VIDEOS_GENERATIONS_URL },
    "video-generation-status": { baseUrl: XAI_API_BASE_URL, url: XAI_VIDEOS_STATUS_PREFIX },
    // Grok Build's voice client sends both OAuth and BYOK bearers to api.x.ai;
    // the voice API attributes OAuth usage per user.
    "text-to-speech": { baseUrl: XAI_API_BASE_URL, url: XAI_TTS_URL },
    "speech-to-text": { baseUrl: XAI_API_BASE_URL, url: XAI_STT_URL },
    "speech-to-text-stream": { baseUrl: XAI_API_BASE_URL, url: XAI_STT_STREAM_URL },
  },
  "api-key": {
    responses: { baseUrl: XAI_API_BASE_URL, url: XAI_RESPONSES_URL },
    "image-generation": { baseUrl: XAI_API_BASE_URL, url: XAI_IMAGES_GENERATIONS_URL },
    "image-edit": { baseUrl: XAI_API_BASE_URL, url: XAI_IMAGES_EDITS_URL },
    "video-generation-create": { baseUrl: XAI_API_BASE_URL, url: XAI_VIDEOS_GENERATIONS_URL },
    "video-generation-status": { baseUrl: XAI_API_BASE_URL, url: XAI_VIDEOS_STATUS_PREFIX },
    "text-to-speech": { baseUrl: XAI_API_BASE_URL, url: XAI_TTS_URL },
    "speech-to-text": { baseUrl: XAI_API_BASE_URL, url: XAI_STT_URL },
    "speech-to-text-stream": { baseUrl: XAI_API_BASE_URL, url: XAI_STT_STREAM_URL },
  },
};

/** Resolve an xAI endpoint from credential provenance and request kind. */
export function resolveXaiRoute(credentialKind: XaiCredentialKind, requestKind: XaiRequestKind): XaiRoute {
  return { ...XAI_ROUTES[credentialKind][requestKind] };
}
