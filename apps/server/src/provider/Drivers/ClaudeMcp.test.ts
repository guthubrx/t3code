import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { McpServerConfig, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import {
  CLAUDE_BRIDGET_READ_ONLY_TOOLS,
  claudeBridgetReadOnlySettings,
  prepareClaudeMcp,
} from "./ClaudeMcp.ts";

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "147-mcp-" });
  const calls: Array<Record<string, McpServerConfig>> = [];
  let statuses: McpServerStatus[] = [];
  const query = {
    mcpServerStatus: async () => statuses,
    setMcpServers: async (servers: Record<string, McpServerConfig>) => {
      calls.push(servers);
      statuses = [
        {
          name: "bridget",
          status: "connected",
          source: "dynamic",
          tools: [{ name: "bridget_thread" }],
        },
      ];
      return { added: ["bridget"], removed: [], errors: {} };
    },
  };
  const input = {
    query,
    config: { homePath: home },
    cwd: home,
    environment: { HOME: home, T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true", PATH: "/usr/bin:/bin" },
    extraArgs: {},
    session: {
      environmentId: EnvironmentId.make("environment-private"),
      threadId: ThreadId.make("thread-private"),
      providerSessionId: "provider-private",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer private-session-a",
      browserToolsAvailable: false,
      t3codeHome: home,
    },
    servers: {
      "t3-code": {
        type: "http" as const,
        url: "http://private.invalid/mcp",
        headers: { Authorization: "private-fixture" },
      },
    },
  };
  return {
    fs,
    path,
    home,
    calls,
    input,
    setStatuses: (value: McpServerStatus[]) => {
      statuses = value;
    },
  };
});

describe("SPEC147 Claude MCP policy", () => {
  it.effect.each(["disabled", "custom", "revoked", "explicit"] as const)(
    "does not apply session read rules when preparation is $case",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          let applied = 0;
          if (reason === "disabled")
            yield* f.fs.writeFileString(
              f.path.join(f.home, "settings.json"),
              '{"disabledMcpServers":["bridget"]}',
            );
          if (reason === "custom")
            f.setStatuses([
              { name: "bridget", status: "connected", tools: [{ name: "bridget_capabilities" }] },
            ]);
          const result = yield* prepareClaudeMcp({
            ...f.input,
            session: reason === "revoked" ? undefined : f.input.session,
            extraArgs: reason === "explicit" ? { "mcp-config": "private-config" } : {},
            readOnlySettings: claudeBridgetReadOnlySettings(undefined),
            query: {
              ...f.input.query,
              applyFlagSettings: async () => {
                applied += 1;
              },
            },
          });
          assert.equal(
            result.code,
            {
              disabled: "disabled",
              custom: "user_server",
              revoked: "identity_unavailable",
              explicit: "explicit_config",
            }[reason],
          );
          assert.equal(applied, 0);
          assert.equal(f.calls.length, 0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it("adds only exact native read rules and preserves existing denial and ask rules", () => {
    const permissions = {
      allow: ["Read"],
      deny: ["mcp__bridget__bridget_task_status"],
      ask: ["mcp__bridget__bridget_capabilities"],
      defaultMode: "dontAsk" as const,
    };
    assert.deepEqual(claudeBridgetReadOnlySettings({ permissions }), {
      permissions: {
        ...permissions,
        allow: ["Read", ...CLAUDE_BRIDGET_READ_ONLY_TOOLS],
      },
    });
    assert.isUndefined(claudeBridgetReadOnlySettings("/private/settings.json"));
    assert.isFalse(
      CLAUDE_BRIDGET_READ_ONLY_TOOLS.some(
        (name) => name.includes("delegate") || name.includes("cancel") || name.includes("*"),
      ),
    );
  });
  it.effect("applies read approvals only after its real mount and verified catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const settings = claudeBridgetReadOnlySettings({ permissions: { deny: ["Bash"] } })!;
        const applied: unknown[] = [];
        const query = {
          ...f.input.query,
          setMcpServers: async (servers: Record<string, McpServerConfig>) => {
            const result = await f.input.query.setMcpServers(servers);
            f.setStatuses([
              {
                name: "bridget",
                status: "connected",
                source: "dynamic",
                tools: [
                  { name: "bridget_thread" },
                  { name: "bridget_capabilities" },
                  { name: "bridget_task_status" },
                ],
              },
            ]);
            return result;
          },
          applyFlagSettings: async (value: unknown) => {
            applied.push(value);
          },
        };
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, query, readOnlySettings: settings })).code,
          "mounted",
        );
        assert.deepEqual(applied, [settings]);
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, query, readOnlySettings: settings })).code,
          "user_server",
        );
        assert.equal(applied.length, 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("never changes rules on opt-out and closes a missing read catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        let applied = 0;
        const input = {
          ...f.input,
          readOnlySettings: claudeBridgetReadOnlySettings(undefined),
          query: {
            ...f.input.query,
            applyFlagSettings: async () => {
              applied += 1;
            },
          },
        };
        assert.equal(
          (yield* prepareClaudeMcp({ ...input, extraArgs: { "strict-mcp-config": null } })).code,
          "explicit_config",
        );
        const failure = yield* prepareClaudeMcp(input).pipe(Effect.flip);
        assert.equal(failure.code, "catalogue_unavailable");
        assert.equal(applied, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("checks explicit metadata refusal before a rejecting SDK status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, "settings.json"),
          '{"disabledMcpServers":["bridget"]}',
        );
        let statusCalls = 0;
        f.input.query.mcpServerStatus = async () => {
          statusCalls += 1;
          throw new Error("private rejected SDK");
        };
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "disabled");
        assert.equal(statusCalls, 0);
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  (process.env.BRIDGET_147_CLAUDE_METADATA_COMMAND ? it.live : it.live.skip)(
    "private native Claude root metadata proof without a model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const cwd = f.path.join(f.home, "repository", "nested");
          const root = f.path.dirname(cwd);
          const configDir = f.path.join(f.home, "profile");
          yield* f.fs.makeDirectory(cwd, { recursive: true });
          yield* f.fs.makeDirectory(configDir);
          yield* f.fs.makeDirectory(f.path.join(root, ".git"));
          yield* f.fs.makeDirectory(f.path.join(root, ".claude"));
          const run = (label: string) => {
            const result = NodeChildProcess.spawnSync(
              process.env.BRIDGET_147_CLAUDE_METADATA_COMMAND!,
              ["mcp", "get", "bridget"],
              {
                cwd,
                env: {
                  HOME: f.home,
                  CLAUDE_CONFIG_DIR: configDir,
                  PATH: "/usr/bin:/bin",
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                },
                encoding: "utf8",
                timeout: 6000,
              },
            );
            const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
            return {
              label,
              rc: result.status,
              absent: /no.+mcp|mcp.+not.+found/i.test(output),
              projectScope: /project/i.test(output),
              disabled: /disabled/i.test(output),
              permissionDenied: /denied|not allowed/i.test(output),
            };
          };
          const evidence = [run("absent")];
          yield* f.fs.writeFileString(
            f.path.join(root, ".mcp.json"),
            '{"mcpServers":{"bridget":{"type":"stdio","command":"/usr/bin/true","args":[]}}}',
          );
          evidence.push(run("root_mcp_definition"));
          yield* f.fs.writeFileString(
            f.path.join(root, ".claude", "settings.json"),
            '{"disabledMcpjsonServers":["bridget"]}',
          );
          evidence.push(run("root_plain_settings_disabled"));
          yield* f.fs.writeFileString(f.path.join(root, ".claude", "settings.json"), "{}");
          yield* f.fs.writeFileString(
            f.path.join(configDir, ".claude.json"),
            JSON.stringify({ projects: { [root]: { disabledMcpServers: ["bridget"] } } }),
          );
          evidence.push(run("root_profile_disabled"));
          process.stdout.write(`SPEC147_NATIVE_MCP_METADATA ${JSON.stringify(evidence)}\n`);
          assert.equal(evidence[0]?.rc, 1);
          assert.equal(evidence[1]?.rc, 0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect("mounts stdio with private session identity and preserves t3-code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "mounted");
        assert.deepEqual(f.calls[0]?.["t3-code"], f.input.servers["t3-code"]);
        assert.deepEqual(f.calls[0]?.bridget, {
          type: "stdio",
          command: "/usr/bin/true",
          args: ["mcp"],
          env: {
            HOME: f.home,
            BRIDGET_HOME: f.path.join(f.home, ".cache", "bridget-core"),
            BRIDGET_SOCKET: f.path.join(f.home, ".cache", "bridget-core", "bridget.sock"),
            T3CODE_HOME: f.home,
            BRIDGET_T3_MCP_ENDPOINT: f.input.session.endpoint,
            BRIDGET_T3_MCP_AUTHORIZATION: f.input.session.authorizationHeader,
          },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("keeps rotated sessions separate and closes identity when revoked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* fixture();
        const b = yield* fixture();
        b.input.session.authorizationHeader = "Bearer private-session-b";
        b.input.session.providerInstanceId = ProviderInstanceId.make("claude_glm");
        assert.equal((yield* prepareClaudeMcp(a.input)).code, "mounted");
        assert.equal((yield* prepareClaudeMcp(b.input)).code, "mounted");
        const aServer = a.calls[0]?.bridget;
        const bServer = b.calls[0]?.bridget;
        assert.ok(aServer && "env" in aServer && bServer && "env" in bServer);
        if (aServer && "env" in aServer && bServer && "env" in bServer) {
          assert.equal(aServer.env?.BRIDGET_T3_MCP_AUTHORIZATION, "Bearer private-session-a");
          assert.equal(bServer.env?.BRIDGET_T3_MCP_AUTHORIZATION, "Bearer private-session-b");
        }
        const c = yield* fixture();
        assert.equal(
          (yield* prepareClaudeMcp({ ...c.input, session: undefined })).code,
          "identity_unavailable",
        );
        assert.equal(c.calls.length, 0);
        assert.equal("BRIDGET_T3_MCP_AUTHORIZATION" in a.input.environment, false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect.each(
    (["connected", "failed", "disabled", "pending", "needs-auth"] as const).flatMap((status) =>
      ["user", "project", "plugin", "managed"].map((scope) => ({ status, scope })),
    ),
  )("keeps homonymous $scope/$status server", ({ status, scope }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.setStatuses([{ name: "bridget", status, scope }]);
        // A disabled homonym is a refusal by the user; any other one has no proof of origin.
        assert.equal(
          (yield* prepareClaudeMcp(f.input)).code,
          status === "disabled" ? "disabled" : "user_server",
        );
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect.each(["strict-mcp-config", "mcp-config"])("respects explicit %s", (flag) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, extraArgs: { [flag]: null } })).code,
          "explicit_config",
        );
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each(
    ["BRIDGET_AGENT_ID_FILE", "BRIDGET_AGENT_INSTANCE_ID"].flatMap((key) =>
      ["foreign-identity", "   "].map((value) => ({ key, value })),
    ),
  )("refuses inherited $key/$value", ({ key, value }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const environment: NodeJS.ProcessEnv = { ...f.input.environment, [key]: value };
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, environment })).code,
          "inherited_identity",
        );
        assert.equal(environment[key], value);
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each([
    '{"disabledMcpjsonServers":["bridget"]}',
    '{"disabledMcpServers":["bridget"]}',
    '{"disabledMcpServers":false}',
    "{broken",
  ])("fails closed on disabled or malformed metadata %s", (contents) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.home, "settings.json"), contents);
        const result = yield* prepareClaudeMcp(f.input);
        assert.equal(
          result.code,
          contents.includes('["bridget"]') ? "disabled" : "metadata_unavailable",
        );
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("does not bypass a profile's local .claude.json opt-out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ projects: { [f.home]: { disabledMcpServers: ["bridget"] } } }),
        );
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "disabled");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("respects repository-root project metadata from a nested cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const cwd = f.path.join(f.home, "nested");
        yield* f.fs.makeDirectory(cwd);
        yield* f.fs.makeDirectory(f.path.join(f.home, ".git"));
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ projects: { [f.home]: { disabledMcpServers: ["bridget"] } } }),
        );
        assert.equal((yield* prepareClaudeMcp({ ...f.input, cwd })).code, "disabled");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("honors a conservative repository-root settings refusal without widening Skills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const cwd = f.path.join(f.home, "nested");
        yield* f.fs.makeDirectory(cwd);
        yield* f.fs.makeDirectory(f.path.join(f.home, ".git"));
        yield* f.fs.makeDirectory(f.path.join(f.home, ".claude"));
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude", "settings.json"),
          '{"disabledMcpjsonServers":["bridget"]}',
        );
        assert.equal((yield* prepareClaudeMcp({ ...f.input, cwd })).code, "disabled");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each([
    '{"deniedMcpServers":[{"serverName":"bridget"}]}',
    '{"allowedMcpServers":[]}',
    '{"allowedMcpServers":[{"serverName":"other"}]}',
  ])("respects explicit MCP permission metadata %s", (contents) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.fs.writeFileString(f.path.join(f.home, "settings.json"), contents);
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "disabled");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("fails closed on settings read refusal, not only malformed JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const settings = f.path.join(f.home, "settings.json");
        yield* f.fs.writeFileString(settings, "{}");
        const fs = FileSystem.FileSystem.of({
          ...f.fs,
          readFileString: (file) =>
            file === settings
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readFileString",
                  }),
                )
              : f.fs.readFileString(file),
        });
        assert.equal(
          (yield* prepareClaudeMcp(f.input).pipe(Effect.provideService(FileSystem.FileSystem, fs)))
            .code,
          "metadata_unavailable",
        );
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("does not claim connected tools for a pending catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.input.query.setMcpServers = async (servers) => {
          f.calls.push(servers);
          f.setStatuses([{ name: "bridget", status: "pending" }]);
          return { added: ["bridget"], removed: [], errors: {} };
        };
        const error = yield* prepareClaudeMcp(f.input).pipe(Effect.flip);
        assert.equal(error.code, "catalogue_unavailable");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("sanitizes SDK rejection without changing permissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.input.query.mcpServerStatus = async () => {
          throw new Error("PRIVATE_API_KEY=secret");
        };
        const error = yield* prepareClaudeMcp(f.input).pipe(Effect.flip);
        assert.equal(error.code, "sdk_failed");
        assert.notMatch(String(error), /PRIVATE_API_KEY|secret/);
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
// @effect-diagnostics nodeBuiltinImport:off - Opt-in native CLI metadata proof; no query/model.
import * as NodeChildProcess from "node:child_process";

/** Real user case: the global Bridget server is the official binary behind a symlink. */
const officialFixture = Effect.fn(function* () {
  const f = yield* fixture();
  const executable = Effect.fn(function* (...segments: ReadonlyArray<string>) {
    const file = f.path.join(f.home, ...segments);
    yield* f.fs.makeDirectory(f.path.dirname(file), { recursive: true });
    yield* f.fs.writeFileString(file, "#!/bin/sh\nexit 0\n");
    yield* f.fs.chmod(file, 0o755);
    return file;
  });
  const real = yield* executable("real", "bridget");
  const other = yield* executable("other", "bridget");
  const bin = f.path.join(f.home, ".local", "bin");
  yield* f.fs.makeDirectory(bin, { recursive: true });
  const link = f.path.join(bin, "bridget");
  yield* f.fs.symlink(real, link);
  const foreignLink = f.path.join(bin, "foreign");
  yield* f.fs.symlink(other, foreignLink);
  const input = {
    ...f.input,
    environment: { ...f.input.environment, T3CODE_BRIDGET_EXECUTABLE: real },
  };
  const official = {
    type: "stdio" as const,
    command: link,
    args: ["mcp"],
    env: {},
  };
  return { ...f, input, real, other, bin, link, foreignLink, official };
});
type Official = Effect.Success<ReturnType<typeof officialFixture>>;
const fullCatalogue: McpServerStatus["tools"] = [
  { name: "bridget_thread" },
  { name: "bridget_capabilities" },
  { name: "bridget_task_status" },
];
/** Final mount is canonical: absolute real path, fixed args, only the six identity keys. */
const canonicalEnv = (f: Official, session = f.input.session) => ({
  HOME: f.home,
  BRIDGET_HOME: f.path.join(f.home, ".cache", "bridget-core"),
  BRIDGET_SOCKET: f.path.join(f.home, ".cache", "bridget-core", "bridget.sock"),
  T3CODE_HOME: f.home,
  BRIDGET_T3_MCP_ENDPOINT: session.endpoint,
  BRIDGET_T3_MCP_AUTHORIZATION: session.authorizationHeader,
});
const mountedServer = (f: Official, index = 0) => {
  const server = f.calls[index]?.bridget as unknown as {
    command: string;
    args: string[];
    env: Record<string, string>;
    [key: string]: unknown;
  };
  return server;
};

describe("SPEC149 Claude official global Bridget refresh", () => {
  it.effect.each(["profile", "status", "sdk-servers", "mcp-json"] as const)(
    "refreshes the official server declared in %s with a canonical mount",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* officialFixture();
          const profile = f.path.join(f.home, ".claude.json");
          if (source === "profile")
            yield* f.fs.writeFileString(
              profile,
              JSON.stringify({ mcpServers: { bridget: f.official } }),
            );
          if (source === "mcp-json")
            yield* f.fs.writeFileString(
              f.path.join(f.home, ".mcp.json"),
              JSON.stringify({ mcpServers: { bridget: f.official } }),
            );
          if (source === "status")
            f.setStatuses([
              {
                name: "bridget",
                status: "connected",
                scope: "user",
                config: f.official,
                tools: [],
              },
            ]);
          const input =
            source === "sdk-servers"
              ? { ...f.input, servers: { ...f.input.servers, bridget: f.official } }
              : f.input;
          const fileBefore = source === "profile" ? yield* f.fs.readFileString(profile) : undefined;
          assert.equal((yield* prepareClaudeMcp(input)).code, "mounted");
          const server = mountedServer(f);
          assert.deepEqual(server.args, ["mcp"]);
          assert.deepEqual(server.env, canonicalEnv(f));
          // Pinned to the canonical absolute path, never the user's string (symlink).
          assert.equal(server.command, yield* f.fs.realPath(f.real));
          assert.notEqual(server.command, f.link);
          assert.deepEqual(f.calls[0]?.["t3-code"], f.input.servers["t3-code"]);
          // No credential mutation: the user's file never receives the session proof.
          if (fileBefore !== undefined) {
            assert.equal(yield* f.fs.readFileString(profile), fileBefore);
          }
          assert.notInclude(JSON.stringify(f.official), "private-session-a");
          assert.equal("BRIDGET_T3_MCP_AUTHORIZATION" in f.input.environment, false);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect("rotates the proof for a second session and never leaks the first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        const global = {
          ...f.official,
          env: {
            ...f.official.env,
            BRIDGET_T3_MCP_ENDPOINT: "http://127.0.0.1:1/stale",
            BRIDGET_T3_MCP_AUTHORIZATION: "Bearer stale",
          },
        };
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: global } }),
        );
        const sessionB = {
          ...f.input.session,
          providerSessionId: "provider-b",
          endpoint: "http://127.0.0.1:43124/mcp",
          authorizationHeader: "Bearer private-session-b",
        };
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "mounted");
        f.setStatuses([]);
        assert.equal((yield* prepareClaudeMcp({ ...f.input, session: sessionB })).code, "mounted");
        assert.equal(
          mountedServer(f, 0).env.BRIDGET_T3_MCP_AUTHORIZATION,
          "Bearer private-session-a",
        );
        assert.equal(
          mountedServer(f, 1).env.BRIDGET_T3_MCP_AUTHORIZATION,
          "Bearer private-session-b",
        );
        assert.equal(mountedServer(f, 1).env.BRIDGET_T3_MCP_ENDPOINT, "http://127.0.0.1:43124/mcp");
        assert.deepEqual(mountedServer(f, 1).env, canonicalEnv(f, sessionB));
        assert.notInclude(JSON.stringify(f.calls[1]), "private-session-a");
        assert.notInclude(JSON.stringify(f.calls[0]), "stale");
        const file = yield* f.fs.readFileString(f.path.join(f.home, ".claude.json"));
        assert.notInclude(file, "private-session");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect(
    "approves exactly the two read tools only after the refreshed catalogue is verified",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* officialFixture();
          yield* f.fs.writeFileString(
            f.path.join(f.home, ".claude.json"),
            JSON.stringify({ mcpServers: { bridget: f.official } }),
          );
          const settings = claudeBridgetReadOnlySettings({ permissions: { deny: ["Bash"] } })!;
          const applied: unknown[] = [];
          const query = {
            ...f.input.query,
            setMcpServers: async (servers: Record<string, McpServerConfig>) => {
              const result = await f.input.query.setMcpServers(servers);
              f.setStatuses([
                { name: "bridget", status: "connected", source: "dynamic", tools: fullCatalogue },
              ]);
              return result;
            },
            applyFlagSettings: async (value: unknown) => {
              applied.push(value);
            },
          };
          assert.equal(
            (yield* prepareClaudeMcp({ ...f.input, query, readOnlySettings: settings })).code,
            "mounted",
          );
          assert.deepEqual(applied, [settings]);
          assert.deepEqual(
            (settings.permissions?.allow ?? []).filter((rule) => rule.includes("bridget")),
            [...CLAUDE_BRIDGET_READ_ONLY_TOOLS],
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect.each([
    { name: "user", source: "user" },
    { name: "project", source: "project" },
    { name: "local", source: "local" },
    { name: "plugin", source: "plugin" },
    { name: "managed", source: "managed" },
    { name: "absent", source: undefined },
  ])(
    "is not ready when the catalogue comes from the $name source, not a dynamic mount",
    ({ source }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* officialFixture();
          yield* f.fs.writeFileString(
            f.path.join(f.home, ".claude.json"),
            JSON.stringify({ mcpServers: { bridget: f.official } }),
          );
          let applied = 0;
          const query = {
            ...f.input.query,
            // The SDK still reports the user's definition: connected, tools present, no proof.
            setMcpServers: async (servers: Record<string, McpServerConfig>) => {
              const result = await f.input.query.setMcpServers(servers);
              f.setStatuses([
                {
                  name: "bridget",
                  status: "connected",
                  ...(source === undefined ? {} : { source }),
                  config: f.official,
                  tools: fullCatalogue,
                },
              ]);
              return result;
            },
            applyFlagSettings: async () => void (applied += 1),
          };
          const failure = yield* prepareClaudeMcp({
            ...f.input,
            query,
            readOnlySettings: claudeBridgetReadOnlySettings(undefined),
          }).pipe(Effect.flip);
          assert.equal(failure.code, "catalogue_unavailable");
          assert.equal(applied, 0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect("is ready only when the mounted catalogue comes from the dynamic source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: f.official } }),
        );
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "mounted");
        assert.equal(f.calls.length, 1);
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
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: { ...f.official, env: extra } } }),
        );
        const outcome = yield* prepareClaudeMcp(f.input).pipe(Effect.result);
        // Refusal and canonical-only mount are both safe; carrying the variable is not.
        if (f.calls.length > 0) {
          assert.deepEqual(mountedServer(f).env, canonicalEnv(f));
          assert.notInclude(JSON.stringify(f.calls), Object.keys(extra)[0]!);
        } else {
          assert.notEqual(outcome._tag === "Success" ? outcome.success.code : "", "mounted");
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly expected: string;
    readonly build: (f: Official) => unknown;
  }> = [
    {
      name: "another binary",
      expected: "user_server",
      build: (f) => ({ ...f.official, command: f.other }),
    },
    {
      name: "symlink to another binary",
      expected: "user_server",
      build: (f) => ({ ...f.official, command: f.foreignLink }),
    },
    {
      name: "extra argument",
      expected: "user_server",
      build: (f) => ({ ...f.official, args: ["mcp", "-v"] }),
    },
    { name: "empty args", expected: "user_server", build: (f) => ({ ...f.official, args: [] }) },
    {
      name: "custom url",
      expected: "user_server",
      build: () => ({ type: "http", url: "http://private.invalid/mcp" }),
    },
    {
      name: "enabled false",
      expected: "disabled",
      build: (f) => ({ ...f.official, enabled: false }),
    },
    { name: "non-record", expected: "user_server", build: () => "bridget" },
    {
      name: "non-string env",
      expected: "user_server",
      build: (f) => ({ ...f.official, env: { A: 1 } }),
    },
    {
      name: "inherited identity",
      expected: "inherited_identity",
      build: (f) => ({ ...f.official, env: { BRIDGET_AGENT_ID_FILE: "/private/id" } }),
    },
    ...["HOME", "BRIDGET_HOME", "BRIDGET_SOCKET", "T3CODE_HOME"].map((key) => ({
      name: `foreign ${key}`,
      expected: "namespace_unavailable",
      build: (f: Official) => ({ ...f.official, env: { [key]: "/foreign" } }),
    })),
    {
      name: "missing executable",
      expected: "executable_unavailable",
      build: (f) => ({ ...f.official, command: `${f.home}/missing/bridget` }),
    },
  ];
  it.effect.each(refusals)(
    "refuses a profile definition and mounts nothing: $name",
    ({ build, expected }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* officialFixture();
          const profile = f.path.join(f.home, ".claude.json");
          yield* f.fs.writeFileString(
            profile,
            JSON.stringify({ mcpServers: { bridget: build(f) } }),
          );
          const before = yield* f.fs.readFileString(profile);
          let applied = 0;
          const result = yield* prepareClaudeMcp({
            ...f.input,
            readOnlySettings: claudeBridgetReadOnlySettings(undefined),
            query: { ...f.input.query, applyFlagSettings: async () => void (applied += 1) },
          });
          assert.equal(result.code, expected);
          assert.equal(f.calls.length, 0);
          assert.equal(applied, 0);
          assert.equal(yield* f.fs.readFileString(profile), before);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect("refuses when ANY declaration is foreign, even if another is official", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: f.official } }),
        );
        f.setStatuses([
          {
            name: "bridget",
            status: "connected",
            scope: "project",
            config: { ...f.official, command: f.other },
            tools: [],
          },
        ]);
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "user_server");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect.each(["disabledMcpServers", "disabledMcpjsonServers"])(
    "keeps the user's %s opt-out over an official definition",
    (key) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* officialFixture();
          yield* f.fs.writeFileString(
            f.path.join(f.home, ".claude.json"),
            JSON.stringify({ mcpServers: { bridget: f.official }, [key]: ["bridget"] }),
          );
          assert.equal((yield* prepareClaudeMcp(f.input)).code, "disabled");
          assert.equal(f.calls.length, 0);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
  it.effect("keeps a disabled SDK status over an official definition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: f.official } }),
        );
        f.setStatuses([{ name: "bridget", status: "disabled", scope: "user", config: f.official }]);
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "disabled");
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("still refuses explicit config, inherited process identity and revoked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: f.official } }),
        );
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, extraArgs: { "mcp-config": "x" } })).code,
          "explicit_config",
        );
        assert.equal(
          (yield* prepareClaudeMcp({
            ...f.input,
            environment: { ...f.input.environment, BRIDGET_AGENT_INSTANCE_ID: "agent" },
          })).code,
          "inherited_identity",
        );
        assert.equal(
          (yield* prepareClaudeMcp({ ...f.input, session: undefined })).code,
          "identity_unavailable",
        );
        assert.equal(f.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("fails closed when the refreshed server never exposes the catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* officialFixture();
        yield* f.fs.writeFileString(
          f.path.join(f.home, ".claude.json"),
          JSON.stringify({ mcpServers: { bridget: f.official } }),
        );
        const failure = yield* prepareClaudeMcp({
          ...f.input,
          query: {
            ...f.input.query,
            setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
            mcpServerStatus: async () => [],
          },
        }).pipe(Effect.flip);
        assert.equal(failure.code, "catalogue_unavailable");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
