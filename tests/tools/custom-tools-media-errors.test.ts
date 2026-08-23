import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import { setXaiNetworkToolActive } from "../../extensions/xai/tools/model-scope";
import { createExtensionHarness } from "../fixtures/extension-api";
import { tinyPngBytes } from "../fixtures/images";
import { authContext, TEST_MODEL } from "../fixtures/models";

const mediaErrors = vi.hoisted(() => ({
  editValidate: undefined as Error | undefined,
  editExecute: undefined as Error | undefined,
  videoValidate: undefined as Error | undefined,
  videoExecute: undefined as Error | undefined,
}));

vi.mock("../../extensions/xai/image-edit", async () => {
  const actual = await vi.importActual<typeof import("../../extensions/xai/image-edit")>(
    "../../extensions/xai/image-edit",
  );
  return {
    ...actual,
    validateXaiEditImageInput: (...args: Parameters<typeof actual.validateXaiEditImageInput>) => {
      if (mediaErrors.editValidate) throw mediaErrors.editValidate;
      return actual.validateXaiEditImageInput(...args);
    },
    executeXaiImageEdit: (...args: Parameters<typeof actual.executeXaiImageEdit>) => {
      if (mediaErrors.editExecute) return Promise.reject(mediaErrors.editExecute);
      return actual.executeXaiImageEdit(...args);
    },
  };
});

vi.mock("../../extensions/xai/image-to-video", async () => {
  const actual = await vi.importActual<typeof import("../../extensions/xai/image-to-video")>(
    "../../extensions/xai/image-to-video",
  );
  return {
    ...actual,
    validateXaiImageToVideoInput: (...args: Parameters<typeof actual.validateXaiImageToVideoInput>) => {
      if (mediaErrors.videoValidate) throw mediaErrors.videoValidate;
      return actual.validateXaiImageToVideoInput(...args);
    },
    executeXaiImageToVideo: (...args: Parameters<typeof actual.executeXaiImageToVideo>) => {
      if (mediaErrors.videoExecute) return Promise.reject(mediaErrors.videoExecute);
      return actual.executeXaiImageToVideo(...args);
    },
  };
});

describe("custom media tool error redaction", () => {
  const dataUrl = `data:image/png;base64,${tinyPngBytes().toString("base64")}`;
  let harness: ReturnType<typeof createExtensionHarness>;

  beforeEach(() => {
    mediaErrors.editValidate = undefined;
    mediaErrors.editExecute = undefined;
    mediaErrors.videoValidate = undefined;
    mediaErrors.videoExecute = undefined;
    harness = createExtensionHarness();
    registerCustomXaiTools(harness.api);
    setXaiNetworkToolActive(harness.api, TEST_MODEL, "xai_edit_image", true);
    setXaiNetworkToolActive(harness.api, TEST_MODEL, "xai_image_to_video", true);
  });

  afterEach(() => {
    mediaErrors.editValidate = undefined;
    mediaErrors.editExecute = undefined;
    mediaErrors.videoValidate = undefined;
    mediaErrors.videoExecute = undefined;
  });

  it("maps unexpected image-edit validator throws to a generic invalid-input error", async () => {
    mediaErrors.editValidate = new Error("SECRET_PATH /tmp/private.png");
    const result = await harness.tools.get("xai_edit_image").execute(
      "call",
      { prompt: "edit", image: [{ data_url: dataUrl }] },
      undefined,
      () => {},
      authContext(TEST_MODEL),
    );
    expect(result.content[0].text).toBe("Error: Image edit input is invalid.");
    expect(result.details).toMatchObject({ error: true, code: "invalid_input" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_PATH|private\.png/);
  });

  it("maps unexpected image-edit execution throws to a generic safe failure", async () => {
    mediaErrors.editExecute = new Error("SECRET_STACK /tmp/private.png oauth-token");
    const result = await harness.tools.get("xai_edit_image").execute(
      "call",
      { prompt: "edit", image: [{ data_url: dataUrl }] },
      undefined,
      () => {},
      authContext(TEST_MODEL),
    );
    expect(result.content[0].text).toBe("Error: xAI image edit failed safely.");
    expect(result.details).toMatchObject({ error: true, code: "output_failure" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_STACK|private\.png|oauth-token/);
  });

  it("maps unexpected image-to-video validator throws to a generic invalid-input error", async () => {
    mediaErrors.videoValidate = new Error("SECRET_PATH /tmp/private.png");
    const result = await harness.tools.get("xai_image_to_video").execute(
      "call",
      { image: { data_url: dataUrl } },
      undefined,
      () => {},
      authContext(TEST_MODEL),
    );
    expect(result.content[0].text).toBe("Error: Image-to-video input is invalid.");
    expect(result.details).toMatchObject({ error: true, code: "invalid_input" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_PATH|private\.png/);
  });

  it("maps unexpected image-to-video execution throws to a generic safe failure", async () => {
    mediaErrors.videoExecute = new Error("SECRET_STACK /tmp/private.png oauth-token");
    const result = await harness.tools.get("xai_image_to_video").execute(
      "call",
      { image: { data_url: dataUrl } },
      undefined,
      () => {},
      authContext(TEST_MODEL),
    );
    expect(result.content[0].text).toBe("Error: xAI image-to-video generation failed safely.");
    expect(result.details).toMatchObject({ error: true, code: "output_failure" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET_STACK|private\.png|oauth-token/);
  });

  it("rejects remote image-to-video paths before credentials, cwd, or network", async () => {
    let credentialReads = 0;
    const result = await harness.tools.get("xai_image_to_video").execute(
      "call",
      { image: { path: "https://example.test/SECRET-private.png" } },
      undefined,
      () => {},
      {
        model: TEST_MODEL,
        get modelRegistry() {
          credentialReads += 1;
          throw new Error("must not resolve");
        },
        get cwd() {
          throw new Error("must not inspect cwd");
        },
      },
    );
    expect(result.content[0].text).toMatch(/do not accept URL schemes/);
    expect(result.details).toMatchObject({ error: true, code: "invalid_input" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET-private/);
    expect(credentialReads).toBe(0);
  });
});
