import { describe, expect, test } from "bun:test";
import { projectShort, taskShort } from "@morrow/contracts";
import { taskShort as actorTaskShort, workstreamBranch as actorWorkstreamBranch } from "../../actors/src/lib/names.ts";
import { projectChannel, taskShort as orchestrationTaskShort, workstreamBranch } from "../src/orchestration/names.ts";

// The browser matches Relay traffic to tasks by these short names, so every layer must agree.
describe("short names", () => {
  const ids = ["tk-1", "t-AbC123xyz987", "task_with.dots-and-UPPER", "----", "p-0123456789ab"];

  test("actors, orchestration and contracts derive the same task short name", () => {
    for (const id of ids) {
      expect(actorTaskShort(id)).toBe(taskShort(id));
      expect(orchestrationTaskShort(id)).toBe(taskShort(id));
    }
  });

  test("actors and orchestration name a workstream's branch the same way", () => {
    for (const id of ids) for (const role of ["api", "helper2"]) expect(actorWorkstreamBranch(id, role)).toBe(workstreamBranch(id, role));
  });

  test("project channel uses the contracts short name", () => {
    expect(projectChannel("p-0123456789ab")).toBe(`proj-${projectShort("p-0123456789ab")}`);
  });
});
