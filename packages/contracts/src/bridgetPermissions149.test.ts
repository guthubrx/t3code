import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  BridgetClaudeLaunchContext,
  BridgetClaudePermissionMode,
  BridgetClaudeProviderPolicy,
  BridgetClaudeSettingsOverrides,
  BridgetPermissions,
  BridgetSessionIdentity,
} from "./bridgetPermissions.ts";

// Spec 149 (permissions lineage). Wire contract: specs/149-sous-agents-lineage/contracts/permissions.md
// Every object is closed at decode time (onExcessProperty: "error" inside the declared codecs).
// Driver and kind form one correlated union: a codex envelope never carries a claude policy.

const maxSeq = Number.MAX_SAFE_INTEGER;
const sha = (hex: string) => `sha256:${hex}`;
const digest = sha("a".repeat(64));
const otherDigest = sha("b".repeat(64));
const exact = (chars: number, fill = "x") => fill.repeat(chars);

const codexPolicy = {
  kind: "codex",
  approval_policy: "never",
  approvals_reviewer: "user",
  sandbox_policy: { type: "dangerFullAccess" },
} as const;
const claudePolicy = {
  kind: "claude",
  permission_mode: "default",
  tools: ["Read"],
  permission_callback: { kind: "t3_runtime", tool_approval: "prompt", plan_exit: "deny" },
  settings_sources: "provider_default",
} as const;
const permissions = (driver: string, policy: unknown) => ({
  version: 1,
  source: "provider_turn",
  run_id: "run-1",
  provider_session_id: "session-1",
  provider_instance_id: "instance-1",
  revision: 1,
  driver,
  cwd: "/tmp/project",
  runtime_mode: "full-access",
  interaction_mode: "default",
  provider_policy: policy,
});
const codexEnvelope = permissions("codex_app_server", codexPolicy);
const claudeEnvelope = permissions("claude_stream_json", claudePolicy);

const decodePermissions = Schema.decodeUnknownSync(BridgetPermissions);
const decodeSession = Schema.decodeUnknownSync(BridgetSessionIdentity);
const decodeClaudePolicy = Schema.decodeUnknownSync(BridgetClaudeProviderPolicy);
const decodeLaunchContext = Schema.decodeUnknownSync(BridgetClaudeLaunchContext);
const decodeOverrides = Schema.decodeUnknownSync(BridgetClaudeSettingsOverrides);
const decodeClaudeMode = Schema.decodeUnknownSync(BridgetClaudePermissionMode);

const rejects = (decode: (value: unknown) => unknown, value: unknown) =>
  expect(() => decode(value)).toThrow();
const accepts = (decode: (value: unknown) => unknown, value: unknown) =>
  expect(() => decode(value)).not.toThrow();

describe("bridget session identity v1/v2", () => {
  const identity = {
    environmentId: "environment:bridget",
    threadId: "thread:1",
    providerSessionId: "session-1",
    providerInstanceId: "instance-1",
  };

  it("keeps the v1 identity-only envelope for historical reads", () => {
    const decoded = decodeSession({ version: 1, ...identity });
    expect(decoded).toEqual({ version: 1, ...identity });
  });

  it("decodes a valid v2 envelope and preserves the snake_case permission fact", () => {
    const decoded = decodeSession({ version: 2, ...identity, permissions: claudeEnvelope });
    expect(decoded).toMatchObject({ version: 2, ...identity });
    expect((decoded as { permissions: { driver: string } }).permissions.driver).toBe(
      "claude_stream_json",
    );
    expect((decoded as { permissions: { run_id: string } }).permissions.run_id).toBe("run-1");
  });

  it("refuses v2 without permissions and v1 carrying permissions", () => {
    rejects(decodeSession, { version: 2, ...identity });
    rejects(decodeSession, { version: 1, ...identity, permissions: claudeEnvelope });
  });

  it("refuses a v2 envelope whose identity disagrees with the fact (same UUID is not enough)", () => {
    rejects(decodeSession, {
      version: 2,
      ...identity,
      providerSessionId: "session-OTHER",
      permissions: claudeEnvelope,
    });
    rejects(decodeSession, {
      version: 2,
      ...identity,
      providerInstanceId: "instance-OTHER",
      permissions: codexEnvelope,
    });
  });

  it("refuses unknown versions and excess fields on both envelopes", () => {
    rejects(decodeSession, { version: 3, ...identity });
    rejects(decodeSession, { version: 1, ...identity, extra: true });
    rejects(decodeSession, { version: 2, ...identity, permissions: claudeEnvelope, extra: true });
    rejects(decodeSession, { version: 1, ...identity, permissions: undefined });
  });

  it("bounds threadId to 2048 bytes and identity fields to 256 non-empty bytes", () => {
    accepts(decodeSession, { version: 1, ...identity, threadId: exact(2048) });
    rejects(decodeSession, { version: 1, ...identity, threadId: exact(2049) });
    rejects(decodeSession, { version: 1, ...identity, environmentId: "" });
    rejects(decodeSession, { version: 1, ...identity, providerSessionId: exact(257) });
  });

  it("enforces the 64 KiB total envelope bound", () => {
    const fatSources = Array.from({ length: 32 }, (_, index) => ({
      kind: "user",
      path: `/tmp/${exact(3800)}/${index}`,
      revision: digest,
    }));
    const fatPolicy = {
      ...claudePolicy,
      launch_context: {
        cli_path: "/bin/claude",
        cli_revision: digest,
        resolved_cli_path: "/bin/claude",
        resolved_cli_revision: digest,
        config_dir: "/tmp/home/.claude",
        settings_sources: "provider_default",
        permission_sources: fatSources,
      },
    };
    rejects(decodeSession, {
      version: 2,
      ...identity,
      permissions: permissions("claude_stream_json", fatPolicy),
    });
  });
});

describe("permission fact common fields", () => {
  it("closes every object against excess fields", () => {
    rejects(decodePermissions, { ...codexEnvelope, providerThreadId: "leak" });
    rejects(decodePermissions, { ...codexEnvelope, env: { HOME: "/x" } });
    rejects(decodePermissions, {
      ...codexEnvelope,
      provider_policy: { ...codexPolicy, hooks: {} },
    });
    rejects(decodePermissions, {
      ...codexEnvelope,
      provider_policy: {
        ...codexPolicy,
        sandbox_policy: { type: "dangerFullAccess", networkAccess: true },
      },
    });
    rejects(decodePermissions, {
      ...claudeEnvelope,
      provider_policy: {
        ...claudePolicy,
        permission_callback: { ...claudePolicy.permission_callback, plan_exit: "ask" },
      },
    });
  });

  it("accepts only the literal protocol version and provider_turn source", () => {
    rejects(decodePermissions, { ...codexEnvelope, version: 2 });
    rejects(decodePermissions, { ...codexEnvelope, source: "ui" });
    accepts(decodePermissions, codexEnvelope);
  });

  it("bounds identifiers to 256 bytes without control characters", () => {
    accepts(decodePermissions, { ...codexEnvelope, run_id: exact(256) });
    rejects(decodePermissions, { ...codexEnvelope, run_id: exact(257) });
    rejects(decodePermissions, { ...codexEnvelope, run_id: "run\u0000-1" });
    rejects(decodePermissions, { ...codexEnvelope, provider_session_id: "" });
  });

  it("keeps revision a safe integer 1..2^53-1", () => {
    accepts(decodePermissions, { ...codexEnvelope, revision: maxSeq });
    rejects(decodePermissions, { ...codexEnvelope, revision: 0 });
    rejects(decodePermissions, { ...codexEnvelope, revision: 1.5 });
    rejects(decodePermissions, { ...codexEnvelope, revision: 2 ** 53 });
    rejects(decodePermissions, { ...codexEnvelope, revision: Number.NaN });
  });

  it("requires an absolute bounded cwd", () => {
    accepts(decodePermissions, { ...codexEnvelope, cwd: exact(4096, "/") });
    rejects(decodePermissions, { ...codexEnvelope, cwd: "relative/path" });
    rejects(decodePermissions, { ...codexEnvelope, cwd: "~/project" });
    rejects(decodePermissions, { ...codexEnvelope, cwd: "" });
    rejects(decodePermissions, { ...codexEnvelope, cwd: `/${exact(4096)}` });
  });

  it("accepts only the four runtime modes and two interaction modes", () => {
    for (const runtime_mode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
      accepts(decodePermissions, { ...codexEnvelope, runtime_mode });
    }
    rejects(decodePermissions, { ...codexEnvelope, runtime_mode: "yolo" });
    rejects(decodePermissions, { ...codexEnvelope, runtime_mode: "FULL-ACCESS" });
    accepts(decodePermissions, { ...codexEnvelope, interaction_mode: "plan" });
    rejects(decodePermissions, { ...codexEnvelope, interaction_mode: "compact" });
  });

  it("never lets a codex envelope carry a claude policy or the reverse", () => {
    rejects(decodePermissions, permissions("codex_app_server", claudePolicy));
    rejects(decodePermissions, permissions("claude_stream_json", codexPolicy));
    rejects(decodePermissions, permissions("claude_code", codexPolicy));
  });
});

describe("codex provider policy wire", () => {
  it("accepts the three string approval policies", () => {
    for (const approval_policy of ["untrusted", "on-request", "never"]) {
      accepts(
        decodePermissions,
        permissions("codex_app_server", { ...codexPolicy, approval_policy }),
      );
    }
    rejects(
      decodePermissions,
      permissions("codex_app_server", { ...codexPolicy, approval_policy: "always" }),
    );
  });

  it("accepts the exact granular wire object and refuses invented or missing keys", () => {
    const granular = {
      kind: "codex",
      approval_policy: {
        granular: {
          mcp_elicitations: true,
          request_permissions: false,
          rules: true,
          sandbox_approval: false,
          skill_approval: true,
        },
      },
      approvals_reviewer: "auto_review",
      sandbox_policy: { type: "readOnly" },
    };
    accepts(decodePermissions, permissions("codex_app_server", granular));
    // Optional keys represent a real absence; they are never invented by Bridget,
    // and the schema must not require them.
    accepts(
      decodePermissions,
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: {
          granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
        },
        approvals_reviewer: "user",
        sandbox_policy: { type: "readOnly", networkAccess: false },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: { granular: { mcp_elicitations: true, rules: true } },
        approvals_reviewer: "user",
        sandbox_policy: { type: "readOnly" },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: {
          granular: { mcp_elicitations: true, rules: true, sandbox_approval: true, extra: true },
        },
        approvals_reviewer: "user",
        sandbox_policy: { type: "readOnly" },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: {
          granular: { mcp_elicitations: "yes", rules: true, sandbox_approval: true },
        },
        approvals_reviewer: "user",
        sandbox_policy: { type: "readOnly" },
      }),
    );
  });

  it("accepts only the three reviewer values", () => {
    for (const approvals_reviewer of ["user", "auto_review", "guardian_subagent"]) {
      accepts(
        decodePermissions,
        permissions("codex_app_server", { ...codexPolicy, approvals_reviewer }),
      );
    }
    rejects(
      decodePermissions,
      permissions("codex_app_server", { ...codexPolicy, approvals_reviewer: "assistant" }),
    );
  });

  it("accepts exactly the four sandbox wire shapes", () => {
    accepts(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "readOnly", networkAccess: true },
      }),
    );
    accepts(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "externalSandbox", networkAccess: "restricted" },
      }),
    );
    accepts(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "externalSandbox", networkAccess: "enabled" },
      }),
    );
    accepts(
      decodePermissions,
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: "never",
        approvals_reviewer: "user",
        sandbox_policy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/project"],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: false,
        },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "dangerFullAccess", networkAccess: true },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "workspace-only" },
      }),
    );
    rejects(
      decodePermissions,
      permissions("codex_app_server", {
        ...codexPolicy,
        sandbox_policy: { type: "externalSandbox", networkAccess: "unrestricted" },
      }),
    );
  });

  it("bounds writableRoots to 128 absolute paths of 4096 bytes", () => {
    const policy = (writableRoots: unknown) =>
      permissions("codex_app_server", {
        kind: "codex",
        approval_policy: "never",
        approvals_reviewer: "user",
        sandbox_policy: { type: "workspaceWrite", writableRoots: writableRoots as string[] },
      });
    accepts(
      decodePermissions,
      policy(Array.from({ length: 128 }, (_, index) => `/tmp/root-${index}`)),
    );
    rejects(
      decodePermissions,
      policy(Array.from({ length: 129 }, (_, index) => `/tmp/root-${index}`)),
    );
    rejects(decodePermissions, policy(["relative/root"]));
    rejects(decodePermissions, policy([exact(4097, "/")]));
  });
});

describe("claude provider policy wire", () => {
  it("accepts only the six permission modes and never an un-normalized alias", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]) {
      accepts(decodeClaudeMode, mode);
      accepts(
        decodePermissions,
        permissions("claude_stream_json", { ...claudePolicy, permission_mode: mode }),
      );
    }
    // "manual" is a provider alias; normalization happens before publication.
    rejects(decodeClaudeMode, "manual");
    rejects(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, permission_mode: "manual" }),
    );
  });

  it("accepts a tool list or the claude_code preset, nothing else", () => {
    accepts(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        tools: { type: "preset", preset: "claude_code" },
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        tools: { type: "preset", preset: "cursor" },
      }),
    );
    // The contract bounds every list at 128 entries and states no minimum, so an
    // empty list stays representable (same for settings_sources below).
    accepts(decodePermissions, permissions("claude_stream_json", { ...claudePolicy, tools: [] }));
    rejects(decodePermissions, permissions("claude_stream_json", { ...claudePolicy, tools: [""] }));
    rejects(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, tools: [exact(513)] }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        tools: Array.from({ length: 129 }, () => "Read"),
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, tools: "Read" }),
    );
  });

  it("keeps the optional tool lists and directories bounded and absolute", () => {
    accepts(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        allowed_tools: ["Read"],
        disallowed_tools: ["Write"],
        additional_directories: ["/tmp/extra"],
        allow_dangerously_skip_permissions: true,
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        additional_directories: ["../relative"],
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        allowed_tools: Array.from({ length: 129 }, () => "Read"),
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        allow_dangerously_skip_permissions: "yes",
      }),
    );
  });

  it("freezes the t3_runtime callback shape", () => {
    accepts(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        permission_callback: { kind: "t3_runtime", tool_approval: "allow", plan_exit: "deny" },
      }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        permission_callback: { kind: "sdk", tool_approval: "prompt", plan_exit: "deny" },
      }),
    );
  });

  it("publishes provider_default only, never an invented merged-settings claim", () => {
    accepts(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, settings_sources: "provider_default" }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, settings_sources: "merged" }),
    );
    rejects(
      decodePermissions,
      permissions("claude_stream_json", { ...claudePolicy, settings_sources: ["user"] }),
    );
  });
});

describe("claude launch context", () => {
  const launchContext = {
    cli_path: "/bin/claude",
    cli_revision: digest,
    resolved_cli_path: "/usr/local/bin/claude",
    resolved_cli_revision: otherDigest,
    config_dir: "/tmp/home/.claude",
    settings_sources: "provider_default",
    permission_sources: [
      { kind: "user", path: "/tmp/home/.claude/settings.json", revision: digest },
      {
        kind: "managed",
        path: "/Library/Application Support/ClaudeCode/managed-settings.json",
        revision: "absent",
      },
      { kind: "cli", path: "/tmp/project/settings.json", revision: otherDigest },
    ],
  };

  it("accepts both launcher and resolved CLI couples with sha256 digests", () => {
    const decoded = decodeLaunchContext(launchContext);
    expect(decoded.cli_revision).toBe(digest);
    expect(decoded.resolved_cli_revision).toBe(otherDigest);
  });

  it("refuses non-sha256 digests, uppercase hex, and relative paths", () => {
    rejects(decodeLaunchContext, { ...launchContext, cli_revision: "sha512:abc" });
    rejects(decodeLaunchContext, { ...launchContext, cli_revision: sha("A".repeat(64)) });
    rejects(decodeLaunchContext, { ...launchContext, cli_revision: sha("a".repeat(63)) });
    rejects(decodeLaunchContext, { ...launchContext, resolved_cli_path: "claude" });
    rejects(decodeLaunchContext, { ...launchContext, config_dir: "~/.claude" });
  });

  it("bounds permission_sources to 32 entries with the five kinds and absent-or-digest revisions", () => {
    accepts(decodeLaunchContext, {
      ...launchContext,
      permission_sources: Array.from({ length: 32 }, (_, index) => ({
        kind: "local",
        path: `/tmp/src-${index}`,
        revision: "absent",
      })),
    });
    rejects(decodeLaunchContext, {
      ...launchContext,
      permission_sources: Array.from({ length: 33 }, (_, index) => ({
        kind: "local",
        path: `/tmp/src-${index}`,
        revision: "absent",
      })),
    });
    rejects(decodeLaunchContext, {
      ...launchContext,
      permission_sources: [{ kind: "global", path: "/tmp/x", revision: "absent" }],
    });
    rejects(decodeLaunchContext, {
      ...launchContext,
      permission_sources: [{ kind: "user", path: "/tmp/x", revision: "missing" }],
    });
    rejects(decodeLaunchContext, {
      ...launchContext,
      permission_sources: [{ kind: "user", path: "relative", revision: "absent" }],
    });
  });

  it("accepts provider_default or a duplicate-free user/project/local list of at most three", () => {
    accepts(decodeLaunchContext, {
      ...launchContext,
      settings_sources: ["user", "project", "local"],
    });
    accepts(decodeLaunchContext, { ...launchContext, settings_sources: ["project"] });
    rejects(decodeLaunchContext, { ...launchContext, settings_sources: ["user", "user"] });
    rejects(decodeLaunchContext, {
      ...launchContext,
      settings_sources: ["user", "project", "local", "managed"],
    });
    // No minimum in the contract: an empty selection list stays representable.
    accepts(decodeLaunchContext, { ...launchContext, settings_sources: [] });
  });

  it("publishes only sanitary settings overrides with bounded shapes", () => {
    const overrides = {
      permissions: {
        allow: ["Read"],
        ask: ["Write"],
        deny: ["Bash(rm:*)"],
        defaultMode: "default",
        additionalDirectories: ["/tmp/extra"],
        disableBypassPermissionsMode: "disable",
      },
    };
    const decoded = decodeOverrides(overrides);
    expect(decoded.permissions?.allow).toEqual(["Read"]);
    accepts(decodeOverrides, { permissions: { allow: ["Read"] } });
    accepts(decodeOverrides, {});
    rejects(decodeOverrides, { permissions: { defaultMode: "manual" } });
    rejects(decodeOverrides, { permissions: { additionalDirectories: ["../relative"] } });
    rejects(decodeOverrides, { permissions: { allow: [exact(513)] } });
    rejects(decodeOverrides, { permissions: { disableBypassPermissionsMode: "remove" } });
    // Documented limit (same as bridgetLineage149): a bare Schema.Struct strips
    // excess keys instead of refusing them. The sanitary refusal of sandbox/env/
    // hooks/policyHelper inputs is an adapter duty (claudeSanitarySettings) and is
    // covered in BridgetPermissions149.test.ts through the query runner.
    const stripped = decodeOverrides({
      permissions: { allow: ["Read"], sandbox: true, env: { KEY: "value" } },
    });
    expect(Object.keys(stripped.permissions ?? {})).toEqual(["allow"]);
    accepts(
      decodePermissions,
      permissions("claude_stream_json", {
        ...claudePolicy,
        launch_context: { ...launchContext, settings_overrides: overrides },
      }),
    );
  });

  it("keeps launch_context optional in the policy", () => {
    const decoded = decodeClaudePolicy({ ...claudePolicy });
    expect("launch_context" in decoded).toBe(false);
  });
});
