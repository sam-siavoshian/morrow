import { Freestyle } from "freestyle";
import { startFreestyleMock, type FreestyleMock } from "../fixtures/freestyle-mock/server.ts";
import type { AdvanceInput } from "../../src/integrations/freestyle/index.ts";

export const RELAY_KEY = "rk_live_TESTSECRETworkspacekey0123456789";
export const GITHUB_TOKEN = "gho_TESTSECRETgithubtoken0123456789abcd";

/** Start the mock and point the real lazy client factory at it through env. */
export function useMock(): { mock: FreestyleMock; client: Freestyle; restore: () => Promise<void> } {
  const mock = startFreestyleMock();
  const saved = { key: process.env.FREESTYLE_API_KEY, url: process.env.FREESTYLE_BASE_URL };
  process.env.FREESTYLE_API_KEY = mock.apiKey;
  process.env.FREESTYLE_BASE_URL = mock.url;
  const client = new Freestyle({ apiKey: mock.apiKey, baseUrl: mock.url });
  return {
    mock,
    client,
    restore: async () => {
      if (saved.key === undefined) delete process.env.FREESTYLE_API_KEY;
      else process.env.FREESTYLE_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.FREESTYLE_BASE_URL;
      else process.env.FREESTYLE_BASE_URL = saved.url;
      await mock.stop();
    },
  };
}

export function baseInput(overrides: Partial<AdvanceInput> = {}): AdvanceInput {
  return {
    relay: { workspaceKey: RELAY_KEY, baseUrl: null },
    profiles: [],
    repos: ["acme/web", "acme/api"],
    githubToken: GITHUB_TOKEN,
    snapshot: "freestyle/ubuntu",
    vmWait: { intervalMs: 5, timeoutMs: 2_000 },
    ...overrides,
  };
}
