import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';

export default {
  // Your ChatGPT subscription serves the model; sign in once with `e2e login openai`, `e2e models openai` lists the ids.
  agents: {
    default: {
      model: chatgpt('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  // Add an engine here when your tests need to drive an app.
  targets: [{ name: 'default', platform: 'custom' }],
} satisfies E2EConfig;
