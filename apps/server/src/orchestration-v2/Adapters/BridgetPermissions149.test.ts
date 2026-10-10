import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../../config.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "../../provider/CodexDeveloperInstructions.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

// Spec 149 (permissions lineage). The Claude runner captures a bounded launch
// context (CLI digests, config sources) and only represents the provider
// permission inputs when the whole permission surface is one the registry can
// reason about. Everything here exercises the real query runner with the SDK
// `query` call mocked; the fixture writes real files under a temp home.

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
}));

const PINNED_LAUNCHER_DIGEST =
  "sha256:dd8dee5677e46fde677f6ba940cbc07294f50ff690a76878c1883b6805872a8e";
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const sha256 = (bytes: Uint8Array) =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    Effect.map(crypto.digest("SHA-256", bytes), (digest) => `sha256:${toHex(digest)}`),
  );
const encode = (text: string) => new TextEncoder().encode(text);

let nextFixture = 0;

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const index = ++nextFixture;
  const home = yield* fs.makeTempDirectoryScoped({
    prefix: `t3-perm-149-${index}-`,
    directory: "/private/tmp",
  });
  const binDir = `${home}/bin`;
  yield* fs.makeDirectory(binDir, { recursive: true });
  const launcherPath = `${binDir}/claude-launcher`;
  const cliPath = `${binDir}/claude`;
  // The pinned audited launcher must stay the real ~/.local/bin/gclaude bytes:
  // the digest is the pin the production code enforces and this suite re-reads
  // the launcher at test time, so a changed CLI fails loudly instead of a stale
  // fixture still passing.
  const launcherBytes = yield* fs.readFile("/Users/moi/.local/bin/gclaude");
  yield* fs.writeFile(launcherPath, launcherBytes);
  yield* fs.chmod(launcherPath, 0o755);
  const cliBytes = encode("t3 test claude cli bytes (never a shell script)");
  yield* fs.writeFile(cliPath, cliBytes);
  yield* fs.chmod(cliPath, 0o755);
  const configDir = `${home}/claude-config`;
  yield* fs.makeDirectory(configDir, { recursive: true });
  const projectDir = `${home}/project`;
  yield* fs.makeDirectory(projectDir, { recursive: true });
  const environment: Record<string, string> = {
    HOME: home,
    PATH: `${binDir}:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: configDir,
    T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
    BRIDGET_HOME: home,
    BRIDGET_SOCKET: `${home}/bridget.sock`,
  };
  const threadId = ThreadId.make(`thread-perm-149-${index}`);
  const credential = {
    environmentId: EnvironmentId.make("environment:bridget"),
    threadId,
    providerSessionId: "credential-session-149",
    providerInstanceId: ProviderInstanceId.make("claude"),
    endpoint: "http://127.0.0.1:9/private-endpoint",
    authorizationHeader: "Bearer private-proof-149",
    browserToolsAvailable: false,
  };
  McpProviderSession.setMcpProviderSession(credential);
  const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.pipe(
    Effect.provide(
      ClaudeAdapterV2.layerQueryRunner.pipe(
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
  const close = vi.fn();
  const setMcpServers = vi.fn().mockResolvedValue({ errors: {} });
  const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
  const status = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
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
  sdk.query
    .mockReset()
    .mockReturnValue({ close, setMcpServers, applyFlagSettings, mcpServerStatus: status });
  const open = (overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    runner.open({
      threadId,
      providerSessionId: ProviderSessionId.make("runtime-session-149"),
      bridgetCredential: credential,
      options: {
        model: "test-model",
        tools: [],
        permissionMode: "default",
        sessionId: `native-perm-149-${index}`,
        cwd: projectDir,
        env: { ...environment, ...env },
        pathToClaudeCodeExecutable: launcherPath,
        canUseTool: vi.fn(),
        mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } },
        ...overrides,
      } as Parameters<typeof runner.open>[0]["options"],
    });
  return {
    home,
    binDir,
    launcherPath,
    cliPath,
    launcherBytes,
    cliBytes,
    configDir,
    projectDir,
    cleanup: Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    open,
  };
});

// SDK session settings (not the ClaudeSettings instance schema): the runner
// records them through claudeSanitarySettings, which only represents a closed
// set of keys and preserves every permission field.
const sessionSettings = { permissions: { allow: ["Read"], deny: ["Write"] } };

// Each test runs the fixture against the real filesystem inside one scope.
const withFixture = <E, R>(
  body: (f: Effect.Success<typeof makeFixture>) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const f = yield* makeFixture;
    yield* body(f).pipe(Effect.ensuring(f.cleanup));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Claude launch context capture (spec 149)", () => {
  it.effect("captures fresh CLI digests through the pinned launcher with PATH priority", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const session = yield* f.open();
        const inputs = session.bridgetPermissionInputs;
        assert.isDefined(inputs);
        if (inputs === undefined) return;
        const context = inputs.policy.launch_context;
        assert.isDefined(context);
        if (context === undefined) return;
        // The recorded digests are computed from the bytes actually on disk, and
        // the pinned launcher resolves the real CLI by PATH priority.
        assert.equal(context.cli_path, f.launcherPath);
        assert.equal(context.cli_revision, yield* sha256(f.launcherBytes));
        assert.equal(context.cli_revision, PINNED_LAUNCHER_DIGEST);
        assert.equal(context.resolved_cli_path, f.cliPath);
        assert.equal(context.resolved_cli_revision, yield* sha256(f.cliBytes));
        assert.equal(context.config_dir, f.configDir);
        assert.equal(context.settings_sources, "provider_default");
        const source = (path: string) =>
          context.permission_sources.find((entry) => entry.path === path);
        assert.deepEqual(source(`${f.configDir}/settings.json`), {
          kind: "user",
          path: `${f.configDir}/settings.json`,
          revision: "absent",
        });
        assert.deepEqual(source("/Library/Managed Preferences/com.anthropic.claudecode.plist"), {
          kind: "managed",
          path: "/Library/Managed Preferences/com.anthropic.claudecode.plist",
          revision: "absent",
        });
        assert.deepEqual(source(`${f.home}/Library/Preferences/com.anthropic.claudecode.plist`), {
          kind: "managed",
          path: `${f.home}/Library/Preferences/com.anthropic.claudecode.plist`,
          revision: "absent",
        });
        assert.deepEqual(source(`${f.projectDir}/.claude/settings.json`), {
          kind: "project",
          path: `${f.projectDir}/.claude/settings.json`,
          revision: "absent",
        });
        assert.deepEqual(source(`${f.projectDir}/.claude/settings.local.json`), {
          kind: "local",
          path: `${f.projectDir}/.claude/settings.local.json`,
          revision: "absent",
        });
      }),
    ),
  );

  it.effect("sends the final permission settings with the bridget read-only tools appended", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const session = yield* f.open({ settings: sessionSettings });
        const inputs = session.bridgetPermissionInputs;
        assert.isDefined(inputs);
        if (inputs === undefined) return;
        assert.deepEqual(inputs.policy.permission_callback, {
          kind: "t3_runtime",
          tool_approval: "prompt",
          plan_exit: "deny",
        });
        const overrides = inputs.policy.launch_context?.settings_overrides;
        assert.isDefined(overrides);
        if (overrides === undefined) return;
        // The user allow list survives, deny/ask fields are preserved, and the
        // two read-only bridget tools are appended by the mount preparation, so
        // the recorded settings are the final ones the CLI runs with.
        assert.deepEqual(overrides.permissions, {
          allow: [
            "Read",
            "mcp__bridget__bridget_capabilities",
            "mcp__bridget__bridget_task_status",
          ],
          deny: ["Write"],
        });
      }),
    ),
  );

  it.effect("invalidates the attestation when a settings source changes after capture", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settingsPath = `${f.configDir}/settings.json`;
        const original = '{"permissions":{"allow":["OrigA"]}}';
        yield* fs.writeFileString(settingsPath, original);
        const session = yield* f.open();
        const verify = session.bridgetPermissionInputs?.verify;
        assert.isDefined(verify);
        if (verify === undefined) return;
        assert.equal(yield* Effect.promise(verify), true);
        yield* fs.writeFileString(settingsPath, '{"permissions":{"allow":["OrigA","OrigB"]}}');
        assert.equal(yield* Effect.promise(verify), false);
        yield* fs.remove(settingsPath);
        assert.equal(yield* Effect.promise(verify), false);
        yield* fs.writeFileString(settingsPath, original);
        assert.equal(yield* Effect.promise(verify), true);
      }),
    ),
  );

  it.effect("invalidates the attestation when the launcher or CLI target changes", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const session = yield* f.open();
        const verify = session.bridgetPermissionInputs?.verify;
        assert.isDefined(verify);
        if (verify === undefined) return;
        assert.equal(yield* Effect.promise(verify), true);
        // Mutating the pinned launcher changes its digest.
        yield* fs.writeFile(f.launcherPath, encode('exec other-claude "$@"\n'));
        assert.equal(yield* Effect.promise(verify), false);
        // Deleting the launcher makes the recorded source unreachable.
        yield* fs.writeFile(f.launcherPath, f.launcherBytes);
        yield* fs.chmod(f.launcherPath, 0o755);
        yield* fs.remove(f.launcherPath);
        assert.equal(yield* Effect.promise(verify), false);
        // Replacing the resolved CLI with a shell script refuses outright.
        yield* fs.writeFile(f.launcherPath, f.launcherBytes);
        yield* fs.chmod(f.launcherPath, 0o755);
        yield* fs.writeFileString(f.cliPath, "#!/bin/sh\necho hacked\n");
        assert.equal(yield* Effect.promise(verify), false);
      }),
    ),
  );

  it.effect("accepts an audited plugin and refuses a plugin manifest with hooks", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pluginRoot = `${f.configDir}/plugins/cache/good-plugin`;
        yield* fs.makeDirectory(`${pluginRoot}/.claude-plugin`, { recursive: true });
        yield* fs.writeFileString(
          `${f.configDir}/settings.json`,
          '{"enabledPlugins":{"good-plugin":true}}',
        );
        yield* fs.writeFileString(
          `${f.configDir}/plugins/installed_plugins.json`,
          JSON.stringify({
            plugins: { "good-plugin": [{ scope: "user", installPath: pluginRoot }] },
          }),
        );
        const manifestPath = `${pluginRoot}/.claude-plugin/plugin.json`;
        const manifestBody = '{"name":"good-plugin"}';
        yield* fs.writeFileString(manifestPath, manifestBody);
        const clean = yield* f.open();
        const context = clean.bridgetPermissionInputs?.policy.launch_context;
        assert.isDefined(context);
        if (context === undefined) return;
        assert.deepEqual(
          context.permission_sources.find((entry) => entry.path === manifestPath),
          {
            kind: "user",
            path: manifestPath,
            revision: yield* sha256(encode(manifestBody)),
          },
        );
        for (const relative of ["hooks/hooks.json", "settings.json", ".mcp.json"]) {
          assert.deepEqual(
            context.permission_sources.find((entry) => entry.path === `${pluginRoot}/${relative}`),
            {
              kind: "user",
              path: `${pluginRoot}/${relative}`,
              revision: "absent",
            },
          );
        }
        // A manifest that carries executable permission hooks is opaque: the
        // context disappears but the attested policy itself stays behind.
        yield* fs.writeFileString(manifestPath, '{"hooks":{"PostToolUse":{}}}');
        const opaque = yield* f.open();
        const opaqueInputs = opaque.bridgetPermissionInputs;
        assert.isDefined(opaqueInputs);
        if (opaqueInputs === undefined) return;
        assert.isUndefined(opaqueInputs.policy.launch_context);
      }),
    ),
  );

  it.effect("does not represent unsanitary settings objects", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const hooksSettings = yield* f.open({ settings: { hooks: {} } });
        assert.isUndefined(hooksSettings.bridgetPermissionInputs);
        const helperSettings = yield* f.open({ settings: { permissions: { policyHelper: {} } } });
        assert.isUndefined(helperSettings.bridgetPermissionInputs);
      }),
    ),
  );

  it.effect("does not represent an unrepresented permission surface", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const noCallback = yield* f.open({ canUseTool: undefined });
        assert.isUndefined(noCallback.bridgetPermissionInputs);
        const sandboxed = yield* f.open({ sandbox: {} });
        assert.isUndefined(sandboxed.bridgetPermissionInputs);
        const managed = yield* f.open({ managedSettings: {} });
        assert.isUndefined(managed.bridgetPermissionInputs);
        const hooksOption = yield* f.open({ hooks: {} });
        assert.isUndefined(hooksOption.bridgetPermissionInputs);
        const sandboxFlag = yield* f.open({ extraArgs: { sandbox: "1" } });
        assert.isUndefined(sandboxFlag.bridgetPermissionInputs);
        const promptTool = yield* f.open({ permissionPromptToolName: "ask" });
        assert.isUndefined(promptTool.bridgetPermissionInputs);
        const promptMode = yield* f.open({ permissionPrompts: "none" });
        assert.isUndefined(promptMode.bridgetPermissionInputs);
        const spawnOverride = yield* f.open({ spawnClaudeCodeProcess: vi.fn() });
        assert.isUndefined(spawnOverride.bridgetPermissionInputs);
      }),
    ),
  );

  it.effect("refuses settings keys outside the represented allowlist", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const mcpServers = yield* f.open({
          settings: { ...sessionSettings, allowedMcpServers: {} },
        });
        assert.isUndefined(mcpServers.bridgetPermissionInputs);
        const allProject = yield* f.open({
          settings: { ...sessionSettings, enableAllProjectMcpServers: true },
        });
        assert.isUndefined(allProject.bridgetPermissionInputs);
        const wrapper = yield* f.open({ settings: { ...sessionSettings, processWrapper: {} } });
        assert.isUndefined(wrapper.bridgetPermissionInputs);
      }),
    ),
  );

  it.effect("still represents settings limited to the represented keys", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        // A non-permission key from the represented set does not trip the
        // refusal: only keys outside the closed list are unsanitary.
        const session = yield* f.open({
          settings: { ...sessionSettings, alwaysThinkingEnabled: true },
        });
        const inputs = session.bridgetPermissionInputs;
        assert.isDefined(inputs);
        if (inputs === undefined) return;
        assert.isDefined(inputs.policy.launch_context);
        const overrides = inputs.policy.launch_context?.settings_overrides;
        assert.isDefined(overrides);
        assert.deepEqual(overrides?.permissions, {
          allow: [
            "Read",
            "mcp__bridget__bridget_capabilities",
            "mcp__bridget__bridget_task_status",
          ],
          deny: ["Write"],
        });
      }),
    ),
  );

  it.effect("omits the launch context when the environment is not attestable", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const shellEnv = yield* f.open({}, { BASH_ENV: "/tmp/x" });
        assert.isDefined(shellEnv.bridgetPermissionInputs);
        assert.isUndefined(shellEnv.bridgetPermissionInputs?.policy.launch_context);
        const claudeEnv = yield* f.open({}, { CLAUDE_CODE_UNLISTED: "1" });
        assert.isUndefined(claudeEnv.bridgetPermissionInputs?.policy.launch_context);
        const relativePath = yield* f.open({}, { PATH: "bin:/usr/bin:/bin" });
        assert.isUndefined(relativePath.bridgetPermissionInputs?.policy.launch_context);
      }),
    ),
  );

  it.effect("refuses the whole capture when the user MDM plist exists", () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${f.home}/Library/Preferences`, { recursive: true });
        yield* fs.writeFileString(
          `${f.home}/Library/Preferences/com.anthropic.claudecode.plist`,
          "<plist/>",
        );
        const session = yield* f.open();
        assert.isUndefined(session.bridgetPermissionInputs?.policy.launch_context);
      }),
    ),
  );
});

// Part B: the adapter publishes the attested policy of the live turn into the
// private registry, follows the CLI's own permission-mode transitions, and
// retires the fact when the turn ends. The query runner is a fake session that
// exposes the captured inputs from part A; everything else is the real adapter.

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [],
};
const RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const makeTurnInput = (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attemptId: RunAttemptId;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Bridget permissions test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId: input.threadId,
  runId: RunId.make(`run-${input.attemptId}`),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: input.attemptId,
  rootNodeId: NodeId.make(`node-${input.attemptId}`),
  providerThread: input.providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${input.attemptId}`),
    text: "hello",
    attachments: [],
  },
  modelSelection: MODEL_SELECTION,
  runtimePolicy: RUNTIME_POLICY,
});

const makePermissionHarness = (credentialOverrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(
      `thread-perm-149-${credentialOverrides.providerInstanceId === "codex" ? "codex" : "claude"}`,
    );
    const queue = yield* Queue.unbounded<Record<string, unknown>>();
    const credential = {
      environmentId: EnvironmentId.make("environment:bridget"),
      threadId,
      providerSessionId: "credential-session-149",
      providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      endpoint: "http://127.0.0.1:9/private-endpoint",
      authorizationHeader: "Bearer private-proof-149",
      browserToolsAvailable: false,
      ...credentialOverrides,
    };
    McpProviderSession.setMcpProviderSession(credential);
    const permissionInputs = {
      cwd: "/workspace-attested",
      policy: {
        kind: "claude" as const,
        permission_mode: "default" as const,
        tools: [] as Array<string>,
        settings_sources: "provider_default" as const,
        permission_callback: {
          kind: "t3_runtime" as const,
          tool_approval: "prompt" as const,
          plan_exit: "deny" as const,
        },
      },
      verify: async () => true,
    };
    const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
      {
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath: "/usr/bin/true" },
      },
      {},
    ).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-perm-149-b-" })),
      Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
        allocateSessionId: Effect.succeed("native-perm-149-b"),
        open: () =>
          Effect.sync(() => ({
            messages: Stream.fromQueue(
              queue,
            ) as unknown as ClaudeAdapterV2.ClaudeAgentSdkQuerySession["messages"],
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
            bridgetCredential: credential,
            bridgetPermissionInputs: permissionInputs,
          })),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      }),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-149-runtime"),
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const attemptId = RunAttemptId.make("attempt-149");
    const turnInput = makeTurnInput({ threadId, providerThread, attemptId, now });
    const binding = { attemptId, providerThreadId: providerThread.id };
    const read = () =>
      Effect.promise(() =>
        McpProviderSession.readMcpProviderPermissions(credential, turnInput.runId, binding),
      );
    const waitFor = (
      predicate: (
        read: Awaited<ReturnType<typeof McpProviderSession.readMcpProviderPermissions>>,
      ) => boolean,
      label: string,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 300; attempt++) {
          const current = yield* read();
          if (predicate(current)) return current;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die(new Error(`permission fact did not reach ${label}`));
      });
    return {
      queue,
      credential,
      threadId,
      turnInput,
      binding,
      read,
      waitFor,
      runtime,
      cleanup: Effect.sync(() => {
        McpProviderSession.clearMcpProviderSession(threadId);
      }),
    };
  });

describe("Claude adapter permission publication (spec 149)", () => {
  // Live clock: the pump and the registry run on real promises, so the
  // polling waits need real time, not the it.effect TestClock.
  it.live("publishes on turn start, follows init and status modes and retires at turn end", () =>
    Effect.gen(function* () {
      const h = yield* makePermissionHarness();
      yield* Effect.gen(function* () {
        yield* h.runtime.startTurn(h.turnInput);
        // Revision 1 is published synchronously by startTurn with the mode
        // the query was opened with, and the attested cwd (not the runtime
        // policy cwd) plus the credential's own session id.
        const first = yield* h.waitFor((current) => current.status === "valid", "revision 1");
        if (first.status !== "valid") return;
        assert.equal(first.permissions.revision, 1);
        assert.equal(first.permissions.provider_session_id, "credential-session-149");
        assert.notEqual(first.permissions.provider_session_id, "provider-session-149-runtime");
        assert.equal(first.permissions.driver, "claude_stream_json");
        assert.equal(first.permissions.cwd, "/workspace-attested");
        assert.equal(first.permissions.runtime_mode, "full-access");
        assert.deepEqual(first.permissions.provider_policy, {
          kind: "claude",
          permission_mode: "bypassPermissions",
          tools: [],
          settings_sources: "provider_default",
          permission_callback: { kind: "t3_runtime", tool_approval: "allow", plan_exit: "deny" },
        });
        // The CLI's own init message moves the represented mode.
        yield* Queue.offer(h.queue, {
          type: "system",
          subtype: "init",
          session_id: "native-perm-149-b",
          model: "claude-sonnet-4-6",
          cwd: "/workspace",
          tools: [],
          mcp_servers: [],
          slash_commands: [],
          agents: [],
          skills: [],
          plugins: [],
          permissionMode: "acceptEdits",
        });
        const second = yield* h.waitFor(
          (current) => current.status === "valid" && current.permissions.revision >= 2,
          "revision 2",
        );
        if (second.status === "valid") {
          assert.equal(second.permissions.revision, 2);
          assert.deepEqual(second.permissions.provider_policy, {
            kind: "claude",
            permission_mode: "acceptEdits",
            tools: [],
            settings_sources: "provider_default",
            permission_callback: { kind: "t3_runtime", tool_approval: "allow", plan_exit: "deny" },
          });
        }
        // A status change moves it again without ending the turn.
        yield* Queue.offer(h.queue, {
          type: "system",
          subtype: "status",
          session_id: "native-perm-149-b",
          permissionMode: "plan",
        });
        const third = yield* h.waitFor(
          (current) => current.status === "valid" && current.permissions.revision >= 3,
          "revision 3",
        );
        if (third.status === "valid") {
          assert.equal(third.permissions.revision, 3);
          assert.deepEqual(third.permissions.provider_policy, {
            kind: "claude",
            permission_mode: "plan",
            tools: [],
            settings_sources: "provider_default",
            permission_callback: { kind: "t3_runtime", tool_approval: "allow", plan_exit: "deny" },
          });
        }
        // Ending the query stream finalizes the turn: the fact is retired
        // into a tombstone and never falls back to a stale valid fact.
        yield* Queue.shutdown(h.queue);
        yield* h.waitFor((current) => current.status === "unavailable", "tombstone");
        const after = yield* h.read();
        assert.deepEqual(after, { status: "unavailable" });
      }).pipe(Effect.ensuring(h.cleanup));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.live("publishes nothing for a credential mounted from another provider instance", () =>
    Effect.gen(function* () {
      const h = yield* makePermissionHarness({ providerInstanceId: "codex" });
      yield* Effect.gen(function* () {
        yield* h.runtime.startTurn(h.turnInput);
        // The instance gate refuses: the refusal itself leaves a tombstone
        // for this run (invalidate without a fact records revision 0), so
        // the refused run can never become attestable afterwards.
        yield* Effect.sleep("200 millis");
        const after = yield* h.read();
        assert.deepEqual(after, { status: "unavailable" });
      }).pipe(Effect.ensuring(h.cleanup));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});

// Part C: the Codex adapter publishes the final turn/start wire parameters
// through the real replay app-server, for the credential mounted before the
// session opened. The replay transcript replays a standard handoff; the point
// is that the fact mirrors what the adapter sent, not the session defaults
// the app-server reported back on thread/start.

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make(CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID),
  model: "gpt-5.4",
};
const CODEX_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const makeCodexTurnInput = (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attemptId: RunAttemptId;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Bridget permissions test",
    providerInstanceId: ProviderInstanceId.make(CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID),
    modelSelection: CODEX_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId: input.threadId,
  runId: RunId.make(`run-${input.attemptId}`),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: input.attemptId,
  rootNodeId: NodeId.make(`node-${input.attemptId}`),
  providerThread: input.providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${input.attemptId}`),
    text: "hello",
    attachments: [],
  },
  modelSelection: CODEX_MODEL_SELECTION,
  runtimePolicy: CODEX_RUNTIME_POLICY,
});

const codexReplayPreamble = (input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> => [
  {
    type: "expect_outbound",
    label: "initialize",
    frame: {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "T3 Code", title: "T3 Code", version: "test" },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["turn/diff/updated"],
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "initialize",
    frame: {
      id: 1,
      result: {
        userAgent: "T3 Code/test",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    },
  },
  { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
  // The mounted credential makes threadRuntimeParams ask CodexMcp to inspect
  // the effective project config before it builds the thread.
  {
    type: "expect_outbound",
    label: "config/read",
    frame: { id: 2, method: "config/read", params: { cwd: "/workspace", includeLayers: false } },
  },
  {
    type: "emit_inbound",
    label: "config/read",
    frame: { id: 2, result: { config: { mcp_servers: {} }, origins: {} } },
  },
  {
    type: "expect_outbound",
    label: "thread/start",
    frame: {
      id: 3,
      method: "thread/start",
      params: {
        config: {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          // A mounted credential always carries its private t3-code mount
          // (CodexAdapterV2 thread params); the stdio bridget server stays
          // absent because this fixture's environment has no BRIDGET_HOME.
          "mcp_servers.t3-code": {
            url: "http://127.0.0.1:9/private-endpoint",
            http_headers: { Authorization: "Bearer private-proof-149" },
          },
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "thread/start",
    frame: {
      id: 3,
      result: {
        thread: {
          id: input.nativeThreadId,
          sessionId: input.nativeThreadId,
          forkedFromId: null,
          preview: "",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 1782622440,
          updatedAt: 1782622440,
          status: { type: "idle" },
          path: `/tmp/${input.nativeThreadId}.jsonl`,
          cwd: "/workspace",
          cliVersion: "0.144.0",
          source: "vscode",
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/workspace",
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        reasoningEffort: "medium",
      },
    },
  },
  {
    type: "expect_outbound",
    label: "turn/start",
    frame: {
      id: 4,
      method: "turn/start",
      params: {
        threadId: input.nativeThreadId,
        input: [{ type: "text", text: input.prompt }],
        cwd: "/workspace",
        model: "gpt-5.4",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        summary: "detailed",
        // The private t3-code mount makes the turn carry T3 context: the
        // session's browserToolsAvailable:false keeps t3_code_tools out.
        additionalContext: buildCodexAdditionalContext(
          { model: "gpt-5.4", reasoningEffort: "medium" },
          { browser: false, device: false },
        ),
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.4",
            reasoning_effort: "medium",
            developer_instructions: buildCodexDeveloperInstructions("default"),
          },
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "turn/start",
    frame: {
      id: 4,
      result: {
        turn: {
          id: input.nativeTurnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1782622440,
          completedAt: null,
          durationMs: null,
        },
      },
    },
  },
  {
    type: "emit_inbound",
    label: "turn/started",
    frame: {
      method: "turn/started",
      params: {
        threadId: input.nativeThreadId,
        turn: {
          id: input.nativeTurnId,
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1782622440,
          completedAt: null,
          durationMs: null,
        },
      },
    },
  },
];

const makeCodexReplayTranscript = (input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.144.0",
  scenario: input.scenario,
  entries: input.entries,
});

describe("Codex adapter permission publication (spec 149)", () => {
  it.effect("publishes the final turn/start parameters for the mounted credential", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-perm-149-codex");
      const credential = {
        environmentId: EnvironmentId.make("environment:bridget"),
        threadId,
        providerSessionId: "credential-session-149",
        providerInstanceId: ProviderInstanceId.make(CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID),
        endpoint: "http://127.0.0.1:9/private-endpoint",
        authorizationHeader: "Bearer private-proof-149",
        browserToolsAvailable: false,
      };
      // The mount exists before the session opens. The runtime keeps its own
      // provider session id and never replaces the mounted credential object.
      McpProviderSession.setMcpProviderSession(credential);
      yield* Effect.gen(function* () {
        const nativeThreadId = "native-perm-149-codex";
        const transcript = makeCodexReplayTranscript({
          scenario: "perm-149-codex",
          entries: codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "native-turn-149",
            prompt: "hello",
          }),
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
        const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplay(transcript)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(
                  Effect.map((client) => withCodexReplayChildMetadata(client, transcript)),
                  Effect.provide(context),
                ),
              ),
            ),
        };
        const adapter = CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CODEX_SETTINGS,
          environment: {},
          clientFactory,
          crypto: yield* Crypto.Crypto,
          fileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig,
          continuationRequests: { offer: () => Effect.void },
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-149-codex"),
          modelSelection: CODEX_MODEL_SELECTION,
          runtimePolicy: CODEX_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CODEX_MODEL_SELECTION,
          runtimePolicy: CODEX_RUNTIME_POLICY,
        });
        const attemptId = RunAttemptId.make("attempt-149");
        const turnInput = makeCodexTurnInput({ threadId, providerThread, attemptId, now });
        yield* runtime.startTurn(turnInput);
        const read = yield* Effect.promise(() =>
          McpProviderSession.readMcpProviderPermissions(credential, turnInput.runId, {
            attemptId,
            providerThreadId: providerThread.id,
          }),
        );
        // The fact carries the FINAL turn/start wire parameters (never / user
        // / dangerFullAccess), not the thread/start session defaults the
        // app-server reported (on-request / user / workspaceWrite), and the
        // credential's own session id, not the runtime's.
        assert.equal(read.status, "valid");
        if (read.status !== "valid") return;
        assert.deepEqual(read.permissions, {
          version: 1,
          source: "provider_turn",
          run_id: "run-attempt-149",
          provider_session_id: "credential-session-149",
          provider_instance_id: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          revision: 1,
          driver: "codex_app_server",
          cwd: "/workspace",
          runtime_mode: "full-access",
          interaction_mode: "default",
          provider_policy: {
            kind: "codex",
            approval_policy: "never",
            approvals_reviewer: "user",
            sandbox_policy: { type: "dangerFullAccess" },
          },
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});

// Gap G3 (spec 149, T006). The positive publication above shows that the
// fact mirrors the final turn/start parameters. The tests below prove the
// other half of T006: the fact is retired when the real Codex app-server
// path fails, when the turn ends and when the session closes, and a retire
// owned by one run never removes the fact of another run or thread. A
// retired fact reads as `unavailable` (tombstone), never as `absent` (which
// would let a caller fall back to the identity-only v1 attestation) and never
// as `valid`.

const codexReplayTurn = (
  id: string,
  status: "inProgress" | "completed" | "interrupted" | "failed",
) => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "inProgress" ? null : 1782622441,
  durationMs: null,
});

const codexTurnCompleted = (input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly status: "completed" | "interrupted" | "failed";
  readonly afterMs?: number;
}): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: "turn/completed",
  ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
  frame: {
    method: "turn/completed",
    params: {
      threadId: input.nativeThreadId,
      turn: codexReplayTurn(input.nativeTurnId, input.status),
    },
  },
});

/** Replay entries up to and including the outbound turn/start request. */
const codexReplayUntilTurnStart = (
  preamble: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
) => {
  const index = preamble.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
  );
  assert.isAbove(index, 0, "the replay preamble must contain the turn/start expectation");
  return preamble.slice(0, index + 1);
};

const openCodexPermissionSession = (input: {
  readonly suffix: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
  readonly credentialInstanceId?: string;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread-perm-149-g3-${input.suffix}`);
    const credential = {
      environmentId: EnvironmentId.make("environment:bridget"),
      threadId,
      providerSessionId: `credential-session-149-g3-${input.suffix}`,
      providerInstanceId: ProviderInstanceId.make(
        input.credentialInstanceId ?? CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      ),
      endpoint: "http://127.0.0.1:9/private-endpoint",
      authorizationHeader: "Bearer private-proof-149",
      browserToolsAvailable: false,
    };
    McpProviderSession.setMcpProviderSession(credential);
    const transcript = makeCodexReplayTranscript({
      scenario: `perm-149-g3-${input.suffix}`,
      entries: input.entries,
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplay(transcript)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) => withCodexReplayChildMetadata(client, transcript)),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
      continuationRequests: { offer: () => Effect.void },
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-149-g3-${input.suffix}`),
      modelSelection: CODEX_MODEL_SELECTION,
      runtimePolicy: CODEX_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_MODEL_SELECTION,
      runtimePolicy: CODEX_RUNTIME_POLICY,
    });
    const turn = (attempt: string) =>
      makeCodexTurnInput({ threadId, providerThread, attemptId: RunAttemptId.make(attempt), now });
    const read = (turnInput: ProviderAdapterV2TurnInput) =>
      Effect.promise(() =>
        McpProviderSession.readMcpProviderPermissions(credential, turnInput.runId, {
          attemptId: turnInput.attemptId,
          providerThreadId: providerThread.id,
        }),
      );
    const waitForStatus = (
      turnInput: ProviderAdapterV2TurnInput,
      status: "valid" | "unavailable" | "absent",
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 300; attempt++) {
          const current = yield* read(turnInput);
          if (current.status === status) return current;
          yield* Effect.sleep("20 millis");
        }
        return yield* Effect.die(new Error(`permission fact did not reach ${status}`));
      });
    return {
      threadId,
      credential,
      runtime,
      providerThread,
      turn,
      read,
      waitForStatus,
      cleanup: Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    };
  });

const codexG3Layer = Layer.merge(IdAllocator.layer, NodeServices.layer);

describe("Codex adapter permission retirement (spec 149, T006 gap G3)", () => {
  it.effect("retires the published fact when the app-server rejects turn/start", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-g3-fail";
      const h = yield* openCodexPermissionSession({
        suffix: "fail",
        entries: [
          ...codexReplayUntilTurnStart(
            codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "native-turn-g3-fail",
              prompt: "hello",
            }),
          ),
          {
            type: "emit_inbound",
            label: "turn/start",
            frame: { id: 4, error: { code: -32000, message: "turn start refused" } },
          },
        ],
      });
      yield* Effect.gen(function* () {
        const turnInput = h.turn("attempt-g3-fail");
        // Positive control: before the turn there is no fact at all.
        assert.deepEqual(yield* h.read(turnInput), { status: "absent" });
        const exit = yield* Effect.exit(h.runtime.startTurn(turnInput));
        assert.equal(exit._tag, "Failure");
        // The replay matched the outbound turn/start (the fact is published
        // just before that request), so a tombstone proves publish-then-retire
        // rather than a fact that never existed ("absent") or one that leaked.
        assert.deepEqual(yield* h.read(turnInput), { status: "unavailable" });
      }).pipe(Effect.ensuring(h.cleanup));
    }).pipe(Effect.scoped, Effect.provide(codexG3Layer)),
  );

  it.live.each(["completed", "interrupted", "failed"] as const)(
    "retires the fact when the native turn ends %s",
    (status) =>
      Effect.gen(function* () {
        const nativeThreadId = `native-g3-end-${status}`;
        const nativeTurnId = `native-turn-g3-end-${status}`;
        const h = yield* openCodexPermissionSession({
          suffix: `end-${status}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "hello" }),
            // Delayed so the valid fact can be observed before the turn ends.
            codexTurnCompleted({ nativeThreadId, nativeTurnId, status, afterMs: 400 }),
          ],
        });
        yield* Effect.gen(function* () {
          const turnInput = h.turn(`attempt-g3-end-${status}`);
          yield* h.runtime.startTurn(turnInput);
          const before = yield* h.read(turnInput);
          assert.equal(before.status, "valid");
          yield* h.waitForStatus(turnInput, "unavailable");
          // Settled and stable: it never falls back to valid or absent.
          yield* Effect.sleep("100 millis");
          assert.deepEqual(yield* h.read(turnInput), { status: "unavailable" });
        }).pipe(Effect.ensuring(h.cleanup));
      }).pipe(Effect.scoped, Effect.provide(codexG3Layer)),
  );

  it.effect("retires the fact when the adapter session scope closes", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-g3-scope";
      const opened = yield* Effect.gen(function* () {
        const h = yield* openCodexPermissionSession({
          suffix: "scope",
          entries: codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "native-turn-g3-scope",
            prompt: "hello",
          }),
        });
        const turnInput = h.turn("attempt-g3-scope");
        yield* h.runtime.startTurn(turnInput);
        assert.equal((yield* h.read(turnInput)).status, "valid");
        return { h, turnInput };
      }).pipe(Effect.scoped);
      yield* Effect.gen(function* () {
        // The session scope is closed; the running turn never ended natively.
        assert.deepEqual(yield* opened.h.read(opened.turnInput), { status: "unavailable" });
      }).pipe(Effect.ensuring(opened.h.cleanup));
    }).pipe(Effect.scoped, Effect.provide(codexG3Layer)),
  );

  it.live("keeps the fact of a newer run when an older run on the same thread ends", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-g3-stale";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "native-turn-g3-a",
        prompt: "hello",
      });
      const h = yield* openCodexPermissionSession({
        suffix: "stale",
        entries: [
          ...preamble,
          // Run B starts while run A is still in flight; run A then ends.
          {
            type: "expect_outbound",
            label: "turn/start (run B)",
            frame: {
              id: 5,
              method: "turn/start",
              params: (
                preamble.find(
                  (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
                ) as { readonly frame: { readonly params: unknown } }
              ).frame.params,
            },
          },
          {
            type: "emit_inbound",
            label: "turn/start (run B)",
            frame: { id: 5, result: { turn: codexReplayTurn("native-turn-g3-b", "inProgress") } },
          },
          {
            type: "emit_inbound",
            label: "turn/started (run B)",
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: codexReplayTurn("native-turn-g3-b", "inProgress"),
              },
            },
          },
          codexTurnCompleted({
            nativeThreadId,
            nativeTurnId: "native-turn-g3-a",
            status: "completed",
          }),
          codexTurnCompleted({
            nativeThreadId,
            nativeTurnId: "native-turn-g3-b",
            status: "completed",
            afterMs: 600,
          }),
        ],
      });
      yield* Effect.gen(function* () {
        const terminals: Array<string> = [];
        yield* h.runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "turn.terminal") terminals.push(event.type);
            }),
          ),
          Effect.forkScoped,
        );
        const turnA = h.turn("attempt-g3-a");
        const turnB = h.turn("attempt-g3-b");
        yield* h.runtime.startTurn(turnA);
        assert.equal((yield* h.read(turnA)).status, "valid");
        yield* h.runtime.startTurn(turnB);
        // Run A's native completion is finalized (turn.terminal emitted after
        // the retire call) while run B's fact is still current.
        for (let attempt = 0; attempt < 100 && terminals.length === 0; attempt++)
          yield* Effect.sleep("20 millis");
        assert.equal(terminals.length, 1, "run A must have been finalized");
        const readB = yield* h.read(turnB);
        assert.equal(readB.status, "valid");
        if (readB.status === "valid") {
          assert.equal(readB.permissions.run_id, "run-attempt-g3-b");
          assert.equal(readB.permissions.revision, 2);
        }
        // Run A is no longer readable under its own binding.
        assert.deepEqual(yield* h.read(turnA), { status: "unavailable" });
        // Run B's own completion finally retires it.
        yield* h.waitForStatus(turnB, "unavailable");
      }).pipe(Effect.ensuring(h.cleanup));
    }).pipe(Effect.scoped, Effect.provide(codexG3Layer)),
  );

  it.live("a failing turn on one thread leaves the fact of another bound thread valid", () =>
    Effect.gen(function* () {
      const okIds = { nativeThreadId: "native-g3-ok", nativeTurnId: "native-turn-g3-ok" };
      const failId = "native-g3-other";
      const ok = yield* openCodexPermissionSession({
        suffix: "ok",
        entries: codexReplayPreamble({ ...okIds, prompt: "hello" }),
      });
      const failing = yield* openCodexPermissionSession({
        suffix: "other",
        entries: [
          ...codexReplayUntilTurnStart(
            codexReplayPreamble({
              nativeThreadId: failId,
              nativeTurnId: "native-turn-g3-other",
              prompt: "hello",
            }),
          ),
          {
            type: "emit_inbound",
            label: "turn/start",
            frame: { id: 4, error: { code: -32000, message: "turn start refused" } },
          },
        ],
      });
      yield* Effect.gen(function* () {
        const okTurn = ok.turn("attempt-g3-ok");
        yield* ok.runtime.startTurn(okTurn);
        assert.equal((yield* ok.read(okTurn)).status, "valid");
        const failTurn = failing.turn("attempt-g3-other");
        assert.equal((yield* Effect.exit(failing.runtime.startTurn(failTurn)))._tag, "Failure");
        assert.deepEqual(yield* failing.read(failTurn), { status: "unavailable" });
        const stillOk = yield* ok.read(okTurn);
        assert.equal(stillOk.status, "valid");
        if (stillOk.status === "valid")
          assert.equal(stillOk.permissions.run_id, "run-attempt-g3-ok");
      }).pipe(Effect.ensuring(Effect.all([ok.cleanup, failing.cleanup])));
    }).pipe(Effect.scoped, Effect.provide(codexG3Layer)),
  );
});
