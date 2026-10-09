import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpServerConfig, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { prepareClaudeMcp } from "./ClaudeMcp.ts";

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
  it.effect("mounts stdio with namespace only and preserves t3-code", () =>
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
          },
        });
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
