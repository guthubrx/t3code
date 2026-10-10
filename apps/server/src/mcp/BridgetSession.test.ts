import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as Service from "./OrchestratorMcpService.ts";

describe("Bridget session attestation", () => {
  const scope = (threadId: string, sessionId: string): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:bridget"),
    thread: { threadId: ThreadId.make(threadId), providerSessionId: sessionId, providerInstanceId: ProviderInstanceId.make("codex") },
    client: undefined,
    requestNamespace: sessionId,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const layer = (active: boolean, archived = false, deleted = false) => Service.layer.pipe(Layer.provide(Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (threadId) => {
        const projection = idleThreadProjection(liveThreadShell(threadId));
        return Effect.succeed({
          ...projection,
          thread: { ...projection.thread, archivedAt: archived ? projection.updatedAt : null, deletedAt: deleted ? projection.updatedAt : null },
          runs: active ? [{ ordinal: 1, status: "running", providerInstanceId: ProviderInstanceId.make("codex") }] : [],
        } as unknown as OrchestrationV2ThreadProjection);
      },
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  )));

  it.effect("keeps two sessions distinct even when their provider instance is shared", () => Effect.gen(function* () {
    const service = yield* Service.OrchestratorMcpService;
    for (const [thread, session] of [["thread:a", "session:a"], ["thread:b", "session:b"]]) {
      const result = yield* service.sessionIdentity(scope(thread!, session!));
      assert.deepEqual(result, { version: 1, environmentId: "environment:bridget", threadId: thread, providerSessionId: session, providerInstanceId: "codex" });
    }
  }).pipe(Effect.provide(layer(true))));

  it.effect("refuses an external client, missing capability, and another provider", () => Effect.gen(function* () {
    const service = yield* Service.OrchestratorMcpService;
    const caller = scope("thread:a", "session:a");
    const external = yield* service.sessionIdentity({ ...caller, thread: undefined, client: { sessionId: "external", label: "external", access: "read-only" } }).pipe(Effect.flip);
    assert.equal(external.code, "thread_credential_required");
    const denied = yield* service.sessionIdentity({ ...caller, capabilities: new Set() }).pipe(Effect.flip);
    assert.equal(denied.code, "capability_denied");
    const wrong = yield* service.sessionIdentity({ ...caller, thread: { ...caller.thread!, providerInstanceId: ProviderInstanceId.make("claude_glm") } }).pipe(Effect.flip);
    assert.equal(wrong.code, "parent_not_active");
  }).pipe(Effect.provide(layer(true))));

  for (const [active, archived, deleted] of [[false, false, false], [true, true, false], [true, false, true]]) {
    it.effect(`refuses a session with active=${active} archived=${archived} deleted=${deleted}`, () => Effect.gen(function* () {
      const service = yield* Service.OrchestratorMcpService;
      const denied = yield* service.sessionIdentity(scope("thread:a", "session:a")).pipe(Effect.flip);
      assert.equal(denied.code, "parent_not_active");
    }).pipe(Effect.provide(layer(active!, archived!, deleted!))));
  }
});
