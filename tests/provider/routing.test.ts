import { describe, expect, it } from "vitest";
import { resolveXaiRoute } from "../../extensions/xai/routing";

describe("credential-aware xAI routing", () => {
  it("routes OAuth Responses to the CLI proxy and API keys to the public API", () => {
    expect(resolveXaiRoute("oauth-session", "responses")).toEqual({
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      url: "https://cli-chat-proxy.grok.com/v1/responses",
    });
    expect(resolveXaiRoute("api-key", "responses")).toEqual({
      baseUrl: "https://api.x.ai/v1",
      url: "https://api.x.ai/v1/responses",
    });
  });
  it.each(["oauth-session", "api-key"] as const)(
    "keeps %s image generation on the public API",
    (kind) => {
      expect(resolveXaiRoute(kind, "image-generation")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/images/generations",
      });
    },
  );

  it.each(["oauth-session", "api-key"] as const)(
    "keeps %s video creation and status on pinned public routes",
    (kind) => {
      expect(resolveXaiRoute(kind, "video-generation-create")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/videos/generations",
      });
      expect(resolveXaiRoute(kind, "video-generation-status")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/videos/",
      });
    },
  );

  it.each(["oauth-session", "api-key"] as const)(
    "keeps %s image editing on the distinct pinned public route",
    (kind) => {
      expect(resolveXaiRoute(kind, "image-edit")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/images/edits",
      });
    },
  );

  it.each(["oauth-session", "api-key"] as const)(
    "keeps %s Grok voice requests on the pinned public voice routes",
    (kind) => {
      expect(resolveXaiRoute(kind, "text-to-speech")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/tts",
      });
      expect(resolveXaiRoute(kind, "speech-to-text")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "https://api.x.ai/v1/stt",
      });
      expect(resolveXaiRoute(kind, "speech-to-text-stream")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "wss://api.x.ai/v1/stt",
      });
      expect(resolveXaiRoute(kind, "realtime-voice")).toEqual({
        baseUrl: "https://api.x.ai/v1",
        url: "wss://api.x.ai/v1/realtime",
      });
    },
  );
});
