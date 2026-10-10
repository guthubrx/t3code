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
      statuses = [{ name: "bridget", status: "connected", tools: [{ name: "bridget_thread" }] }];
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
        assert.equal((yield* prepareClaudeMcp(f.input)).code, "user_server");
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
