import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createXaiOAuth,
  detectXaiLoginContext,
  XAI_BROWSER_LOGIN_METHOD,
  XAI_DEVICE_LOGIN_METHOD,
} from "../../extensions/xai/oauth";
import {
  XAI_OAUTH_DEVICE_URL,
  XAI_OAUTH_TOKEN_URL,
} from "../../extensions/xai/constants";
import {
  devicePayload,
  jsonResponse,
  makeClock,
  tokenPayload,
} from "../fixtures/device";

async function selector(environment: any) {
  let prompt: any;
  const oauth = createXaiOAuth({
    getExistingCredentials: () => null,
    loginEnvironment: environment,
  });
  await expect(
    oauth.login({
      onPrompt: async () => "n",
      onAuth: () => {
        throw new Error("browser opened");
      },
      onDeviceCode: () => {},
      onSelect: async (value: any) => {
        prompt = value;
        return undefined;
      },
    } as any),
  ).rejects.toThrow("Login cancelled");
  return prompt;
}

describe("OAuth login method and device integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      { env: {}, stdinIsTTY: true, stdoutIsTTY: true },
      "desktop",
      /remote\/headless/,
    ],
    [
      {
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
      "wsl",
      /recommended for this WSL session/,
    ],
    [
      { env: { SSH_CONNECTION: "test" }, stdinIsTTY: true, stdoutIsTTY: true },
      "ssh",
      /recommended for this SSH session/,
    ],
    [
      { env: { container: "docker" }, stdinIsTTY: true, stdoutIsTTY: true },
      "container",
      /recommended for this container/,
    ],
    [
      { env: {}, stdinIsTTY: false, stdoutIsTTY: false },
      "headless",
      /recommended for this headless session/,
    ],
  ])(
    "keeps browser first in %s context",
    async (environment, expected, label) => {
      expect(detectXaiLoginContext(environment as any)).toBe(expected);
      const prompt = await selector(environment);
      expect(prompt.message).toBe("Select xAI login method:");
      expect(prompt.options.map(({ id }: any) => id)).toEqual([
        XAI_BROWSER_LOGIN_METHOD,
        XAI_DEVICE_LOGIN_METHOD,
      ]);
      expect(prompt.options[0].label).toBe("Browser login (default)");
      expect(prompt.options[1].label).toMatch(label);
    },
  );

  it("rejects unsupported selector results", async () => {
    const oauth = createXaiOAuth({ getExistingCredentials: () => null });
    await expect(
      oauth.login({
        onPrompt: async () => "n",
        onAuth: () => {},
        onDeviceCode: () => {},
        onSelect: async () => "unexpected",
      } as any),
    ).rejects.toThrow(/Unsupported xAI login method/);
  });

  it("runs the device flow without browser or manual callbacks and uses the common handoff", async () => {
    const clock = makeClock();
    const requests: any[] = [];
    const deviceUi: any[] = [];
    const progress: string[] = [];
    const completed: any[] = [];
    const oauth = createXaiOAuth({
      getExistingCredentials: () => null,
      loginEnvironment: {
        env: { SSH_CONNECTION: "test" },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
      deviceAuth: {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init });
          return String(url) === XAI_OAUTH_DEVICE_URL
            ? jsonResponse(devicePayload({ interval: 2 }))
            : jsonResponse(tokenPayload());
        },
      },
      onLoginCredentials: async (credential) => {
        completed.push(credential);
      },
    });
    const credentials = await oauth.login({
      onPrompt: async () => {
        throw new Error("prompt");
      },
      onAuth: () => {
        throw new Error("browser");
      },
      onManualCodeInput: async () => {
        throw new Error("manual");
      },
      onSelect: async () => XAI_DEVICE_LOGIN_METHOD,
      onDeviceCode: (info: any) => deviceUi.push(info),
      onProgress: (message: string) => progress.push(message),
    } as any);
    expect(requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([2000]);
    expect(deviceUi).toEqual([
      {
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.x.ai/device",
        intervalSeconds: 2,
        expiresInSeconds: 600,
      },
    ]);
    expect(credentials).toMatchObject({
      access: "device-access-token",
      refresh: "device-refresh-token",
      tokenEndpoint: XAI_OAUTH_TOKEN_URL,
    });
    expect(credentials).not.toHaveProperty("idToken");
    expect(completed).toHaveLength(1);
    expect(JSON.stringify(progress)).not.toMatch(
      /opaque-device-code|device-access-token|device-refresh-token|unvalidated-device-id-token/,
    );
  });

  it("returns no credentials when cancellation lands during the post-login handoff", async () => {
    const controller = new AbortController();
    const clock = makeClock();
    const oauth = createXaiOAuth({
      getExistingCredentials: () => null,
      deviceAuth: {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async (url) =>
          String(url) === XAI_OAUTH_DEVICE_URL
            ? jsonResponse(devicePayload({ interval: 1 }))
            : jsonResponse(tokenPayload()),
      },
      onLoginCredentials: async () => controller.abort(),
    });
    await expect(
      oauth.login({
        onPrompt: async () => "n",
        onAuth: () => {},
        onDeviceCode: () => {},
        onSelect: async () => XAI_DEVICE_LOGIN_METHOD,
        signal: controller.signal,
      } as any),
    ).rejects.toThrow("Login cancelled");
  });

  it("keeps a valid login without reflecting the catalog handoff error", async () => {
    const clock = makeClock();
    const progress: string[] = [];
    const oauth = createXaiOAuth({
      getExistingCredentials: () => null,
      deviceAuth: {
        now: clock.now,
        sleep: clock.sleep,
        fetchImpl: async (url) =>
          String(url) === XAI_OAUTH_DEVICE_URL
            ? jsonResponse(devicePayload({ interval: 1 }))
            : jsonResponse(tokenPayload()),
      },
      onLoginCredentials: async () => {
        throw new Error("catalog failure included secret-access-token");
      },
    });
    const credentials = await oauth.login({
      onPrompt: async () => "n",
      onAuth: () => {},
      onDeviceCode: () => {},
      onSelect: async () => XAI_DEVICE_LOGIN_METHOD,
      onProgress: (message: string) => progress.push(message),
    } as any);
    expect(credentials).toMatchObject({ access: "device-access-token" });
    expect(progress.at(-1)).toMatch(/curated fallback/);
    expect(progress.at(-1)).not.toContain("catalog failure");
    expect(progress.at(-1)).not.toContain("secret-access-token");
  });
});
