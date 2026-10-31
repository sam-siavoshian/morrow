import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  cancelTask,
  createTeam,
  deleteTask,
  getTeam,
  listInvites,
  loginPath,
  logout,
  removeMember,
  renameTeam,
  revokeInvite,
  setMemberRole,
  signInUrl,
  toApiError,
  updatePolicy,
  updateProject,
} from "./api";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : body === null ? null : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("requests", () => {
  test("GET sends credentials and no CSRF header", async () => {
    respond(200, { invites: [] });
    expect(await listInvites("t-1")).toEqual({ invites: [] });
    const { url, init } = calls[0]!;
    expect(url).toBe("/api/teams/t-1/invites");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["x-morrow-csrf"]).toBeUndefined();
  });

  test("mutations carry the CSRF header and a JSON body", async () => {
    respond(201, { id: "t-1", name: "Core", slug: "core", viewerRole: "owner", members: [], projects: [], environments: [], policy: { allowInspect: true, maxParallelPerTask: 3 }, relayReady: false });
    await createTeam("Core");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-morrow-csrf"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "Core" }));
  });

  test("bodyless mutations still carry the CSRF header", async () => {
    respond(200, { releasedLeaseIds: [] });
    await cancelTask("t-1", "tk-1");
    expect(calls[0]!.url).toBe("/api/teams/t-1/tasks/tk-1/cancel");
    expect((calls[0]!.init.headers as Record<string, string>)["x-morrow-csrf"]).toBe("1");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  test("deleteTask: a bodyless DELETE on the task with the CSRF header; refusals keep the server's safe message", async () => {
    respond(200, { releasedLeaseIds: ["ls-1"] });
    expect(await deleteTask("t-1", "tk-1")).toEqual({ releasedLeaseIds: ["ls-1"] });
    expect(calls[0]!.url).toBe("/api/teams/t-1/tasks/tk-1");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>)["x-morrow-csrf"]).toBe("1");
    expect(calls[0]!.init.body).toBeUndefined();

    respond(403, { error: { code: "forbidden", message: "Only the task's creator or a team admin can delete it." } });
    const refused = await deleteTask("t-1", "tk-1").catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect([refused.code, refused.status, refused.message]).toEqual(["forbidden", 403, "Only the task's creator or a team admin can delete it."]);

    respond(200, { releasedLeaseIds: "nope" });
    expect((await deleteTask("t-1", "tk-1").catch((e) => e)).code).toBe("bad_response");
    calls = [];
    expect((await deleteTask("t-1", "../tk").catch((e) => e)).code).toBe("bad_request");
    expect(calls).toEqual([]);
  });

  test("204 resolves to undefined", async () => {
    respond(204, null);
    expect(await removeMember("t-1", "u-2")).toBeUndefined();
    respond(204, null);
    await logout({ everywhere: true });
    expect(calls[1]!.url).toBe("/api/auth/logout?everywhere=1");
  });

  test("team settings writes are PATCHes with the CSRF header and the exact body", async () => {
    const view = { id: "t-1", name: "Core", slug: "core", viewerRole: "owner", members: [], projects: [], environments: [], policy: { allowInspect: true, maxParallelPerTask: 3 }, relayReady: false };
    respond(200, view);
    await renameTeam("t-1", "New");
    await updatePolicy("t-1", { maxParallelPerTask: 2 });
    await setMemberRole("t-1", "u-2", "admin");
    await updateProject("t-1", "p-1", { testCommand: "bun test" });
    await updateProject("t-1", "p-1", { testCommand: null });
    expect(calls.map((c) => [c.init.method, c.url, c.init.body, (c.init.headers as Record<string, string>)["x-morrow-csrf"]])).toEqual([
      ["PATCH", "/api/teams/t-1", JSON.stringify({ name: "New" }), "1"],
      ["PATCH", "/api/teams/t-1/policy", JSON.stringify({ maxParallelPerTask: 2 }), "1"],
      ["PATCH", "/api/teams/t-1/members/u-2", JSON.stringify({ role: "admin" }), "1"],
      ["PATCH", "/api/teams/t-1/projects/p-1", JSON.stringify({ testCommand: "bun test" }), "1"],
      ["PATCH", "/api/teams/t-1/projects/p-1", JSON.stringify({ testCommand: null }), "1"],
    ]);
    expect(await updateProject("t-1", "../p", { testCommand: null }).catch((e) => e.code)).toBe("bad_request");
  });

  test("invites: list and revoke hit the team", async () => {
    respond(200, { invites: [] });
    expect(await listInvites("t-1")).toEqual({ invites: [] });
    respond(204, null);
    await revokeInvite("t-1", "inv-1");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "/api/teams/t-1/invites"],
      ["DELETE", "/api/teams/t-1/invites/inv-1"],
    ]);
    expect(await revokeInvite("t-1", "../x").catch((e) => e.code)).toBe("bad_request");
  });

  test("ids that are not plain ids never reach the network", async () => {
    respond(200, {});
    for (const bad of ["..", ".", "a/b", "a?b", ""]) {
      const error = await getTeam(bad).catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe("bad_request");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("errors", () => {
  test("maps the server's error body", async () => {
    respond(404, { error: { code: "not_found", message: "Team not found." } });
    const error = await getTeam("t-9").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect({ code: error.code, message: error.message, status: error.status }).toEqual({ code: "not_found", message: "Team not found.", status: 404 });
  });

  test("reads retry-after on a 429", async () => {
    respond(429, { error: { code: "rate_limited", message: "Slow down." } }, { "retry-after": "7" });
    const error = await listInvites("t-1").catch((e) => e);
    expect(error.retryAfter).toBe(7);
  });

  test("an unknown error body never leaks raw server text", async () => {
    respond(500, "<html>stack trace at /srv/app.ts:12</html>", { "content-type": "text/html" });
    const error = await listInvites("t-1").catch((e) => e);
    expect(error.code).toBe("internal");
    expect(error.message).toBe("The server could not finish that request (error 500). Try again in a moment.");
    respond(502, { error: { code: "made_up", message: "secret detail" } });
    const second = await listInvites("t-1").catch((e) => e);
    expect(second.message).not.toContain("secret");
  });

  test("status fallbacks", async () => {
    const error = await toApiError(new Response("nope", { status: 401 }));
    expect(error.code).toBe("unauthenticated");
    expect((await toApiError(new Response("", { status: 418 }))).code).toBe("internal");
  });

  test("a response that does not match the contract is bad_response", async () => {
    respond(200, { invites: [{ id: "inv-1" }] });
    const error = await listInvites("t-1").catch((e) => e);
    expect(error.code).toBe("bad_response");
  });

  test("network failure is network_error with status 0", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const error = await listInvites("t-1").catch((e) => e);
    expect({ code: error.code, status: error.status }).toEqual({ code: "network_error", status: 0 });
  });

  test("an aborted request rethrows the abort, not an ApiError", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const error = await listInvites("t-1", { signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe("AbortError");
  });
});

describe("return paths", () => {
  test("only same-site paths survive", () => {
    expect(signInUrl("/t/x")).toBe("/api/auth/github?returnTo=%2Ft%2Fx");
    expect(loginPath("/t/x?y=1")).toBe("/login?returnTo=%2Ft%2Fx%3Fy%3D1");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "/a\nb", "", null, undefined]) {
      expect(signInUrl(bad)).toBe("/api/auth/github");
      expect(loginPath(bad)).toBe("/login");
    }
  });
});
