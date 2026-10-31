import { expect } from "bun:test"
import { ActorInvocationError, actors, createActorTransport, type ActorRpcTransport } from "../generated/index.js"
import type { CreateTaskInput, PlanInput, PlanWorkstreamInput, RegisterProfileInput } from "../src/lib/types.ts"
import type { TestServer } from "../scripts/test-server.ts"

export { actors }

let counter = 0
/** Unique, id-safe suffix so tests sharing one server never collide. */
export function uid(prefix: string): string {
    counter += 1
    return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function transportFor(server: TestServer): ActorRpcTransport {
    return createActorTransport({ controlPlaneUrl: server.url, apiKey: server.secret })
}

export function socketOptions(server: TestServer) {
    return { controlPlaneUrl: server.url, apiKey: server.secret, projectId: "local" }
}

export async function expectActorError(promise: Promise<unknown>, message: RegExp): Promise<void> {
    let caught: unknown
    try {
        await promise
    } catch (error) {
        caught = error
    }
    expect(caught).toBeInstanceOf(ActorInvocationError)
    expect((caught as ActorInvocationError).code).toBe("actor_error")
    expect((caught as Error).message).toMatch(message)
}

export function profileInput(id: string, overrides: Partial<RegisterProfileInput> = {}): RegisterProfileInput {
    return {
        id,
        envId: `env-${id}`,
        ownerUserId: "u-1001",
        nodeName: `n-${id.toLowerCase().replace(/[^a-z0-9-]/g, "")}`.slice(0, 63),
        cli: "claude",
        label: `Profile ${id}`,
        scopes: "all",
        maxConcurrent: 1,
        ...overrides
    }
}

export function taskInput(id: string, overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
    return {
        id,
        projectId: "proj-1",
        title: "Build checkout",
        prompt: "Build Stripe checkout and webhook flow, with tests.",
        acceptance: ["webhook verified", "tests pass"],
        createdBy: "u-1001",
        maxAgents: 3,
        ...overrides
    }
}

export function workstream(id: string, role: string, overrides: Partial<PlanWorkstreamInput> = {}): PlanWorkstreamInput {
    return {
        id,
        role,
        title: `${role} work`,
        brief: `Do the ${role} part.`,
        why: `${role} is independent.`,
        branch: `morrow/${id}/${role}`,
        dependsOn: [],
        ownership: [`src/${role}/**`],
        ...overrides
    }
}

export function plan(workstreams: PlanWorkstreamInput[], overrides: Partial<PlanInput> = {}): PlanInput {
    return { source: "fallback", profileId: null, rationale: "Separable work.", warnings: [], workstreams, ...overrides }
}

export type Frame = { type: string; [key: string]: unknown }

/** Opens a socket and collects frames; resolves once open or closed. */
export async function openSocket(url: string): Promise<{ ws: WebSocket; frames: Frame[]; closed: Promise<{ code: number; reason: string }> }> {
    const ws = new WebSocket(url)
    const frames: Frame[] = []
    ws.onmessage = event => frames.push(JSON.parse(String(event.data)) as Frame)
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
        ws.onclose = event => resolve({ code: event.code, reason: event.reason })
    })
    await new Promise<void>(resolve => {
        ws.addEventListener("open", () => resolve(), { once: true })
        void closed.then(() => resolve())
    })
    return { ws, frames, closed }
}

export async function waitFor<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let value = await read()
    while (!done(value)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting; last value: ${JSON.stringify(value)?.slice(0, 500)}`)
        await Bun.sleep(100)
        value = await read()
    }
    return value
}
