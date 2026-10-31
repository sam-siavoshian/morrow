import { describe, expect, test } from "bun:test";
import { INVITE_MAX_USES, TEST_COMMAND_MAX, type Role } from "@morrow/contracts";
import type { TeamView } from "@morrow/contracts";
import { canChangeRole, canManageTask, canManageTeam, inviteRow, inviteSummary, memberAction, parseMaxUses, parseTestCommand, teamNameProblem } from "./permissions";
import { memberRoleField, nameField, policyField, projectTestCommandField } from "./team-fields";

const who = (userId: string, role: Role) => ({ userId, role });

describe("memberAction mirrors the backend", () => {
  test("owner removes admins and members, never self", () => {
    expect(memberAction(who("o", "owner"), who("a", "admin"))).toBe("remove");
    expect(memberAction(who("o", "owner"), who("m", "member"))).toBe("remove");
    expect(memberAction(who("o", "owner"), who("o", "owner"))).toBeNull();
  });
  test("admin removes members only", () => {
    expect(memberAction(who("a", "admin"), who("m", "member"))).toBe("remove");
    expect(memberAction(who("a", "admin"), who("a2", "admin"))).toBeNull();
    expect(memberAction(who("a", "admin"), who("o", "owner"))).toBeNull();
  });
  test("members remove nobody", () => {
    expect(memberAction(who("m", "member"), who("m2", "member"))).toBeNull();
    expect(memberAction(who("m", "member"), who("a", "admin"))).toBeNull();
  });
  test("anyone but the owner can leave", () => {
    expect(memberAction(who("a", "admin"), who("a", "admin"))).toBe("leave");
    expect(memberAction(who("m", "member"), who("m", "member"))).toBe("leave");
  });
  test("canManageTeam", () => {
    expect(canManageTeam("owner")).toBe(true);
    expect(canManageTeam("admin")).toBe(true);
    expect(canManageTeam("member")).toBe(false);
  });
});

describe("invite link display", () => {
  test("parseMaxUses clamps to 1-50", () => {
    expect(parseMaxUses("10")).toBe(10);
    expect(parseMaxUses(" 3 ")).toBe(3);
    expect(parseMaxUses("0")).toBe(1);
    expect(parseMaxUses("999")).toBe(50);
  });
  test.each(["", "abc", "-1", "1.5", "1e3", "1000", "10 people"])("rejects %p", (raw) => {
    expect(parseMaxUses(raw)).toBeNull();
  });
  test("summary wording", () => {
    const now = new Date(2030, 0, 7, 9, 0).getTime();
    expect(inviteSummary(1, new Date(2030, 0, 7, 10, 0).getTime(), now, "en-US")).toBe("Works for 1 person until 10:00 AM.");
    expect(inviteSummary(10, new Date(2030, 0, 8, 9, 0).getTime(), now, "en-US")).toBe("Works for 10 people until Tue 9:00 AM.");
  });
});

describe("team settings rules", () => {
  test("only the owner changes roles, and never the owner's", () => {
    expect(canChangeRole("owner", "admin")).toBe(true);
    expect(canChangeRole("owner", "member")).toBe(true);
    expect(canChangeRole("owner", "owner")).toBe(false);
    expect(canChangeRole("admin", "member")).toBe(false);
    expect(canChangeRole("member", "member")).toBe(false);
  });
  test("team names follow the creation rule", () => {
    expect(teamNameProblem("  Core  ")).toBeNull();
    expect(teamNameProblem("x".repeat(64))).toBeNull();
    expect(teamNameProblem("   ")).toBe("Give the team a name.");
    expect(teamNameProblem("x".repeat(65))).toBe("Keep it to 64 characters.");
    expect(teamNameProblem(" ".repeat(10) + "x".repeat(64) + " ".repeat(10))).toBeNull();
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u007fb"]) expect(teamNameProblem(bad)).toBe("Use a single line of text.");
  });
  test("invite rows name the maker, never the link", () => {
    const now = new Date(2030, 0, 7, 9, 0).getTime();
    const invite = { id: "inv-1", createdBy: "u-2", expiresAt: new Date(2030, 0, 8, 9, 0).getTime(), uses: 0, maxUses: 1, createdAt: now };
    expect(inviteRow(invite, [{ userId: "u-2", login: "ada" }], now, "en-US")).toEqual({ title: "Made by @ada", detail: "0 of 1 used. Expires Tue 9:00 AM." });
    expect(inviteRow(invite, [], now, "en-US").title).toBe("Made by someone who left");
  });
  test("a new invite link lets one person in by default", () => {
    expect(INVITE_MAX_USES.default).toBe(1);
  });
});

describe("optimistic team fields", () => {
  const team = {
    id: "t-1",
    name: "Core",
    slug: "core",
    viewerRole: "owner",
    members: [
      { userId: "u-1", login: "o", name: null, avatarUrl: null, role: "owner" },
      { userId: "u-2", login: "m", name: null, avatarUrl: null, role: "member" },
    ],
    policy: { allowInspect: true, maxParallelPerTask: 3 },
  } as unknown as TeamView;

  test("each field reads and writes only itself", () => {
    expect(nameField.write(team, "New")).toMatchObject({ name: "New", policy: team.policy });
    const inspect = policyField("allowInspect");
    expect(inspect.read(team)).toBe(true);
    expect(inspect.write(team, false).policy).toEqual({ allowInspect: false, maxParallelPerTask: 3 });
    expect(team.policy.allowInspect).toBe(true);
  });
  test("a member's role; someone gone reads null and writes nothing", () => {
    const role = memberRoleField("u-2");
    expect(role.read(team)).toBe("member");
    const next = role.write(team, "admin");
    expect(next.members.map((m) => m.role)).toEqual(["owner", "admin"]);
    expect(memberRoleField("u-9").read(team)).toBeNull();
    expect(memberRoleField("u-9").write(team, null)).toBe(team);
  });
});

describe("test command", () => {
  test("mirrors the backend: trimmed, one line, at most 200 characters; empty clears it", () => {
    expect(parseTestCommand("  bun run test:ci && echo ok  ")).toEqual({ value: "bun run test:ci && echo ok" });
    expect(parseTestCommand("")).toEqual({ value: null });
    expect(parseTestCommand("   ")).toEqual({ value: null });
    expect(parseTestCommand("x".repeat(TEST_COMMAND_MAX))).toEqual({ value: "x".repeat(TEST_COMMAND_MAX) });
    expect(parseTestCommand("x".repeat(TEST_COMMAND_MAX + 1))).toHaveProperty("problem");
    for (const bad of ["bun test\nrm -rf ~", "bun\ttest", "bun\u0000test", "a\rb", "a\u007fb"]) expect(parseTestCommand(bad)).toHaveProperty("problem");
    // Invisible or direction-changing characters would let the shown command differ from the one that runs.
    for (const bad of ["bun test\u202e", "a\u2066b\u2069", "bun\u200btest", "bun\u2028test", "bun\u0085test", "bun\ufefftest", "a\u009bb"]) expect(parseTestCommand(bad)).toEqual({ problem: "Remove invisible or direction-changing characters." });
  });

  test("the optimistic field touches one project only; a gone project reads null and writes nothing", () => {
    const withProjects = {
      id: "t-1",
      name: "Core",
      projects: [
        { id: "p-1", repoFullName: "o/a", defaultBranch: "main", testCommand: "bun test" },
        { id: "p-2", repoFullName: "o/b", defaultBranch: "main", testCommand: null },
      ],
    } as unknown as TeamView;
    const field = projectTestCommandField("p-2");
    expect(field.read(withProjects)).toBeNull();
    expect(field.write(withProjects, "make test").projects.map((p) => p.testCommand)).toEqual(["bun test", "make test"]);
    expect(projectTestCommandField("p-1").write(withProjects, null).projects.map((p) => p.testCommand)).toEqual([null, null]);
    expect(projectTestCommandField("p-9").read(withProjects)).toBeNull();
    expect(projectTestCommandField("p-9").write(withProjects, "x").projects).toEqual(withProjects.projects);
  });
});

describe("canManageTask mirrors the backend's cancel and retry rule", () => {
  test("the creator, the owner and admins; never another member or an unknown viewer", () => {
    expect(canManageTask("member", "u-1", "u-1")).toBe(true);
    expect(canManageTask("owner", "u-2", "u-1")).toBe(true);
    expect(canManageTask("admin", "u-2", "u-1")).toBe(true);
    expect(canManageTask("member", "u-2", "u-1")).toBe(false);
    expect(canManageTask("member", null, "u-1")).toBe(false);
    expect(canManageTask("member", undefined, "")).toBe(false);
  });
});
