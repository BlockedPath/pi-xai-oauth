import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TEST_MODEL } from "./models";

export type AnyHandler = (event: any, context: any) => any;

export interface ExtensionHarness {
  api: ExtensionAPI;
  providers: Map<string, any>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Map<string, AnyHandler>;
  selectedModels: any[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  failRegistry(options?: { get?: boolean; set?: boolean }): void;
}

/** Create an isolated structural ExtensionAPI fixture. */
export function createExtensionHarness(
  initialTools: string[] = ["read", "bash", "edit", "write"],
): ExtensionHarness {
  const providers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, AnyHandler>();
  const selectedModels: any[] = [];
  let activeTools = [...initialTools];
  let failGet = false;
  let failSet = false;
  // Minimal EventBus (pi.events) for extension cross-talk tests.
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(channel: string, handler: (data: unknown) => void) {
      let set = eventListeners.get(channel);
      if (!set) {
        set = new Set();
        eventListeners.set(channel, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    emit(channel: string, data: unknown) {
      const set = eventListeners.get(channel);
      if (!set) return;
      for (const handler of [...set]) {
        handler(data);
      }
    },
  };
  const api = {
    on(event: string, handler: AnyHandler) {
      handlers.set(event, handler);
    },
    registerProvider(name: string, config: any) {
      providers.set(name, config);
    },
    unregisterProvider(name: string) {
      providers.delete(name);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getActiveTools() {
      if (failGet) throw new Error("tool registry unavailable");
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      if (failSet) throw new Error("tool registry unavailable");
      activeTools = [...names];
    },
    async setModel(model: any) {
      selectedModels.push(model);
      return true;
    },
    events,
  } as unknown as ExtensionAPI;
  return {
    api,
    providers,
    tools,
    commands,
    handlers,
    selectedModels,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
    failRegistry(options = {}) {
      failGet = options.get === true;
      failSet = options.set === true;
    },
  };
}

/**
 * Build a realistic pi tool execution context. Pi 0.82's bash factory reads
 * `sessionManager`, the active model, and the thinking level to expose `PI_*`
 * session metadata to spawned commands.
 */
export function toolExecutionContext(cwd: string, overrides: any = {}) {
  const sessionId = overrides.sessionId ?? "pi-xai-test-session";
  const sessionFile = overrides.sessionFile ?? `${cwd}/.pi-session.jsonl`;
  return {
    cwd,
    model: overrides.model ?? TEST_MODEL,
    thinkingLevel: overrides.thinkingLevel ?? "high",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    ...overrides,
  };
}

/** Build the command context used by `/xai-tools`. */
export function commandContext(
  model: any,
  notifications: Array<{ message: string; type?: string }> = [],
  overrides: any = {},
) {
  return {
    model,
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      custom: async () => undefined,
    },
    ...overrides,
  };
}
