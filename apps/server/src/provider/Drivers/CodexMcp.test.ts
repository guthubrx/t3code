import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { prepareCodexBridgetMcp } from "./CodexMcp.ts";

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "148-codex-mcp-" });
  const environment = {
    HOME: home,
    T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
    PATH: "/usr/bin:/bin",
  };
  const session = {
    environmentId: EnvironmentId.make("environment-private"),
    threadId: ThreadId.make("thread-private"),
    providerSessionId: "provider-private",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer private-session-a",
    browserToolsAvailable: false,
    t3codeHome: home,
  };
  return { home, environment, session };
});

describe("SPEC148 Codex private MCP identity", () => {
  it.effect("scopes credentials to each thread mount and preserves other servers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const custom = { command: "/usr/bin/true", enabled: false };
        const a = yield* prepareCodexBridgetMcp({
          ...f,
          readConfig: () => Effect.succeed({ config: { mcp_servers: { other: custom } } }),
        });
        const b = yield* prepareCodexBridgetMcp({
          ...f,
          session: {
            ...f.session,
            providerInstanceId: ProviderInstanceId.make("codex-b"),
            authorizationHeader: "Bearer private-session-b",
          },
          readConfig: () => Effect.succeed({ config: {} }),
        });
        assert.equal(Object.hasOwn(a ?? {}, "other"), false);
        assert.deepEqual(a, {
          command: "/usr/bin/true",
          args: ["mcp"],
          env: {
            HOME: f.home,
            BRIDGET_HOME: `${f.home}/.cache/bridget-core`,
            BRIDGET_SOCKET: `${f.home}/.cache/bridget-core/bridget.sock`,
            T3CODE_HOME: f.home,
            BRIDGET_T3_MCP_ENDPOINT: f.session.endpoint,
            BRIDGET_T3_MCP_AUTHORIZATION: "Bearer private-session-a",
          },
        });
        assert.include(JSON.stringify(b), "private-session-b");
        assert.notInclude(JSON.stringify(b), "private-session-a");
        assert.equal("BRIDGET_T3_MCP_AUTHORIZATION" in f.environment, false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each([
    { enabled: false },
    { command: "/custom/bridget", env: { USER_POLICY: "keep" } },
    { url: "http://private.invalid/mcp" },
  ])("preserves custom or disabled Bridget definition %j", (bridget) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* prepareCodexBridgetMcp({
          ...f,
          readConfig: () => Effect.succeed({ config: { mcp_servers: { bridget } } }),
        });
        assert.equal(result, undefined);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("fails closed on unavailable or malformed effective config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const readConfig of [
          () => Effect.fail("private failure"),
          () => Effect.succeed({ config: { mcp_servers: false } }),
          () => Effect.succeed(undefined),
        ]) {
          assert.equal(yield* prepareCodexBridgetMcp({ ...f, readConfig }), undefined);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("revokes mount without inspecting config and remounts a fresh session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        let reads = 0;
        const readConfig = () =>
          Effect.sync(() => {
            reads += 1;
            return { config: {} };
          });
        assert.equal(
          yield* prepareCodexBridgetMcp({ ...f, session: undefined, readConfig }),
          undefined,
        );
        assert.equal(reads, 0);
        const mount = yield* prepareCodexBridgetMcp({
          ...f,
          session: {
            ...f.session,
            providerSessionId: "new-provider",
            authorizationHeader: "Bearer remount-token",
          },
          readConfig,
        });
        assert.include(JSON.stringify(mount), "remount-token");
        assert.equal(reads, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("does not overwrite inherited native identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal(
          yield* prepareCodexBridgetMcp({
            ...f,
            environment: { ...f.environment, BRIDGET_AGENT_ID_FILE: "/private/native-id" },
            readConfig: () => Effect.succeed({ config: {} }),
          }),
          undefined,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
