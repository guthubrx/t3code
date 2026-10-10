import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

/** Real user case: the global Bridget definition is the official binary behind a symlink. */
const officialFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const f = yield* fixture();
  const executable = Effect.fn(function* (...segments: ReadonlyArray<string>) {
    const file = path.join(f.home, ...segments);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(file, 0o755);
    return file;
  });
  const real = yield* executable("real", "bridget");
  const other = yield* executable("other", "bridget");
  const bin = path.join(f.home, ".local", "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  const link = path.join(bin, "bridget");
  yield* fs.symlink(real, link);
  const foreignLink = path.join(bin, "foreign");
  yield* fs.symlink(other, foreignLink);
  return {
    ...f,
    fs,
    path,
    real,
    other,
    bin,
    link,
    foreignLink,
    environment: { ...f.environment, T3CODE_BRIDGET_EXECUTABLE: real },
  };
});

/** Final mount is canonical: absolute real path, fixed args, only the six identity keys. */
const canonicalEnv = (f: {
  home: string;
  session: { endpoint: string; authorizationHeader: string };
}) => ({
  HOME: f.home,
  BRIDGET_HOME: `${f.home}/.cache/bridget-core`,
  BRIDGET_SOCKET: `${f.home}/.cache/bridget-core/bridget.sock`,
  T3CODE_HOME: f.home,
  BRIDGET_T3_MCP_ENDPOINT: f.session.endpoint,
  BRIDGET_T3_MCP_AUTHORIZATION: f.session.authorizationHeader,
});

const asServer = (value: unknown) =>
  value as Record<string, unknown> & { env: Record<string, string> };

describe("SPEC149 Codex official global Bridget refresh", () => {
  it.effect("refreshes the official symlinked global server with a canonical mount", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const definition = {
          command: f.link,
          args: ["mcp"],
          enabled: true,
          startup_timeout_sec: 45,
          tool_timeout_sec: 120,
          env: {
            HOME: f.home,
            BRIDGET_T3_MCP_ENDPOINT: "http://127.0.0.1:1/stale",
            BRIDGET_T3_MCP_AUTHORIZATION: "Bearer stale-user-value",
          },
        };
        const config = {
          config: { mcp_servers: { bridget: definition, other: { command: "x" } } },
        };
        const before = structuredClone(config);
        const environmentBefore = { ...f.environment };
        const result = asServer(
          yield* prepareCodexBridgetMcp({ ...f, readConfig: () => Effect.succeed(config) }),
        );
        assert.isDefined(result);
        assert.deepEqual(result.args, ["mcp"]);
        assert.equal("type" in result, false);
        // Pinned to the canonical absolute path, never the user's string (symlink).
        assert.equal(result.command, yield* f.fs.realPath(f.real));
        assert.notEqual(result.command, f.link);
        // Safe existing options survive.
        assert.equal(result.startup_timeout_sec, 45);
        assert.equal(result.tool_timeout_sec, 120);
        assert.deepEqual(result.env, canonicalEnv(f));
        assert.notInclude(JSON.stringify(result), "stale");
        // No credential mutation: the user's config object and the process env stay as read.
        assert.deepEqual(config, before);
        assert.notInclude(JSON.stringify(config), f.session.authorizationHeader);
        assert.deepEqual(f.environment, environmentBefore);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("rotates endpoint and authorization per session from the same global config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const config = {
          config: { mcp_servers: { bridget: { command: f.link, args: ["mcp"] } } },
        };
        const readConfig = () => Effect.succeed(config);
        const sessions = ["a", "b"].map((id, index) => ({
          ...f.session,
          providerSessionId: `provider-${id}`,
          endpoint: `http://127.0.0.1:${43200 + index}/mcp`,
          authorizationHeader: `Bearer rotated-${id}`,
        }));
        const [a, b] = [
          asServer(yield* prepareCodexBridgetMcp({ ...f, session: sessions[0], readConfig })),
          asServer(yield* prepareCodexBridgetMcp({ ...f, session: sessions[1], readConfig })),
        ];
        assert.equal(a.env.BRIDGET_T3_MCP_AUTHORIZATION, "Bearer rotated-a");
        assert.equal(b.env.BRIDGET_T3_MCP_AUTHORIZATION, "Bearer rotated-b");
        assert.equal(a.env.BRIDGET_T3_MCP_ENDPOINT, "http://127.0.0.1:43200/mcp");
        assert.equal(b.env.BRIDGET_T3_MCP_ENDPOINT, "http://127.0.0.1:43201/mcp");
        assert.notInclude(JSON.stringify(b), "rotated-a");
        assert.notInclude(JSON.stringify(a), "rotated-b");
        assert.notInclude(JSON.stringify(config), "rotated-");
        // Revoked session: no proof leaves, whatever the global definition says.
        assert.equal(
          yield* prepareCodexBridgetMcp({ ...f, session: undefined, readConfig }),
          undefined,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("recognises the user's ~/.local/bin symlink when no executable is forced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const { T3CODE_BRIDGET_EXECUTABLE: _forced, ...environment } = f.environment;
        const result = asServer(
          yield* prepareCodexBridgetMcp({
            ...f,
            environment,
            readConfig: () =>
              Effect.succeed({
                config: { mcp_servers: { bridget: { command: f.link, args: ["mcp"] } } },
              }),
          }),
        );
        assert.equal(result.command, yield* f.fs.realPath(f.real));
        assert.deepEqual(result.env, canonicalEnv(f));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("resolves a bare command through the process PATH", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const result = asServer(
          yield* prepareCodexBridgetMcp({
            ...f,
            environment: { ...f.environment, PATH: `${f.bin}:/usr/bin:/bin` },
            readConfig: () =>
              Effect.succeed({
                config: {
                  mcp_servers: {
                    bridget: {
                      command: "bridget",
                      args: ["mcp"],
                    },
                  },
                },
              }),
          }),
        );
        // The bare name is recognised through the PATH, then, then pinned canonically.
        assert.equal(result.command, yield* f.fs.realPath(f.real));
        assert.deepEqual(result.env, canonicalEnv(f));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each([
    { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib" },
    { LD_PRELOAD: "/tmp/evil.so" },
    { NODE_OPTIONS: "--require /tmp/evil.js" },
    { UNKNOWN_USER_VARIABLE: "1" },
  ])("never mounts the session token next to unknown user env %j", (extra) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const result = yield* prepareCodexBridgetMcp({
          ...f,
          readConfig: () =>
            Effect.succeed({
              config: {
                mcp_servers: { bridget: { command: f.link, args: ["mcp"], env: extra } },
              },
            }),
        });
        // Refusal and canonical-only mount are both safe; carrying the variable is not.
        if (result !== undefined) {
          assert.deepEqual(asServer(result).env, canonicalEnv(f));
          assert.notInclude(JSON.stringify(result), Object.keys(extra)[0]!);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly build: (f: {
      link: string;
      other: string;
      foreignLink: string;
      home: string;
    }) => unknown;
  }> = [
    { name: "another binary", build: (f) => ({ command: f.other, args: ["mcp"] }) },
    {
      name: "symlink to another binary",
      build: (f) => ({ command: f.foreignLink, args: ["mcp"] }),
    },
    { name: "extra argument", build: (f) => ({ command: f.link, args: ["mcp", "--debug"] }) },
    { name: "other subcommand", build: (f) => ({ command: f.link, args: ["serve"] }) },
    { name: "empty args", build: (f) => ({ command: f.link, args: [] }) },
    { name: "missing args", build: (f) => ({ command: f.link }) },
    { name: "disabled", build: (f) => ({ command: f.link, args: ["mcp"], enabled: false }) },
    { name: "string enabled", build: (f) => ({ command: f.link, args: ["mcp"], enabled: "true" }) },
    { name: "http type", build: (f) => ({ command: f.link, args: ["mcp"], type: "http" }) },
    { name: "custom url", build: () => ({ url: "http://private.invalid/mcp" }) },
    {
      name: "command and url",
      build: (f) => ({ command: f.link, args: ["mcp"], url: "http://x" }),
    },
    {
      name: "missing executable",
      build: (f) => ({ command: `${f.home}/missing/bridget`, args: ["mcp"] }),
    },
    { name: "bare command off PATH", build: () => ({ command: "bridget", args: ["mcp"] }) },
    { name: "non-record definition", build: () => "bridget" },
    { name: "null definition", build: () => null },
    { name: "non-string env", build: (f) => ({ command: f.link, args: ["mcp"], env: { A: 1 } }) },
    {
      name: "inherited identity file",
      build: (f) => ({
        command: f.link,
        args: ["mcp"],
        env: { BRIDGET_AGENT_ID_FILE: "/private/id" },
      }),
    },
    {
      name: "inherited instance id",
      build: (f) => ({
        command: f.link,
        args: ["mcp"],
        env: { BRIDGET_AGENT_INSTANCE_ID: "agent" },
      }),
    },
    ...["HOME", "BRIDGET_HOME", "BRIDGET_SOCKET", "T3CODE_HOME"].map((key) => ({
      name: `foreign ${key}`,
      build: (f: { link: string }) => ({
        command: f.link,
        args: ["mcp"],
        env: { [key]: "/foreign" },
      }),
    })),
  ];
  it.effect.each(refusals)("keeps the user's definition untouched: $name", ({ build }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const config = { config: { mcp_servers: { bridget: build(f) } } };
        const before = structuredClone(config);
        const result = yield* prepareCodexBridgetMcp({
          ...f,
          readConfig: () => Effect.succeed(config),
        });
        assert.isUndefined(result);
        assert.deepEqual(config, before);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("does not refresh an official definition over inherited process identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        assert.isUndefined(
          yield* prepareCodexBridgetMcp({
            ...f,
            environment: { ...f.environment, BRIDGET_AGENT_ID_FILE: "/private/native-id" },
            readConfig: () =>
              Effect.succeed({
                config: { mcp_servers: { bridget: { command: f.link, args: ["mcp"] } } },
              }),
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
