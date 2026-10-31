import { describe, expect, test } from "bun:test";
import type { ProfileView, VmState } from "@morrow/contracts";
import { authBadge, cliAvailability, formatResetTime, liveLeaseCount, phaseInfo, profileAvailability, signedOutCount, signInBlocker, vmPower, type AvailabilityProfile } from "./status";

const profile = (patch: Partial<AvailabilityProfile> = {}): AvailabilityProfile => ({
  auth: "ok",
  availability: "ready",
  cooldownUntil: null,
  activeLeases: 0,
  maxConcurrent: 2,
  ...patch,
});
const up = { now: 1_000, vmRunning: true, nodeOnline: true };

describe("VM power is separate from CLI status", () => {
  test.each([
    ["running", "Running", "success"],
    ["starting", "Starting", "attention"],
    ["pausing", "Pausing", "attention"],
    ["paused", "Paused", "idle"],
    ["stopped", "Stopped", "neutral"],
  ] as [VmState, string, string][])("%s", (vm, label, tone) => {
    expect(vmPower(vm, "ready")).toMatchObject({ label, tone });
  });
  test("unknown VM while provisioning reads as starting", () => {
    expect(vmPower("unknown", "provisioning")).toMatchObject({ label: "Starting", pulse: true });
    expect(vmPower("unknown", "ready")).toMatchObject({ label: "Unknown" });
  });
  test("disconnected phase wins over VM state", () => {
    expect(vmPower("running", "disconnected").label).toBe("Disconnected");
  });
  test("a running VM can still hold a signed-out CLI", () => {
    expect(vmPower("running", "awaiting_login").label).toBe("Running");
    expect(cliAvailability(profile({ auth: "auth_required" }), up).kind).toBe("auth");
  });
});

describe("cliAvailability precedence", () => {
  test("auth needed beats offline", () => {
    expect(cliAvailability(profile({ auth: "auth_required" }), { ...up, vmRunning: false }).label).toBe("Auth needed");
  });
  test("offline when VM down, node offline, or profile offline", () => {
    expect(cliAvailability(profile(), { ...up, vmRunning: false }).kind).toBe("offline");
    expect(cliAvailability(profile(), { ...up, nodeOnline: false }).kind).toBe("offline");
    expect(cliAvailability(profile({ availability: "offline" }), up).kind).toBe("offline");
  });
  test("offline beats limited and busy", () => {
    expect(cliAvailability(profile({ availability: "limited", cooldownUntil: 5_000 }), { ...up, nodeOnline: false }).kind).toBe("offline");
  });
  test("limited with a future reset time", () => {
    expect(cliAvailability(profile({ availability: "limited", cooldownUntil: 5_000 }), up)).toEqual({
      kind: "limited",
      label: "Limited",
      tone: "lemon",
      until: 5_000,
    });
  });
  test("limited reset time in the past is dropped", () => {
    expect(cliAvailability(profile({ availability: "limited", cooldownUntil: 500 }), up).until).toBeNull();
  });
  test("busy, unchecked, ready", () => {
    expect(cliAvailability(profile({ availability: "busy", activeLeases: 2 }), up).kind).toBe("busy");
    expect(cliAvailability(profile({ activeLeases: 2 }), up).kind).toBe("busy");
    expect(cliAvailability(profile({ auth: "unknown" }), up).kind).toBe("unchecked");
    expect(cliAvailability(profile(), up)).toMatchObject({ kind: "ready", label: "Ready", until: null });
  });
  test("busy means every slot is taken, whatever the stored label says", () => {
    expect(cliAvailability(profile({ availability: "busy", activeLeases: 1 }), up).kind).toBe("ready");
    expect(cliAvailability(profile({ activeLeases: 3 }), up).kind).toBe("busy");
  });
  test("cliAvailability is profileAvailability with the VM and node as `online`", () => {
    for (const [vmRunning, nodeOnline] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(cliAvailability(profile(), { now: 1_000, vmRunning, nodeOnline })).toEqual(profileAvailability(profile(), { now: 1_000, online: vmRunning && nodeOnline }));
    }
  });
  test("labels never mention tokens or balances", () => {
    const all = [
      profile(),
      profile({ activeLeases: 2 }),
      profile({ availability: "limited" }),
      profile({ availability: "offline" }),
      profile({ auth: "auth_required" }),
      profile({ auth: "unknown" }),
    ].map((p) => cliAvailability(p, up).label.toLowerCase());
    for (const label of all) expect(label).not.toMatch(/token|balance|credit|%/);
  });
});

test("phaseInfo covers every phase", () => {
  for (const phase of ["provisioning", "bootstrapping", "awaiting_login", "ready", "paused", "error", "disconnected"] as const) {
    expect(phaseInfo(phase).label.length).toBeGreaterThan(0);
  }
  expect(phaseInfo("provisioning").working).toBe(true);
  expect(phaseInfo("ready").working).toBe(false);
});

test("authBadge", () => {
  expect(authBadge("ok").label).toBe("Signed in");
  expect(authBadge("auth_required").label).toBe("Signed out");
  expect(authBadge("unknown").label).toBe("Not checked");
});

test("liveLeaseCount counts only live leases on these profiles", () => {
  const leases = {
    a: { profileId: "p1", state: "running" },
    b: { profileId: "p1", state: "spawning" },
    c: { profileId: "p1", state: "released" },
    d: { profileId: "p2", state: "running" },
    e: { profileId: "p1", state: "reserved" },
  };
  expect(liveLeaseCount({ leases } as never, new Set(["p1"]))).toBe(3);
  expect(liveLeaseCount(null, new Set(["p1"]))).toBe(0);
});

test("formatResetTime: today, this week, later", () => {
  const now = new Date(2030, 0, 7, 9, 0).getTime();
  expect(formatResetTime(new Date(2030, 0, 7, 16, 10).getTime(), now, "en-US")).toBe("4:10 PM");
  expect(formatResetTime(new Date(2030, 0, 8, 16, 10).getTime(), now, "en-US")).toBe("Tue 4:10 PM");
  expect(formatResetTime(new Date(2030, 0, 20, 16, 10).getTime(), now, "en-US")).toBe("Jan 20 4:10 PM");
});

describe("signed-out attention", () => {
  const p = (id: string, ownerUserId: string, auth: ProfileView["auth"]) => ({ id, ownerUserId, auth }) as ProfileView;
  const view = (...list: ProfileView[]) => ({ profiles: Object.fromEntries(list.map((x) => [x.id, x])) });

  test("counts only the viewer's own signed-out CLIs", () => {
    const wf = view(p("a", "u-me", "auth_required"), p("b", "u-me", "ok"), p("c", "u-other", "auth_required"), p("d", "u-me", "unknown"), p("e", "u-me", "auth_required"));
    expect(signedOutCount(wf, "u-me")).toBe(2);
    expect(signedOutCount(wf, "u-other")).toBe(1);
    expect(signedOutCount(wf, "u-nobody")).toBe(0);
  });
  test("zero before the view or the viewer is known", () => {
    expect(signedOutCount(null, "u-me")).toBe(0);
    expect(signedOutCount(view(p("a", "u-me", "auth_required")), null)).toBe(0);
  });
});

describe("sign in again", () => {
  test("open only where the terminal route allows it", () => {
    expect(signInBlocker("ready")).toBeNull();
    expect(signInBlocker("awaiting_login")).toBeNull();
    expect(signInBlocker("paused")).toBe("Resume this VM to sign in.");
    for (const phase of ["provisioning", "bootstrapping", "error", "disconnected"] as const) expect(signInBlocker(phase)).toBe("Available once the VM is set up and running.");
  });
});
