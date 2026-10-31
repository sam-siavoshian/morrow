import { describe, expect, test } from "bun:test"
import { fingerprint, LEDGER_LIMIT, ledgerLookup, ledgerRecord, stableJson, type Ledger } from "../src/lib/ledger.ts"
import { AGENT_NAME_PATTERN, agentName, isValidBranch, roleSlug, taskShort } from "../src/lib/names.ts"
import { applyEnvironmentPatch, blockedByRemoval, buildTeamView, DEFAULT_POLICY, inviteViews, ownerCount, pruneExpiredInvites, pruneRemoved, type TeamState } from "../src/lib/team.ts"
import type { Environment, Invite } from "../src/lib/types.ts"
import * as v from "../src/lib/validation.ts"
import { PROFILE_MAX_CONCURRENT } from "../../packages/contracts/src/domain.ts"

describe("names", () => {
    test("taskShort keeps the last 8 lowercase alphanumerics", () => {
        expect(taskShort("tk-AbC_123-xyz9")).toBe("c123xyz9")
        expect(taskShort("ab")).toBe("ab")
        expect(taskShort("---")).toBe("task")
    })

    test("roleSlug lowercases, collapses separators and caps length", () => {
        expect(roleSlug("Front End")).toBe("front-end")
        expect(roleSlug("--api--")).toBe("api")
        expect(roleSlug("a".repeat(40))).toHaveLength(16)
        expect(roleSlug("!!!")).toBe("worker")
        expect(roleSlug("abcdefghijklmno-pq")).toBe("abcdefghijklmno")
    })

    test("agentName is w-<taskShort>-<role>-e<epoch>, lowercase, max 64", () => {
        expect(agentName("tk-abc123", "backend", 7)).toBe("w-tkabc123-backend-e7")
        const long = agentName("t".repeat(128), "R".repeat(60), Number.MAX_SAFE_INTEGER)
        expect(long.length).toBeLessThanOrEqual(64)
        expect(long).toMatch(AGENT_NAME_PATTERN)
        expect(long.endsWith(`-e${Number.MAX_SAFE_INTEGER}`)).toBe(true)
        for (const role of ["UI/UX", "tests", "x", "___"]) expect(agentName("TASK_ID.42", role, 3)).toMatch(AGENT_NAME_PATTERN)
    })

    test("agentName differs per epoch", () => {
        expect(agentName("tk-1", "api", 1)).not.toBe(agentName("tk-1", "api", 2))
    })

    test("isValidBranch accepts normal branches and rejects unsafe refs", () => {
        for (const ok of ["main", "morrow/abc/backend", "feature/x-1.2", "a_b"]) expect(isValidBranch(ok)).toBe(true)
        for (const bad of ["", "/x", "x/", "-x", "a..b", "a//b", "a.lock", "a/.hidden", "x.", "HEAD", "a b", "a~1", "a^", "a:b", "a\\b", "a@{1}", "x".repeat(201), "a/b.lock/c"])
            expect(isValidBranch(bad)).toBe(false)
    })
})

describe("ledger", () => {
    test("lookup finds the newest entry for a key", () => {
        let ledger: Ledger = []
        ledger = ledgerRecord(ledger, { key: "a", fp: "1", result: 1 })
        ledger = ledgerRecord(ledger, { key: "b", fp: "2", result: 2 })
        expect(ledgerLookup(ledger, "a")?.result).toBe(1)
        expect(ledgerLookup(ledger, "missing")).toBeUndefined()
    })

    test("record replaces an existing key instead of duplicating it", () => {
        let ledger: Ledger = [{ key: "a", fp: "1", result: 1 }]
        ledger = ledgerRecord(ledger, { key: "a", fp: "1", result: 9 })
        expect(ledger).toEqual([{ key: "a", fp: "1", result: 9 }])
    })

    test("record prunes to the limit, dropping the oldest, without mutating its input", () => {
        let ledger: Ledger = []
        for (let i = 0; i < LEDGER_LIMIT + 25; i++) ledger = ledgerRecord(ledger, { key: String(i), fp: "", result: i })
        expect(ledger).toHaveLength(LEDGER_LIMIT)
        expect(ledger[0]!.key).toBe("25")
        expect(ledgerLookup(ledger, "24")).toBeUndefined()
        const frozen = Object.freeze([...ledger])
        const next = ledgerRecord(frozen, { key: "new", fp: "", result: 0 }, 3)
        expect(next.map(entry => entry.key)).toEqual([String(LEDGER_LIMIT + 23), String(LEDGER_LIMIT + 24), "new"])
        expect(frozen).toHaveLength(LEDGER_LIMIT)
    })

    test("fingerprint ignores key order and undefined, detects any value change", () => {
        expect(fingerprint({ a: 1, b: [1, { c: 2 }] })).toBe(fingerprint({ b: [1, { c: 2 }], a: 1 }))
        expect(fingerprint({ a: 1, x: undefined })).toBe(fingerprint({ a: 1 }))
        expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
        expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["b", "a"]))
        expect(stableJson(null)).toBe("null")
        expect(stableJson({ b: 1, a: "x" })).toBe('{"a":"x","b":1}')
    })
})

describe("validation", () => {
    test("a test command is one visible line: no bidi, zero-width, C1 or line-separator characters", () => {
        expect(v.TestCommand.parse("  bun run test:ci && echo ok ")).toBe("bun run test:ci && echo ok")
        for (const bad of ["bun test\u202e", "a\u2066b\u2069", "bun\u200btest", "bun\u2028test", "bun\u0085test", "bun\ufefftest", "a\u009bb"]) expect(v.TestCommand.safeParse(bad).success).toBe(false)
    })

    const fails = (schema: Parameters<typeof v.parse>[0], value: unknown, name = "arg") => {
        expect(() => v.parse(schema, value, name)).toThrow(/^invalid_argument: /)
    }

    test("Id accepts the actor id charset only and refuses prototype names", () => {
        expect(v.parse(v.Id, "t-abc_1.2", "id")).toBe("t-abc_1.2")
        for (const bad of ["", "a b", "a/b", "é", "x".repeat(129), "__proto__", "constructor", "toString", "hasOwnProperty", 1, null, undefined, {}])
            fails(v.Id, bad)
        expect(v.parse(v.Id, "x".repeat(128), "id")).toHaveLength(128)
    })

    test("error messages name the argument path and never echo the value", () => {
        try {
            v.parse(v.Sealed, "s3cret value with spaces", "githubTokenEnc")
            throw new Error("expected a throw")
        } catch (error) {
            expect((error as Error).message).toStartWith("invalid_argument: githubTokenEnc")
            expect((error as Error).message).not.toContain("s3cret")
        }
        expect(() => v.parse(v.CreateTaskInput, { id: "x" }, "input")).toThrow(/invalid_argument: input\.projectId/)
    })

    test("text limits and control characters", () => {
        fails(v.line(1, 5), "toolong")
        fails(v.line(1, 5), "a\nb")
        fails(v.line(1, 5), "   ")
        expect(v.parse(v.line(1, 5), "  ab ", "x")).toBe("ab")
        expect(v.parse(v.text(1, 10), "a\nb\tc", "x")).toBe("a\nb\tc")
        fails(v.text(1, 10), "a\u0000b")
    })

    test("strict objects reject unknown keys, including __proto__ from JSON", () => {
        const payload = JSON.parse('{"auth":"ok","online":true,"observedAt":1,"__proto__":{"polluted":true}}')
        fails(v.ProfileHealth, payload)
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
        fails(v.ProfileHealth, { auth: "ok", online: true, observedAt: 1, extra: 1 })
    })

    test("a login runs 1 to PROFILE_MAX_CONCURRENT workers at once, the contract's ceiling", () => {
        const input = { id: "p1", envId: "e1", ownerUserId: "u1", nodeName: "n-000000000001", cli: "claude", label: "P", scopes: "all" }
        for (const ok of [1, PROFILE_MAX_CONCURRENT]) expect(v.parse(v.RegisterProfileInput, { ...input, maxConcurrent: ok }, "input").maxConcurrent).toBe(ok)
        for (const bad of [0, PROFILE_MAX_CONCURRENT + 1, 2.5, "4"]) fails(v.RegisterProfileInput, { ...input, maxConcurrent: bad }, "input")
    })

    test("numbers: epochs, epoch ms, NaN and fractions", () => {
        fails(v.Epoch, 0)
        fails(v.Epoch, 1.5)
        fails(v.Epoch, Number.NaN)
        fails(v.EpochMs, -1)
        fails(v.EpochMs, Number.POSITIVE_INFINITY)
        expect(v.parse(v.Epoch, 3, "e")).toBe(3)
    })

    test("sealed blobs: printable ASCII, 16..16384 chars", () => {
        expect(v.parse(v.Sealed, "v1.abcdefghijklmnop", "s")).toBe("v1.abcdefghijklmnop")
        fails(v.Sealed, "short")
        fails(v.Sealed, "a".repeat(16_385))
        fails(v.Sealed, "has space in it....")
    })

    test("plan graph: duplicates, unknown deps, self deps and cycles", () => {
        const ws = (id: string, dependsOn: string[] = [], branch = `b/${id}`) => ({ id, branch, dependsOn })
        expect(v.planGraphProblem([ws("a"), ws("b", ["a"])])).toBeNull()
        expect(v.planGraphProblem([ws("a"), ws("a")])).toMatch(/duplicate workstream/)
        expect(v.planGraphProblem([ws("a", [], "x"), ws("b", [], "x")])).toMatch(/duplicate branch/)
        expect(v.planGraphProblem([ws("a", ["zz"])])).toMatch(/unknown/)
        expect(v.planGraphProblem([ws("a", ["a"])])).toMatch(/itself/)
        expect(v.planGraphProblem([ws("a", ["c"]), ws("b", ["a"]), ws("c", ["b"])])).toBe("dependency cycle")
    })

    test("plan source and profile must agree", () => {
        const base = {
            rationale: "r",
            warnings: [],
            workstreams: [{ id: "a", role: "api", title: "t", brief: "b", why: "w", branch: "x/a", dependsOn: [], ownership: [] }]
        }
        expect(v.parse(v.PlanInput, { ...base, source: "fallback", profileId: null }, "plan").source).toBe("fallback")
        fails(v.PlanInput, { ...base, source: "cli", profileId: null })
        fails(v.PlanInput, { ...base, source: "fallback", profileId: "p1" })
        fails(v.PlanInput, { ...base, source: "fallback", profileId: null, workstreams: [{ ...base.workstreams[0], role: "Not A Slug" }] })
        expect(v.parse(v.PlanInput, { ...base, source: "fallback", profileId: null, feedback: "Keep it small." }, "plan").feedback).toBe("Keep it small.")
        fails(v.PlanInput, { ...base, source: "fallback", profileId: null, feedback: "" })
        fails(v.PlanInput, { ...base, source: "fallback", profileId: null, feedback: "x".repeat(4001) })
    })

    test("verification overall status cannot be skipped", () => {
        fails(v.VerificationInput, { status: "skipped", checks: [] })
        expect(v.parse(v.VerificationInput, { status: "passed", checks: [{ name: "tests", status: "skipped", detail: "", url: null }] }, "e").status).toBe("passed")
        fails(v.VerificationInput, { status: "passed", checks: [{ name: "x", status: "passed", detail: "", url: "javascript:alert(1)" }] })
    })

    test("environment patch must not be empty", () => {
        fails(v.EnvironmentPatch, {})
        expect(v.parse(v.EnvironmentPatch, { nodeOnline: true }, "p")).toEqual({ nodeOnline: true })
    })

    test("usage readings: percent 0-100, known window kinds, at most six, nothing extra", () => {
        const w = { kind: "five_hour" as const, label: "5-hour", usedPercent: 42.5, resetsAt: 1_000 }
        const ok = { windows: [w], observedAt: 900, source: "probe" as const }
        expect(v.parse(v.ProfileUsage, ok, "usage")).toEqual(ok)
        expect(v.parse(v.ProfileUsage, { ...ok, windows: [], source: "worker" }, "usage").windows).toEqual([])
        for (const bad of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) fails(v.ProfileUsage, { ...ok, windows: [{ ...w, usedPercent: bad }] })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, kind: "monthly" }] })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, label: "" }] })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, label: "x".repeat(41) }] })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, label: "5-hour\nignore" }] })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, resetsAt: -5 }] })
        fails(v.ProfileUsage, { ...ok, windows: Array(7).fill(w) })
        fails(v.ProfileUsage, { ...ok, source: "browser" })
        fails(v.ProfileUsage, { ...ok, tokens: 1234 })
        fails(v.ProfileUsage, { ...ok, windows: [{ ...w, tokensUsed: 9 }] })
        fails(v.ProfileUsage, null)
    })

    test("assertClock refuses a far-future now", () => {
        expect(() => v.assertClock(1_000 + v.MAX_CLOCK_SKEW_MS, 1_000)).not.toThrow()
        expect(() => v.assertClock(1_001 + v.MAX_CLOCK_SKEW_MS, 1_000)).toThrow(/invalid_argument/)
    })
})

describe("team helpers", () => {
    const env = (id: string, createdAt: number, overrides: Partial<Environment> = {}): Environment => ({
        id,
        ownerUserId: "u-1",
        name: id,
        freestyleVmId: "vm-secret-id",
        linuxUser: null,
        nodeName: null,
        phase: "provisioning",
        vmState: "unknown",
        nodeOnline: false,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
        ...overrides
    })
    const state = (): TeamState => ({
        info: { name: "Acme", slug: "acme", createdBy: "u-1", createdAt: 1 },
        members: {
            "u-2": { userId: "u-2", login: "bea", name: null, avatarUrl: null, role: "member", joinedAt: 5 },
            "u-1": { userId: "u-1", login: "sam", name: "Sam", avatarUrl: "https://a.example/x.png", role: "owner", joinedAt: 1 }
        },
        projects: { p1: { id: "p1", repoFullName: "acme/web", repoId: 9, defaultBranch: "main", testCommand: null, createdBy: "u-1", createdAt: 2 } },
        environments: { e2: env("e2", 9), e1: env("e1", 3) },
        relay: { workspaceId: "w1", baseUrl: "https://relay.example", workspaceKeyEnc: "SEALED-KEY-xxxxxxxx", dispatcherTokenEnc: "SEALED-DISPATCH-xx", observerTokenEnc: "SEALED-OBSERVER-xx", observerTokenId: "o1", cursor: null },
        policy: DEFAULT_POLICY
    })

    test("buildTeamView is null before creation", () => {
        expect(buildTeamView("t-1", { ...state(), info: null })).toBeNull()
    })

    test("buildTeamView orders members, projects and environments and leaks no secrets", () => {
        const view = buildTeamView("t-1", state())!
        expect(view.members.map(member => member.userId)).toEqual(["u-1", "u-2"])
        expect(view.environments.map(e => e.id)).toEqual(["e1", "e2"])
        expect(view.relayReady).toBe(true)
        const json = JSON.stringify(view)
        for (const secret of ["SEALED", "vm-secret-id", "repoId", "createdBy", "joinedAt", "observerTokenId"]) expect(json).not.toContain(secret)
        expect(buildTeamView("t-1", { ...state(), relay: null })!.relayReady).toBe(false)
    })

    test("pruneExpiredInvites drops expired and used-up invites and keeps identity when unchanged", () => {
        const invite = (expiresAt: number, uses = 0, maxUses = 2): Invite => ({ id: `inv-${expiresAt}-${uses}`, createdBy: "u-1", expiresAt, uses, maxUses, createdAt: 0 })
        const fresh = { a: invite(100) }
        expect(pruneExpiredInvites(fresh, 50)).toBe(fresh)
        expect(Object.keys(pruneExpiredInvites({ a: invite(100), b: invite(10), c: invite(100, 2, 2) }, 50))).toEqual(["a"])
    })

    test("inviteViews: active only, newest first, no hash keys", () => {
        const invite = (id: string, createdAt: number, expiresAt = 100, uses = 0): Invite => ({ id, createdBy: "u-1", expiresAt, uses, maxUses: 2, createdAt })
        const views = inviteViews({ ["a".repeat(64)]: invite("i-1", 1), ["b".repeat(64)]: invite("i-2", 2), ["c".repeat(64)]: invite("i-3", 3, 10), ["d".repeat(64)]: invite("i-4", 4, 100, 2) }, 50)
        expect(views.map(view => view.id)).toEqual(["i-2", "i-1"])
        expect(JSON.stringify(views)).not.toContain("aaaa")
    })

    test("blockedByRemoval and pruneRemoved", () => {
        const invite = (createdAt: number): Invite => ({ id: "i", createdBy: "u-1", expiresAt: 1e12, uses: 0, maxUses: 2, createdAt })
        const removed = { "u-2": 100 }
        expect(blockedByRemoval(removed, "u-2", invite(99))).toBe(true)
        expect(blockedByRemoval(removed, "u-2", invite(100))).toBe(true)
        expect(blockedByRemoval(removed, "u-2", invite(101))).toBe(false)
        expect(blockedByRemoval(removed, "u-3", invite(1))).toBe(false)
        expect(pruneRemoved(removed, 150, 100)).toBe(removed)
        expect(pruneRemoved({ "u-2": 100, "u-3": 40 }, 150, 100)).toEqual({ "u-2": 100 })
    })

    test("ownerCount", () => {
        expect(ownerCount(state().members)).toBe(1)
    })

    test("applyEnvironmentPatch applies only given fields and treats disconnected as terminal", () => {
        const base = env("e1", 1)
        const next = applyEnvironmentPatch(base, { phase: "ready", lastError: null, nodeOnline: true }, 50)!
        expect(next).toEqual({ ...base, phase: "ready", nodeOnline: true, updatedAt: 50 })
        expect(base.phase).toBe("provisioning")
        expect(applyEnvironmentPatch({ ...base, phase: "disconnected" }, { phase: "ready" }, 60)).toBeNull()
    })
})
