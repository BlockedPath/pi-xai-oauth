import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { test as base } from "e2e";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionPath = join(repoRoot, "extensions", "xai-oauth.ts");

/** One `notify` record Pi forwards from the extension's `ctx.ui.notify` in RPC mode. */
export interface PiNotification {
  message: string;
  notifyType?: "info" | "warning" | "error";
}

/** A real `pi --mode rpc` process with only this extension loaded, in an isolated HOME. */
export interface PiRpcSession {
  client: RpcClient;
  /** Every extension `notify` record received so far, oldest first. */
  notifications(): PiNotification[];
}

// The CLI moved from dist/cli.js (0.80) to dist/bundle/cli.js (1.x); the
// package's own bin entry stays authoritative across the supported range.
async function resolvePiCli(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE)));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (manifest.name === PI_PACKAGE) return join(current, manifest.bin.pi);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not resolve the ${PI_PACKAGE} package root`);
    current = parent;
  }
}

function isNotification(record: unknown): record is PiNotification & { type: string; method: string } {
  const value = record as { type?: unknown; method?: unknown; message?: unknown } | null;
  return (
    value?.type === "extension_ui_request" && value.method === "notify" && typeof value.message === "string"
  );
}

/** `test` with a fresh credential-free Pi RPC session per test, torn down even on failure. */
export const test = base.extend<{ pi: PiRpcSession }>({
  pi: async (_fixtures, use) => {
    const home = await mkdtemp(join(tmpdir(), "pi-xai-e2e-"));
    const records: unknown[] = [];
    const client = new RpcClient({
      cliPath: await resolvePiCli(),
      cwd: home,
      // RpcClient spreads process.env first; these overrides keep the developer's
      // real Pi settings, ~/.grok/auth.json, and API key out of the session.
      env: {
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        XAI_API_KEY: "",
      },
      args: ["--no-session", "--no-extensions", "-e", extensionPath],
    });
    client.onEvent((record: unknown) => records.push(record));
    try {
      await client.start();
      await use({
        client,
        notifications: () =>
          records.filter(isNotification).map(({ message, notifyType }) => ({ message, notifyType })),
      });
    } finally {
      await client.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
});
