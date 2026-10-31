import type { RepoSummary } from "@morrow/contracts";
import { describe, expect, test } from "bun:test";
import { linkedKeys, linkLabel, mergeRepoPages, moveFocus, pruneSelection, repoKey, toggleRepo } from "./repo-selection";

const repo = (id: number, fullName: string): RepoSummary => ({ id, fullName, private: false, defaultBranch: "main", description: null, pushedAt: null });

describe("repo selection", () => {
  const linked = linkedKeys(["Northwind/Web"]);

  test("toggle ticks and unticks", () => {
    const one = toggleRepo(new Set(), "northwind/api", linked);
    expect([...one]).toEqual(["northwind/api"]);
    expect(toggleRepo(one, "northwind/api", linked).size).toBe(0);
  });

  test("toggle never returns a new set for a linked repo, whatever its case", () => {
    const empty = new Set<string>();
    expect(toggleRepo(empty, "northwind/web", linked)).toBe(empty);
    expect(toggleRepo(empty, "NORTHWIND/WEB", linked)).toBe(empty);
  });

  test("toggle does not mutate the set it was given", () => {
    const start = new Set(["a/b"]);
    toggleRepo(start, "c/d", linked);
    expect([...start]).toEqual(["a/b"]);
  });

  test("prune drops what got linked meanwhile and keeps identity otherwise", () => {
    const selected = new Set(["northwind/web", "northwind/api"]);
    expect([...pruneSelection(selected, linked)]).toEqual(["northwind/api"]);
    const clean = new Set(["northwind/api"]);
    expect(pruneSelection(clean, linked)).toBe(clean);
  });

  test("repo keys ignore case", () => {
    expect(repoKey("Ada/Notes")).toBe("ada/notes");
    expect(linkedKeys(["A/B", "a/b"]).size).toBe(1);
  });

  test("pages merge without repeats", () => {
    const merged = mergeRepoPages([repo(1, "a/one"), repo(2, "a/two")], [repo(2, "a/two"), repo(3, "a/three")]);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(mergeRepoPages([], [repo(1, "a/one")]).map((r) => r.id)).toEqual([1]);
  });

  test("the primary label counts", () => {
    expect(linkLabel(0)).toBe("Link repos");
    expect(linkLabel(1)).toBe("Link 1 repo");
    expect(linkLabel(2)).toBe("Link 2 repos");
  });
});

describe("keyboard movement over rows", () => {
  test("arrows step one and stop at the ends", () => {
    expect(moveFocus("ArrowDown", 0, 3)).toBe(1);
    expect(moveFocus("ArrowDown", 2, 3)).toBe(2);
    expect(moveFocus("ArrowUp", 2, 3)).toBe(1);
  });
  test("up from the first row goes back to the search field", () => {
    expect(moveFocus("ArrowUp", 0, 3)).toBe(-1);
    expect(moveFocus("ArrowUp", -1, 3)).toBe(-1);
  });
  test("Home and End jump", () => {
    expect(moveFocus("Home", 2, 3)).toBe(0);
    expect(moveFocus("End", 0, 3)).toBe(2);
  });
  test("other keys and empty lists are not ours", () => {
    expect(moveFocus(" ", 0, 3)).toBeNull();
    expect(moveFocus("Enter", 0, 3)).toBeNull();
    expect(moveFocus("ArrowDown", 0, 0)).toBeNull();
  });
});
