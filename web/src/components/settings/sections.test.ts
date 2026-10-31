import { describe, expect, test } from "bun:test";
import { setupSteps } from "@/components/composer/setup-guide";
import { sectionOf, SETTINGS_SECTIONS, settingsPath } from "./sections";

describe("settings sections", () => {
  test("every known section opens itself; anything else opens Team", () => {
    for (const id of SETTINGS_SECTIONS) expect(sectionOf(id)).toBe(id);
    for (const bad of [null, "", "Projects", "projects ", "__proto__", "toString", "constructor"]) expect(sectionOf(bad)).toBe("team");
  });

  test("paths encode the team id and land on the section", () => {
    expect(settingsPath("t-abc", "projects")).toBe("/t/t-abc/settings?section=projects");
    expect(settingsPath("t/../x?y", "projects")).toBe("/t/t%2F..%2Fx%3Fy/settings?section=projects");
    expect(sectionOf(new URL(settingsPath("t-abc", "projects"), "http://x").searchParams.get("section"))).toBe("projects");
  });

  test("the setup guide's Link a repository step opens the Projects section", () => {
    const state = { hasProject: false, hasEnvironment: false, hasSignedInProfile: false, canManageProjects: true };
    expect(setupSteps("t-abc", state)[0]!.href).toBe("/t/t-abc/settings?section=projects");
  });

  test("steps that name a vendor carry its logo", () => {
    const steps = setupSteps("t-abc", { hasProject: false, hasEnvironment: false, hasSignedInProfile: false, canManageProjects: true });
    expect(steps.map((s) => s.mark)).toEqual(["github", undefined, "clis"]);
  });
});
