import { describe, expect, it, vi } from "vitest";
import {
  XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME,
  XAI_GROK_NATIVE_WEB_SEARCH_NAME,
} from "../../extensions/xai/constants";
import {
  registerXaiToolsCommand,
  XAI_TOOLS_MENU_CHANNEL,
} from "../../extensions/xai/tools/commands";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import {
  isXaiNetworkToolActive,
  syncXaiNetworkToolsForModel,
  XAI_NETWORK_TOOL_NAMES,
} from "../../extensions/xai/tools/model-scope";
import {
  KNOWN_XAI_MODEL_METADATA,
  XaiModelInputProvenance,
} from "../../extensions/xai/models";
import { createXaiVisionRoutingController } from "../../extensions/xai/vision-routing";
import {
  commandContext,
  createExtensionHarness,
} from "../fixtures/extension-api";
import { BUILTIN_XAI_TEST_MODEL, TEST_MODEL } from "../fixtures/models";

function setup() {
  const h = createExtensionHarness();
  registerXaiToolsCommand(h.api);
  const notices: any[] = [];
  const run = (args: string, model: any = TEST_MODEL, overrides: any = {}) =>
    h.commands
      .get("xai-tools")
      .handler(args, commandContext(model, notices, overrides));
  return { h, notices, run };
}

function emitMenuRequest(
  h: ReturnType<typeof createExtensionHarness>,
  request: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, { ...request, done: resolve });
  });
}

describe("/xai-tools command", () => {
  it("enables vision routing as transport policy without registering an active tool", async () => {
    const h = createExtensionHarness();
    const routing = createXaiVisionRoutingController();
    const source = {
      ...KNOWN_XAI_MODEL_METADATA[0],
      id: "text-source",
      input: ["text"] as ["text"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    };
    const target = {
      ...KNOWN_XAI_MODEL_METADATA[0],
      id: "vision-target",
      input: ["text", "image"] as ["text", "image"],
      inputProvenance: XaiModelInputProvenance.AuthenticatedInputModalities,
    };
    routing.replaceCatalog([source, target]);
    registerXaiToolsCommand(h.api, routing);
    const notices: any[] = [];
    const model = { ...TEST_MODEL, id: source.id, input: ["text"] };
    const run = (args: string) =>
      h.commands.get("xai-tools").handler(args, commandContext(model, notices));

    await run("enable vision-routing");
    expect(routing.status(model as any)).toMatchObject({
      state: "enabled",
      targetModelId: "vision-target",
    });
    expect(notices.at(-1).message).toMatch(/separate authenticated request.*usage or credits.*sensitive session content/s);
    expect(h.getActiveTools()).not.toContain("vision-routing");
    await run("status");
    expect(notices.at(-1).message).toMatch(/vision-routing=enabled \(text-source -> vision-target\)/);
    await run("disable vision-routing");
    expect(routing.status(model as any).state).toBe("eligible");
    expect(h.getActiveTools()).not.toContain("vision-routing");

    const builtInModel = { ...model, provider: "xai" };
    await h.commands
      .get("xai-tools")
      .handler("enable vision-routing", commandContext(builtInModel, notices));
    expect(routing.status(builtInModel as any).state).toBe("unavailable");
    expect(notices.at(-1).message).toMatch(/Select an xAI\/Grok model first/);
  });

  it("registers and enables/disables one eligible tool with cost warning", async () => {
    const { h, notices, run } = setup();
    expect(h.commands.has("xai-tools")).toBe(true);
    await run("enable xai_generate_image");
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    expect(notices.at(-1).message).toMatch(/may use xAI credits/);
    await run("disable xai_generate_image");
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
  });
  it("requires explicit user intent in the image-generation tool guidance", () => {
    const h = createExtensionHarness();
    registerCustomXaiTools(h.api);
    expect(h.tools.get("xai_generate_image").promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/explicitly asks to generate an image/),
      ]),
    );
  });
  it("requires explicit edit intent and local-reference guidance", () => {
    const h = createExtensionHarness();
    registerCustomXaiTools(h.api);
    expect(h.tools.get("xai_edit_image").promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/explicitly asks to edit or transform/),
        expect.stringMatching(/workspace paths or PNG\/JPEG data URLs/),
      ]),
    );
  });

  it("reports every tool status with one web_search entry", async () => {
    const { notices, run } = setup();
    await run("status");
    const message = notices.at(-1).message;
    for (const name of XAI_NETWORK_TOOL_NAMES) {
      const displayName = name === XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME
        ? XAI_GROK_NATIVE_WEB_SEARCH_NAME
        : name;
      expect(message).toMatch(new RegExp(`${displayName}=(?:enabled|disabled)`));
    }
    expect(message.match(/web_search=(?:enabled|disabled)/g)).toHaveLength(1);
    expect(message).not.toMatch(/xai_web_search=/);
  });
  it("rejects paid tools for non-xAI models and allows web_search for xAI models", async () => {
    const { h, notices, run } = setup();
    await run("enable xai_x_search", { provider: "anthropic", id: "claude" });
    expect(isXaiNetworkToolActive(h.api, "xai_x_search")).toBe(false);
    expect(notices.at(-1).message).toMatch(/Select an xAI\/Grok model/);
    await run("enable web_search");
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(true);
    await run("disable xai_web_search");
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(false);
    await run("enable xai_web_search");
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(true);
    expect(notices.at(-1).message).toMatch(/Enabled web_search/);
  });
  it("enables web_search for Pi's built-in xAI provider", async () => {
    const { h, notices, run } = setup();

    await run("enable web_search", BUILTIN_XAI_TEST_MODEL);

    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(true);
    expect(notices.at(-1).message).toMatch(/Enabled web_search.*may use xAI credits/s);
  });
  it("fails closed when registry reads or writes fail", async () => {
    const { h, notices, run } = setup();
    h.failRegistry({ get: true });
    await run("enable xai_web_search");
    h.failRegistry();
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(false);
    expect(notices.at(-1).message).toMatch(/could not be read/);
    h.failRegistry({ set: true });
    await run("enable xai_web_search");
    h.failRegistry();
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(false);
    expect(notices.at(-1).message).toMatch(/could not be updated/);
  });
  it("uses the RPC picker to toggle a selection", async () => {
    const { h, notices } = setup();
    let pass = 0;
    let title = "";
    let options: string[] = [];
    const ctx = commandContext(TEST_MODEL, notices, {
      mode: "rpc",
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        select: async (value: string, choices: string[]) => {
          title = value;
          options = choices;
          return ++pass === 1
            ? choices.find((choice) => choice.includes("web_search"))
            : "Done";
        },
      },
    });
    await h.commands.get("xai-tools").handler("", ctx);
    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(true);
    expect(title).toMatch(/explicit opt-in/);
    expect(options.filter((value) => value.includes("web_search"))).toHaveLength(1);
    expect(options.every((value) => !value.includes("xai_web_search"))).toBe(true);
    expect(
      options.some(
        (value) =>
          value.includes("xai_generate_image") && value.includes("per image"),
      ),
    ).toBe(true);
  });
  it("preserves another authorization when disabling through a non-xAI command context", async () => {
    const { h, run } = setup();
    await run("enable xai_web_search");
    await run("enable xai_generate_image");
    await run("disable xai_web_search", {
      provider: "anthropic",
      id: "claude",
    });

    expect(isXaiNetworkToolActive(h.api, XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME)).toBe(false);
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL);
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
  });

  it("recovers from a failed reset by stripping every stale tool except the selected one", async () => {
    const { h, run } = setup();
    h.setActiveTools([...h.getActiveTools(), ...XAI_NETWORK_TOOL_NAMES]);
    h.failRegistry({ set: true });
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL, { reset: true });
    h.failRegistry();
    expect(
      XAI_NETWORK_TOOL_NAMES.every((name) => h.getActiveTools().includes(name)),
    ).toBe(true);

    await run("enable xai_web_search");
    expect(
      XAI_NETWORK_TOOL_NAMES.filter((name) =>
        h.getActiveTools().includes(name),
      ),
    ).toEqual([XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME]);
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL);
    expect(
      XAI_NETWORK_TOOL_NAMES.filter((name) =>
        h.getActiveTools().includes(name),
      ),
    ).toEqual([XAI_GROK_NATIVE_WEB_SEARCH_DISPATCH_NAME]);
  });

  it("keeps TUI selection in place, wraps pages, toggles, and closes", async () => {
    const { h, notices } = setup();
    let closed = false;
    const selected: string[] = [];
    const ctx = commandContext(TEST_MODEL, notices, {
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        custom: async (factory: any) => {
          const bindings: any = {
            "tui.select.up": "up",
            "tui.select.down": "down",
            "tui.select.pageUp": "pageup",
            "tui.select.pageDown": "pagedown",
            "tui.select.confirm": "enter",
            "tui.select.cancel": "escape",
          };
          const component = await factory(
            { requestRender() {} },
            {
              fg: (_: any, text: string) => text,
              bg: (_: any, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: (data: string, id: string) => bindings[id] === data },
            () => {
              closed = true;
            },
          );
          component.handleInput("pageup");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("pagedown");
          for (let i = 0; i < 6; i++) component.handleInput("down");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("enter");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("escape");
        },
      },
    });
    await h.commands.get("xai-tools").handler("", ctx);
    // Page movement uses the ten-row viewport across the full tool catalog.
    expect(selected[0]).toMatch(/xai_deep_research/);
    expect(selected[1]).toMatch(/\[ \] xai_edit_image/);
    expect(selected[2]).toMatch(/\[x\] xai_edit_image/);
    expect(closed).toBe(true);
    expect(isXaiNetworkToolActive(h.api, "xai_edit_image")).toBe(true);
  });

  it("wraps Page Up and Page Down across the full xAI tool catalog", async () => {
    const { h, notices } = setup();
    let afterPageUp = "";
    let afterPageDown = "";
    const ctx = commandContext(TEST_MODEL, notices, {
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        custom: async (factory: any) => {
          const bindings: any = {
            "tui.select.up": "up",
            "tui.select.down": "down",
            "tui.select.pageUp": "pageup",
            "tui.select.pageDown": "pagedown",
            "tui.select.confirm": "enter",
            "tui.select.cancel": "escape",
          };
          const component = await factory(
            { requestRender() {} },
            {
              fg: (_: any, text: string) => text,
              bg: (_: any, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: (data: string, id: string) => bindings[id] === data },
            () => {},
          );
          component.handleInput("pageup");
          afterPageUp = component
            .render(160)
            .find((line: string) => line.startsWith("> "));
          component.handleInput("pagedown");
          afterPageDown = component
            .render(160)
            .find((line: string) => line.startsWith("> "));
          component.handleInput("escape");
        },
      },
    });

    await h.commands.get("xai-tools").handler("", ctx);
    expect(afterPageUp).toMatch(/xai_deep_research/);
    expect(afterPageDown).toMatch(/xai_generate_text/);
  });

  it("registers the clickable-menu event bridge and enables a tool via emit", async () => {
    const { h, notices } = setup();
    expect(typeof h.api.events.on).toBe("function");
    expect(typeof h.api.events.emit).toBe("function");

    const result = await emitMenuRequest(h, {
      action: "enable",
      tool: "xai_generate_image",
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({ ok: true });
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    expect(notices.at(-1).message).toMatch(/may use xAI credits/);
  });

  it("keeps the listener-owned bridge channel stable", () => {
    expect(XAI_TOOLS_MENU_CHANNEL).toBe("pi-clickable-menu:xai-tools");
  });

  it.each([
    ["action", { action: 42 }, /action must be a string/i],
    ["tool", { action: "enable", tool: { name: "xai_generate_image" } }, /tool must be a string/i],
  ])("rejects a non-string bridge %s before dispatch", (_field, request, errorPattern) => {
    const { h, notices } = setup();
    const done = vi.fn();

    expect(() => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        ...request,
        ctx: commandContext(TEST_MODEL, notices),
        done,
      });
    }).not.toThrow();

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ ok: false, error: expect.stringMatching(errorPattern) });
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
  });

  it("does not reflect an unknown bridge action in its error", () => {
    const { h } = setup();
    const done = vi.fn();

    h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
      action: "private-action-value",
      ctx: commandContext(TEST_MODEL),
      done,
    });

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({
      ok: false,
      error: "Unknown xAI tools bridge action.",
    });
    expect(done.mock.calls[0]?.[0]?.error).not.toContain("private-action-value");
  });

  it("does not reflect thrown bridge payload details in its error", () => {
    const { h } = setup();
    const done = vi.fn();
    const request: Record<string, unknown> = {
      ctx: commandContext(TEST_MODEL),
      done,
    };
    Object.defineProperty(request, "action", {
      get() {
        throw new Error("private-payload-detail");
      },
    });

    h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, request);

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({
      ok: false,
      error: "xAI tools bridge request failed.",
    });
    expect(done.mock.calls[0]?.[0]?.error).not.toContain("private-payload-detail");
  });

  it("rejects an unusable bridge UI context before changing tool state", () => {
    const { h } = setup();
    const done = vi.fn();

    h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
      action: "enable",
      tool: "xai_generate_image",
      ctx: { ...commandContext(TEST_MODEL), ui: {} },
      done,
    });

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringMatching(/command UI context/i),
    });
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
  });

  it("does not dispatch a bridge request without a callable done", () => {
    const { h } = setup();

    expect(() => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        action: "enable",
        tool: "xai_generate_image",
        ctx: commandContext(TEST_MODEL),
        done: "not-a-callback",
      });
    }).not.toThrow();

    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
  });

  it.each([
    ["an unknown tool", "not_a_tool", TEST_MODEL, /Usage:/],
    [
      "a non-xAI model",
      "xai_generate_image",
      { provider: "anthropic", id: "claude" },
      /Select an xAI\/Grok model/,
    ],
    ["unavailable vision routing", "vision-routing", TEST_MODEL, /vision routing is unavailable/i],
  ])("reports menu bridge failure for %s", async (_case, tool, model, errorPattern) => {
    const { h, notices } = setup();
    const result = await emitMenuRequest(h, {
      action: "enable",
      tool,
      ctx: commandContext(model, notices),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(errorPattern);
    expect(notices.at(-1).message).toMatch(errorPattern);
  });

  it("reports menu bridge registry failures when disabling a tool", async () => {
    const { h, notices, run } = setup();
    await run("enable xai_generate_image");

    for (const failure of [
      { registry: { get: true }, error: /could not be read/ },
      { registry: { set: true }, error: /could not be updated/ },
    ]) {
      h.failRegistry(failure.registry);
      const result = await emitMenuRequest(h, {
        action: "disable",
        tool: "xai_generate_image",
        ctx: commandContext(TEST_MODEL, notices),
      });
      h.failRegistry();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(failure.error);
      expect(notices.at(-1).message).toMatch(failure.error);
      expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    }
  });

  it("rejects a menu bridge enable or disable without a tool", async () => {
    const { h, notices } = setup();
    const result = await emitMenuRequest(h, {
      action: "disable",
      tool: " ",
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({
      ok: false,
      error: "xAI tools bridge enable/disable requires tool.",
    });
  });

  it("does not reflect post-launch picker failures or reply twice", async () => {
    const { h, notices } = setup();
    const done = vi.fn();

    h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
      action: "open",
      ctx: commandContext(TEST_MODEL, notices, {
        ui: {
          notify(message: string, type?: string) {
            notices.push({ message, type });
          },
          select: async () => undefined,
          custom: async () => {
            throw new Error("private-picker-detail");
          },
        },
      }),
      done,
    });

    await vi.waitFor(() => {
      expect(notices.at(-1)).toEqual({
        message: "xAI tools picker failed.",
        type: "error",
      });
    });
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ ok: true });
    expect(notices.some(({ message }) => message.includes("private-picker-detail"))).toBe(false);
  });


  it("reports status through the menu bridge notification path", async () => {
    const { h, notices } = setup();

    const result = await emitMenuRequest(h, {
      action: "status",
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({ ok: true });
    expect(notices).toEqual([
      {
        message: expect.stringMatching(/^xAI API tools for grok-4\.5:/),
        type: "info",
      },
    ]);
  });

  it("disables an enabled tool through the menu bridge", async () => {
    const { h, notices, run } = setup();
    await run("enable xai_generate_image");
    notices.length = 0;

    const result = await emitMenuRequest(h, {
      action: "disable",
      tool: "xai_generate_image",
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({ ok: true });
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
    expect(notices).toEqual([{ message: "Disabled xai_generate_image.", type: "info" }]);
  });

  it.each([
    ["an unknown tool", "not_a_tool", TEST_MODEL, /Usage:/],
    [
      "a non-xAI model",
      "xai_generate_image",
      { provider: "anthropic", id: "claude" },
      /Select an xAI\/Grok model/,
    ],
    ["unavailable vision routing", "vision-routing", TEST_MODEL, /vision routing is unavailable/i],
  ])("reports menu bridge failure for %s", async (_case, tool, model, errorPattern) => {
    const { h, notices } = setup();
    const result = await emitMenuRequest(h, {
      action: "enable",
      tool,
      ctx: commandContext(model, notices),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(errorPattern);
    expect(notices.at(-1).message).toMatch(errorPattern);
  });

  it("reports menu bridge registry failures when disabling a tool", async () => {
    const { h, notices, run } = setup();
    await run("enable xai_generate_image");

    for (const failure of [
      { registry: { get: true }, error: /could not be read/ },
      { registry: { set: true }, error: /could not be updated/ },
    ]) {
      h.failRegistry(failure.registry);
      const result = await emitMenuRequest(h, {
        action: "disable",
        tool: "xai_generate_image",
        ctx: commandContext(TEST_MODEL, notices),
      });
      h.failRegistry();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(failure.error);
      expect(notices.at(-1).message).toMatch(failure.error);
      expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    }
  });

  it.each([
    ["enable with an omitted tool", "enable", undefined],
    ["disable with an empty tool", "disable", ""],
    ["enable with a whitespace-only tool", "enable", " "],
  ])("rejects a menu bridge %s", async (_case, action, tool) => {
    const { h, notices } = setup();
    const result = await emitMenuRequest(h, {
      action,
      tool,
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({
      ok: false,
      error: "xAI tools bridge enable/disable requires tool.",
    });
    expect(notices).toEqual([]);
  });

  it.each([
    ["omitted action", undefined],
    ["explicit open", "open"],
  ])("acknowledges menu bridge %s before the interactive picker closes", async (_case, action) => {
    const { h, notices } = setup();
    let releasePicker!: () => void;
    const pickerHeldOpen = new Promise<void>((resolve) => {
      releasePicker = resolve;
    });
    let finishPicker!: () => void;
    const pickerFinished = new Promise<void>((resolve) => {
      finishPicker = resolve;
    });
    let pickerClosed = false;
    const replies: Array<{ ok: boolean; error?: string }> = [];

    const reply = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        ...(action === undefined ? {} : { action }),
        ctx: commandContext(TEST_MODEL, notices, {
          ui: {
            notify(message: string, type?: string) {
              notices.push({ message, type });
            },
            select: async () => undefined,
            custom: async () => {
              await pickerHeldOpen;
              pickerClosed = true;
              finishPicker();
            },
          },
        }),
        done(result: { ok: boolean; error?: string }) {
          replies.push(result);
          resolve(result);
        },
      });
    });

    // done must win before the held picker finishes (menu host timeout is ~4s).
    await expect(reply).resolves.toEqual({ ok: true });
    expect(pickerClosed).toBe(false);
    releasePicker();
    await pickerFinished;
    await Promise.resolve();
    expect(replies).toEqual([{ ok: true }]);
  });

  it("isolates a throwing done callback and still launches the accepted picker", async () => {
    const { h, notices } = setup();
    let doneCalls = 0;
    let markPickerLaunched!: () => void;
    const pickerLaunched = new Promise<void>((resolve) => {
      markPickerLaunched = resolve;
    });

    expect(() => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        action: "open",
        ctx: commandContext(TEST_MODEL, notices, {
          ui: {
            notify(message: string, type?: string) {
              notices.push({ message, type });
            },
            select: async () => undefined,
            custom: async () => {
              markPickerLaunched();
            },
          },
        }),
        done() {
          doneCalls++;
          throw new Error("menu host closed");
        },
      });
    }).not.toThrow();

    await pickerLaunched;
    expect(doneCalls).toBe(1);
    expect(notices).toEqual([]);
  });

  it("rejects an unknown menu bridge action", async () => {
    const { h, notices } = setup();
    const result = await emitMenuRequest(h, {
      action: "toggle",
      ctx: commandContext(TEST_MODEL, notices),
    });

    expect(result).toEqual({
      ok: false,
      error: "Unknown xAI tools bridge action.",
    });
    expect(notices).toEqual([]);
  });

  it("rejects menu bridge open when no xAI model is active", async () => {
    const { h, notices } = setup();
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        action: "open",
        ctx: commandContext(undefined, notices),
        done: resolve,
      });
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Select an xAI\/Grok model/i);
    expect(notices.at(-1).message).toMatch(/Select an xAI\/Grok model/i);
  });

  it("replies with an error when the bridge lacks a UI context", async () => {
    const { h } = setup();
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        action: "status",
        done: resolve,
      });
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command UI context/i);
  });

  it("replaces the prior menu bridge listener when registered twice", async () => {
    const { h, notices } = setup();
    registerXaiToolsCommand(h.api);
    const replies: Array<{ ok: boolean; error?: string }> = [];

    await new Promise<void>((resolve) => {
      h.api.events.emit(XAI_TOOLS_MENU_CHANNEL, {
        action: "status",
        ctx: commandContext(TEST_MODEL, notices),
        done(result: { ok: boolean; error?: string }) {
          replies.push(result);
        },
      });
      setImmediate(resolve);
    });

    expect(replies).toEqual([{ ok: true }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "info" });
  });

  it("skips bridge registration when pi.events.on is missing", () => {
    const h = createExtensionHarness();
    // Simulate older/partial API surface used by some fixtures.
    (h.api as any).events = {};
    expect(() => registerXaiToolsCommand(h.api)).not.toThrow();
    expect(h.commands.has("xai-tools")).toBe(true);
  });

});
