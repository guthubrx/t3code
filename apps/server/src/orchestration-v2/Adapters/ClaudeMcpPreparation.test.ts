import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
}));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-", directory: "/private/tmp" });
  const environment = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: home,
    T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
    BRIDGET_HOME: home,
    BRIDGET_SOCKET: `${home}/bridget.sock`,
  };
  const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner.pipe(
    Effect.provide(
      ClaudeAdapter.layerQueryRunner.pipe(
        Layer.provide(Layer.succeed(HostProcessEnvironment, environment)),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
    ),
  );
  const started = Promise.withResolvers<void>();
  const close = vi.fn();
  const setMcpServers = vi.fn().mockResolvedValue({ errors: {} });
  const status = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      { name: "bridget", status: "connected", tools: [{ name: "bridget_thread" }] },
    ]);
  sdk.query.mockReset().mockReturnValue({ close, setMcpServers, mcpServerStatus: status });
  const open = runner.open({
    threadId: ThreadId.make("thread-mcp-test"),
    providerSessionId: ProviderSessionId.make("session-mcp-test"),
    options: {
      model: "test-model",
      tools: [],
      permissionMode: "default",
      sessionId: "test-native-session",
      cwd: home,
      env: environment,
      mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } },
    },
  });
  return { open, close, setMcpServers, status, started };
});

it.effect("prepares Bridget before publishing a V2 query and preserves T3 MCP", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const session = yield* f.open;
    assert.equal(f.status.mock.calls.length, 2);
    assert.containsAllKeys(f.setMcpServers.mock.calls[0]![0], ["bridget", "t3-code"]);
    assert.equal(f.close.mock.calls.length, 0);
    yield* session.close;
    assert.equal(f.close.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes a failed MCP candidate without publishing it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setMcpServers.mockRejectedValue(new Error("private SDK failure"));
    const error = yield* f.open.pipe(Effect.flip);
    assert.equal(error._tag, "ClaudeAgentSdkQueryRunnerError");
    assert.equal(f.close.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes a preparation that exceeds its deadline", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.status.mockReset().mockImplementation(() => {
      f.started.resolve();
      return new Promise(() => {});
    });
    const fiber = yield* f.open.pipe(Effect.forkChild);
    yield* Effect.promise(() => f.started.promise);
    yield* TestClock.adjust("6 seconds");
    yield* Fiber.join(fiber).pipe(Effect.flip);
    assert.equal(f.close.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes an interrupted preparation before it can publish a query", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.status.mockReset().mockImplementation(() => {
      f.started.resolve();
      return new Promise(() => {});
    });
    const fiber = yield* f.open.pipe(Effect.forkChild);
    yield* Effect.promise(() => f.started.promise);
    yield* Fiber.interrupt(fiber);
    assert.equal(f.close.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
