import * as NodeHttp from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import { BridgetRustFixture, observeWrittenMcpSession } from "./BridgetRustInterop.testkit.ts";

// Explicit opt-in: the ordinary T3 suite has no dependency on a separate Rust checkout.
// Validation must set this to the freshly built isolated worktree binary.
const executable = process.env.BRIDGET_148_RUST_EXECUTABLE;
const run = executable ? it.effect : it.effect.skip;

run(
  "native148 Rust uses real HTTP session headers, closes sessions, and refuses revoked credentials",
  () => {
    const environmentId = EnvironmentId.make("environment:rust-interop148");
    const threadA = ThreadId.make("thread:rust-interop148:a");
    const threadB = ThreadId.make("thread:rust-interop148:b");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const attestedThreads: ThreadId[] = [];
    const seen: Array<{
      method: string;
      session: string | undefined;
      issued: string | undefined;
      status: number;
    }> = [];
    const httpLayer = NodeHttpServer.layer(
      () => {
        const server = NodeHttp.createServer();
        // Passive observation on the real Node server. Never retain bearer headers or bodies.
        server.on("request", (request, response) => {
          const session = request.headers["mcp-session-id"];
          const issuedSession = observeWrittenMcpSession(response);
          response.on("finish", () =>
            seen.push({
              method: request.method!,
              session: typeof session === "string" ? session : undefined,
              issued: issuedSession(),
              status: response.statusCode,
            }),
          );
        });
        return server;
      },
      { port: 0, host: "127.0.0.1" },
    );
    // Only stored conversation data and unused backend dependencies are fixtures.
    // HTTP transport, auth registry, toolkit, handler, identity service and Rust client are real.
    const storageLayer = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        getThreadRecords: (id) => {
          attestedThreads.push(id);
          const projection = idleThreadProjection(liveThreadShell(id));
          return Effect.succeed({
            ...projection,
            runs: [{ ordinal: 1, status: "running", providerInstanceId }],
          } as unknown as OrchestrationV2ThreadProjection);
        },
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
      NodeServices.layer,
    );
    const registryLayer = McpSessionRegistry.layer.pipe(
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => BridgetRustFixture.create(executable!)),
          (value) => Effect.promise(() => value.close()),
        );
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const serverLayer = McpHttpServer.toolkitRegistration(
          OrchestratorToolkit,
          OrchestratorHandlers.layer,
        ).pipe(
          Layer.provideMerge(McpHttpServer.layerMcpTransport),
          Layer.provide(OrchestratorService.layer.pipe(Layer.provideMerge(storageLayer))),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const { config: configA } = yield* registry.issue({
          threadId: threadA,
          providerInstanceId,
        });
        const { config: configB } = yield* registry.issue({
          threadId: threadB,
          providerInstanceId,
        });
        assert.equal(configA.endpoint, configB.endpoint);
        assert.equal(configA.providerInstanceId, configB.providerInstanceId);
        assert.notEqual(configA.providerSessionId, configB.providerSessionId);
        assert.isTrue(configA.authorizationHeader !== configB.authorizationHeader);
        yield* Effect.promise(() => fixture.publishRuntime(configA.endpoint));
        yield* Effect.promise(() => fixture.startDaemon());
        const agentA = yield* Effect.promise(() => fixture.registerThread(threadA));
        const agentB = yield* Effect.promise(() => fixture.registerThread(threadB));
        assert.notEqual(agentA, agentB);
        // Separate MCP mounts share the same parent harness and provider instance.
        // No real model/provider process is launched by this network recipe.
        const rustA = yield* Effect.promise(() =>
          fixture.mcp(configA.endpoint, configA.authorizationHeader),
        );
        const rustB = yield* Effect.promise(() =>
          fixture.mcp(configB.endpoint, configB.authorizationHeader),
        );
        for (const [id, rust, agentId] of [
          [3, rustA, agentA],
          [4, rustB, agentB],
        ] as const) {
          const response = yield* Effect.promise(() => rust.call(id));
          assert.equal(response.id, id);
          assert.isUndefined(response.error);
          assert.notEqual(response.result.isError, true);
          const payload =
            response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
          assert.isTrue(JSON.stringify(payload).includes(agentId));
        }
        assert.deepEqual(attestedThreads, [threadA, threadB]);
        assert.equal(
          seen.filter((request) => request.method === "POST" && !request.session).length,
          2,
        );
        assert.equal(
          seen.filter((request) => request.method === "POST" && request.session).length,
          4,
        );
        const initialized = seen.filter((request) => request.issued);
        assert.equal(initialized.length, 2);
        assert.notEqual(initialized[0]!.issued, initialized[1]!.issued);
        const deletes = seen.filter((request) => request.method === "DELETE");
        assert.equal(deletes.length, 2);
        assert.deepEqual(
          new Set(deletes.map((request) => request.session)),
          new Set(initialized.map((request) => request.issued)),
        );
        assert.isTrue(seen.every((request) => request.status >= 200 && request.status < 300));
        // A deleted transport session cannot be reused with the still-live provider credential.
        const stale = yield* Effect.promise(() =>
          fetch(configA.endpoint, {
            method: "POST",
            headers: {
              authorization: configA.authorizationHeader,
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": deletes[0]!.session!,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 9,
              method: "tools/call",
              params: { name: "bridget_session", arguments: {} },
            }),
          }),
        );
        assert.equal(stale.status, 404);
        yield* Effect.promise(() => stale.text());
        yield* registry.revokeThread(threadA);
        const denied = yield* Effect.promise(() => rustA.call(5));
        assert.equal(denied.result.isError, true);
        assert.equal(denied.result.code, "t3_session_unavailable");
        assert.equal(seen.at(-1)!.status, 401);
        assert.equal(seen.filter((request) => request.method === "DELETE").length, 2);
        const neighbor = yield* Effect.promise(() => rustB.call(6));
        assert.notEqual(neighbor.result.isError, true);
        assert.isUndefined(neighbor.error);
        assert.deepEqual(attestedThreads, [threadA, threadB, threadB]);
        assert.equal(seen.at(-1)!.method, "DELETE");
        assert.isTrue(seen.at(-1)!.status >= 200 && seen.at(-1)!.status < 300);
        assert.equal(seen.filter((request) => request.method === "DELETE").length, 3);
        assert.equal(
          new Set(seen.filter((request) => request.issued).map((request) => request.issued)).size,
          3,
        );
      }),
    ).pipe(Effect.provide(registryLayer), Effect.provide(httpLayer));
  },
  60_000,
);
