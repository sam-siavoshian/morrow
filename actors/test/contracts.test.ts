// The actors' view types are plain TS so the durable-actors compiler can emit them. These compile-time checks keep
// them identical to the zod-inferred contracts the UI uses (`bun run check` fails on any drift).
import { expect, test } from "bun:test"
import type * as C from "../../packages/contracts/src/domain.ts"
import type * as A from "../src/lib/types.ts"

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Assert<T extends true> = T

export type ViewTypesMatchContracts = [
    Assert<Equal<A.WorkforceView, C.WorkforceView>>,
    Assert<Equal<A.ProfileView, C.ProfileView>>,
    Assert<Equal<A.TaskView, C.TaskView>>,
    Assert<Equal<A.LeaseView, C.LeaseView>>,
    Assert<Equal<A.WorkstreamView, C.WorkstreamView>>,
    Assert<Equal<A.WorkstreamDetail, C.WorkstreamDetail>>,
    Assert<Equal<A.TaskDetail, C.TaskDetail>>,
    Assert<Equal<A.TraceEntry, C.TraceEntry>>,
    Assert<Equal<A.PlanView, C.PlanView>>,
    Assert<Equal<A.VerificationView, C.VerificationView>>,
    Assert<Equal<A.Checkpoint, C.Checkpoint>>,
    Assert<Equal<A.EnvironmentView, C.EnvironmentView>>,
    Assert<Equal<A.MemberView, C.MemberView>>,
    Assert<Equal<A.ProjectView, C.ProjectView>>,
    Assert<Equal<A.TeamPolicy, C.TeamPolicy>>,
    Assert<Equal<A.TeamProjection, Omit<C.TeamView, "viewerRole">>>,
    Assert<Equal<A.TaskStatus, C.TaskStatus>>,
    Assert<Equal<A.LeaseState, C.LeaseState>>,
    Assert<Equal<A.TraceKind, C.TraceKind>>,
    Assert<Equal<A.LimitSource, C.LimitSource>>,
    Assert<Equal<A.ProfileUsage, C.ProfileUsage>>,
    Assert<Equal<A.UsageWindow, C.UsageWindow>>,
    Assert<Equal<A.ProfileScopes, C.ProfileScopes>>,
    Assert<Equal<A.EnvironmentPhase, C.EnvironmentPhase>>,
    Assert<Equal<A.VmState, C.VmState>>,
    Assert<Equal<A.CliKind, C.CliKind>>,
    Assert<Equal<A.SubagentView, C.SubagentView>>,
    Assert<Equal<A.SubagentRole, C.SubagentRole>>,
    Assert<Equal<A.SubagentStatus, C.SubagentStatus>>,
    Assert<Equal<A.Role, C.Role>>
]

test("view types match the contracts (checked by tsc; see ViewTypesMatchContracts)", () => {
    expect(true).toBe(true)
})
