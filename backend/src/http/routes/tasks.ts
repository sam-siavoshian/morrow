import {
  CreateTaskBody,
  Id,
  PickAttemptBody,
  ReplanBody,
  StartTaskBody,
  TaskMessageBody,
  type PlanAcceptedResponse,
} from "@morrow/contracts";
import { Hono, type Context } from "hono";
import { notFound } from "../../lib/errors.ts";
import type { TaskService } from "../../orchestration/service.ts";
import type { AppEnv } from "../context.ts";
import { readJson } from "../errors.ts";
import { rateLimit, requireTeam } from "../middleware.ts";
import type { TeamRouteModule } from "../app.ts";

type C = Context<AppEnv>;

function param(c: C, name: "taskId" | "profileId", label: string): string {
  const value = c.req.param(name);
  if (!value || !Id.safeParse(value).success) throw notFound(`${label} not found.`);
  return value;
}

/** Task routes under /api/teams. Planning and dispatch run in the background; watch `workforce.view`. */
export function taskRoutes(service: TaskService): TeamRouteModule {
  return (teams: Hono<AppEnv>) => {
    const r = new Hono<AppEnv>();

    r.post("/:teamId/tasks", requireTeam(), async (c) => {
      const body = await readJson(c, CreateTaskBody);
      const result: PlanAcceptedResponse = await service.create(c.get("team").id, c.get("userId"), body);
      c.get("log").info("task created", { taskId: result.taskId });
      return c.json(result, 202);
    });

    r.post("/:teamId/tasks/:taskId/plan", requireTeam(), async (c) => {
      const body = await readJson(c, ReplanBody);
      const result: PlanAcceptedResponse = await service.replan(c.get("team").id, param(c, "taskId", "Task"), body);
      return c.json(result, 202);
    });

    r.post("/:teamId/tasks/:taskId/start", requireTeam(), async (c) => {
      const body = await readJson(c, StartTaskBody);
      return c.json(await service.start(c.get("team").id, param(c, "taskId", "Task"), body));
    });

    r.post("/:teamId/tasks/:taskId/message", requireTeam(), async (c) => {
      const body = await readJson(c, TaskMessageBody);
      return c.json(await service.message(c.get("team").id, param(c, "taskId", "Task"), c.get("userId"), body), 201);
    });

    r.post("/:teamId/tasks/:taskId/cancel", requireTeam(), async (c) => {
      const taskId = param(c, "taskId", "Task");
      const result = await service.cancel(c.get("team").id, taskId, c.get("userId"), c.get("role"));
      c.get("log").info("task cancelled", { taskId });
      return c.json(result);
    });

    // Removes the task for everyone; the workforce view drops it. GitHub branches and pull requests stay.
    r.delete("/:teamId/tasks/:taskId", requireTeam(), async (c) => {
      const taskId = param(c, "taskId", "Task");
      const result = await service.delete(c.get("team").id, taskId, c.get("userId"), c.get("role"));
      c.get("log").info("task deleted", { taskId, released: result.releasedLeaseIds.length });
      return c.json(result);
    });

    r.post("/:teamId/tasks/:taskId/retry", requireTeam(), async (c) => {
      const taskId = param(c, "taskId", "Task");
      const result = await service.retry(c.get("team").id, taskId, c.get("userId"), c.get("role"));
      c.get("log").info("task retried", { taskId, mode: result.mode, leases: result.leases.length });
      return c.json(result);
    });

    // Compare tasks: ship one finished attempt, or finish without shipping (docs/multi-harness.md).
    r.post("/:teamId/tasks/:taskId/pick", requireTeam(), async (c) => {
      const taskId = param(c, "taskId", "Task");
      const body = await readJson(c, PickAttemptBody);
      const result = await service.pick(c.get("team").id, taskId, c.get("userId"), c.get("role"), body);
      c.get("log").info("attempt picked", { taskId, workstreamId: body.workstreamId, status: result.status, released: result.releasedLeaseIds.length });
      return c.json(result);
    });

    // Read-rate-limited like every team GET; members only (requireTeam answers 404 to anyone else).
    r.get("/:teamId/tasks/:taskId", requireTeam(), async (c) => c.json(await service.detail(c.get("team").id, param(c, "taskId", "Task"))));

    r.get("/:teamId/tasks/:taskId/artifacts", requireTeam(), rateLimit("github"), async (c) =>
      c.json(await service.artifacts(c.get("team").id, param(c, "taskId", "Task"), c.get("userId"))),
    );

    teams.route("/", r);
  };
}
