import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
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

// Spec 149 (permissions lineage). `sessionIdentity` is the only reader of the
// private permission facts: identity-only v1 while no valid fact exists for
// the live run, v2 with the bound permissions once a fact is published for the
// credential mounted on the calling thread. Every failure path collapses to
// the same closed refusal; none of them downgrade a tombstone back to v1 and
// none of them echo source material (credential, endpoint or policy detail).

const scope = (): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:bridget"),
  thread: {
    threadId: ThreadId.make("thread:a"),
    providerSessionId: "session:a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "session:a",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});
const mountedCredential = (over: Record<string, unknown> = {}) => {
  const config = {
    environmentId: EnvironmentId.make("environment:bridget"),
    threadId: ThreadId.make("thread:a"),
    providerSessionId: "session:a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:9/private-endpoint",
    authorizationHeader: "Bearer private-proof-149",
    browserToolsAvailable: false,
    ...over,
  };
  McpProviderSession.setMcpProviderSession(config);
  return config;
};
const fact = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  source: "provider_turn" as const,
  run_id: "run-1",
  provider_session_id: "session:a",
  provider_instance_id: "codex",
  driver: "codex_app_server" as const,
  cwd: "/tmp/project",
  runtime_mode: "full-access" as const,
  interaction_mode: "default" as const,
  provider_policy: {
    kind: "codex" as const,
    approval_policy: "never" as const,
    approvals_reviewer: "user" as const,
    sandbox_policy: { type: "dangerFullAccess" } as const,
  },
  ...over,
});
const binding = { attemptId: "attempt-1", providerThreadId: "native-1" };
const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  ordinal: 1,
  status: "running",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeAttemptId: "attempt-1",
  providerThreadId: "native-1",
  ...over,
});
const projection = (runs: unknown[]) =>
  ({
    ...idleThreadProjection(liveThreadShell(ThreadId.make("thread:a"))),
    runs,
  }) as unknown as OrchestrationV2ThreadProjection;
const layer = (
  records: (
    threadId: ThreadId,
    fields?: ReadonlyArray<string>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection>,
) =>
  Service.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadRecords: records }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );
const withCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.ensuring(
    effect,
    Effect.sync(() => McpProviderSession.clearMcpProviderSession(ThreadId.make("thread:a"))),
  );
const expectAttestationRefusal = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(effect);
    assert.equal((failure as { code: string }).code, "permission_attestation_unavailable");
    assert.equal((failure as { message: string }).message, message);
  });
const DOES_NOT_OWN = "The current provider credential does not own this attestation.";
const STALE = "The provider permission fact is missing, stale or no longer owned by this run.";

describe("session identity v1/v2 from the mounted credential", () => {
  it.effect("returns identity-only v1 while no fact is published for the live run", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        mountedCredential();
        const result = yield* service.sessionIdentity(scope());
        assert.deepEqual(result, {
          version: 1,
          environmentId: "environment:bridget",
          threadId: "thread:a",
          providerSessionId: "session:a",
          providerInstanceId: "codex",
        });
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  it.effect("returns v2 with the exact published permissions once a fact is valid", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        const credential = mountedCredential();
        assert.notEqual(
          McpProviderSession.publishMcpProviderPermissions(credential, fact(), binding),
          undefined,
        );
        const result = yield* service.sessionIdentity(scope());
        assert.equal(result.version, 2);
        if (result.version !== 2) return;
        assert.deepEqual(result.permissions, {
          version: 1,
          source: "provider_turn",
          run_id: "run-1",
          provider_session_id: "session:a",
          provider_instance_id: "codex",
          revision: 1,
          driver: "codex_app_server",
          cwd: "/tmp/project",
          runtime_mode: "full-access",
          interaction_mode: "default",
          provider_policy: fact().provider_policy,
        });
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes("private-endpoint"), false);
        assert.equal(serialized.includes("private-proof-149"), false);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );
});

describe("refusals that never downgrade to v1", () => {
  it.effect("refuses without a mounted credential", () =>
    Effect.gen(function* () {
      const service = yield* Service.OrchestratorMcpService;
      yield* expectAttestationRefusal(service.sessionIdentity(scope()), DOES_NOT_OWN);
    }).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  it.effect("refuses when the mounted credential session or instance mismatches the caller", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        mountedCredential({ providerSessionId: "session:z" });
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), DOES_NOT_OWN);
        mountedCredential({
          providerSessionId: "session:a",
          providerInstanceId: ProviderInstanceId.make("claude_glm"),
        });
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), DOES_NOT_OWN);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  it.effect("refuses a fact bound to another run and never falls back to v1", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        const credential = mountedCredential();
        McpProviderSession.publishMcpProviderPermissions(
          credential,
          fact({ run_id: "run-9" }),
          binding,
        );
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), STALE);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  it.effect("refuses a tombstone and never falls back to v1", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        const credential = mountedCredential();
        McpProviderSession.publishMcpProviderPermissions(credential, fact(), binding);
        McpProviderSession.invalidateMcpProviderPermissions(credential, "run-1", 1);
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), STALE);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  it.effect("refuses after the source verification invalidated the fact", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        const credential = mountedCredential();
        McpProviderSession.publishMcpProviderPermissions(
          credential,
          fact(),
          binding,
          async () => false,
        );
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), STALE);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );

  const supersededRun = { live: false };
  const runChangesBetweenProjections = () =>
    Effect.succeed(
      projection([
        supersededRun.live ? run({ id: "run-2", ordinal: 2, activeAttemptId: "attempt-2" }) : run(),
      ]),
    );
  it.effect("refuses when the live run changed between the two projections", () =>
    withCleanup(
      Effect.gen(function* () {
        const credential = mountedCredential();
        // The verifier runs after the first projection: flipping the flag there
        // makes the recheck observe a newer run without counting internal reads.
        McpProviderSession.publishMcpProviderPermissions(credential, fact(), binding, async () => {
          supersededRun.live = true;
          return true;
        });
        const service = yield* Service.OrchestratorMcpService;
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), STALE);
      }).pipe(Effect.provide(layer(runChangesBetweenProjections))),
    ),
  );

  it.effect("refuses when the credential was remounted during verification", () =>
    withCleanup(
      Effect.gen(function* () {
        const service = yield* Service.OrchestratorMcpService;
        const credential = mountedCredential();
        McpProviderSession.publishMcpProviderPermissions(credential, fact(), binding, async () => {
          // An equal-field impostor object takes the mount during verification.
          McpProviderSession.setMcpProviderSession({ ...credential });
          return true;
        });
        yield* expectAttestationRefusal(service.sessionIdentity(scope()), STALE);
      }),
    ).pipe(Effect.provide(layer(() => Effect.succeed(projection([run()]))))),
  );
});

describe("SPEC172 bounded session attestation", () => {
  it.effect("reads only live run records before and after source verification", () => {
    const reads: boolean[] = [];
    let verified = false;
    return withCleanup(
      Effect.gen(function* () {
        const credential = mountedCredential();
        McpProviderSession.publishMcpProviderPermissions(credential, fact(), binding, async () => {
          verified = true;
          return true;
        });
        const service = yield* Service.OrchestratorMcpService;
        const result = yield* service.sessionIdentity(scope());
        assert.equal(result.version, 2);
        assert.deepEqual(reads, [false, true]);
      }),
    ).pipe(
      Effect.provide(
        layer((_id, fields) =>
          Effect.sync(() => {
            assert.deepEqual(fields, ["runs"], "attestation must not load conversation history");
            reads.push(verified);
            const value = projection([run()]);
            // No messages, provider turns or tools are needed to prove this live run.
            return { thread: value.thread, runs: value.runs } as OrchestrationV2ThreadProjection;
          }),
        ),
      ),
    );
  });
});
