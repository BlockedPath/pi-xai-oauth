import { expect } from "e2e";
import { test } from "./pi-rpc";

test("real Pi loads the extension's slash commands", async ({ pi }) => {
  const commands = await pi.client.getCommands();
  const extensionCommands = commands
    .filter((command) => command.source === "extension")
    .map((command) => command.name)
    .sort();
  expect(extensionCommands).toEqual(["xai-talk", "xai-tools", "xai-usage", "xai-voice"]);
});

// Guards every other test: a leaked real HOME or API key would make the
// credential-required paths below unreachable or, worse, hit the network.
test("the isolated session has no xAI credentials or models", async ({ pi }) => {
  const models = await pi.client.getAvailableModels();
  expect(models.filter((model) => model.provider.startsWith("xai"))).toEqual([]);
  const error = await pi.client.setModel("xai-auth", "grok-4.6").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeDefined();
});

const credentialGates = [
  { command: "/xai-usage", message: /xAI OAuth credentials are required/ },
  { command: "/xai-usage csv", message: /xAI OAuth credentials are required/ },
  { command: "/xai-tools", message: /Select an xAI\/Grok model before opening \/xai-tools/ },
  { command: "/xai-voice", message: /Grok voice needs xAI credentials/ },
  { command: "/xai-talk", message: /Grok voice chat needs xAI credentials/ },
];

for (const { command, message } of credentialGates) {
  test(`${command} fails safely without credentials`, async ({ pi }) => {
    await pi.client.prompt(command);
    await expect.poll(() => pi.notifications().length, { timeout: 15_000 }).toBe(1);
    const [notification] = pi.notifications();
    expect(notification.notifyType).toBe("error");
    expect(notification.message).toMatch(message);
  });
}
