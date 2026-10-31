// Regression: the GitHub layer always passes `git` (undefined outside tests). That must keep the Freestyle default,
// not leave the service without a VM side and turn every worktree read into a 500.
import { describe, expect, test } from "bun:test";
import { WorktreeService } from "../../src/github/worktrees.ts";
import { createLogger } from "../../src/lib/logger.ts";

const TEAM = { id: "t-wt", projects: [{ id: "p-1", repoFullName: "acme/web" }] } as never;
const view = {
  tasks: { "tk-1": { projectId: "p-1", workstreams: [{ id: "ws-1", leaseId: null }] } },
  leases: {},
  profiles: {},
};

function service() {
  return new WorktreeService({
    workforce: { getView: async () => view as never },
    environment: async () => null,
    getUser: async () => null,
    token: async () => "unused",
    git: undefined,
    now: () => 0,
    log: createLogger({ level: "error", write: () => {} } as never),
  });
}

describe("WorktreeService default VM side", () => {
  test("an explicit `git: undefined` keeps the Freestyle port instead of crashing", async () => {
    const saved = { key: process.env.FREESTYLE_API_KEY };
    delete process.env.FREESTYLE_API_KEY;
    try {
      const err = await service()
        .changes(TEAM, "tk-1", "ws-1")
        .then(() => null, (e: unknown) => e);
      expect(err).not.toBeInstanceOf(TypeError);
      expect(err).toBeTruthy();
    } finally {
      if (saved.key !== undefined) process.env.FREESTYLE_API_KEY = saved.key;
    }
  });
});
