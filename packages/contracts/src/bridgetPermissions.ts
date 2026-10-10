import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

function hasPermissionControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const boundedText = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.length > 0 &&
        new TextEncoder().encode(value).length <= bytes &&
        !hasPermissionControlCharacters(value),
    ),
  );
const Identity = boundedText(256);
const AbsolutePath = boundedText(4096).check(Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/])/));
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Rules = Schema.Array(boundedText(512)).check(Schema.isMaxLength(128));
const Paths = Schema.Array(AbsolutePath).check(Schema.isMaxLength(128));
export const BridgetClaudePermissionMode = Schema.Literals([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
const SettingsSources = Schema.Union([
  Schema.Literal("provider_default"),
  Schema.Array(Schema.Literals(["user", "project", "local"])).check(
    Schema.isMaxLength(3),
    Schema.makeFilter((values) => new Set(values).size === values.length),
  ),
]);
export const BridgetClaudeSettingsOverrides = Schema.Struct({
  permissions: Schema.optionalKey(
    Schema.Struct({
      allow: Schema.optionalKey(Rules),
      ask: Schema.optionalKey(Rules),
      deny: Schema.optionalKey(Rules),
      defaultMode: Schema.optionalKey(BridgetClaudePermissionMode),
      additionalDirectories: Schema.optionalKey(Paths),
      disableBypassPermissionsMode: Schema.optionalKey(Schema.Literal("disable")),
    }),
  ),
});
export type BridgetClaudeSettingsOverrides = typeof BridgetClaudeSettingsOverrides.Type;
export const BridgetClaudeLaunchContext = Schema.Struct({
  cli_path: AbsolutePath,
  cli_revision: Digest,
  resolved_cli_path: AbsolutePath,
  resolved_cli_revision: Digest,
  config_dir: AbsolutePath,
  settings_sources: SettingsSources,
  settings_overrides: Schema.optionalKey(BridgetClaudeSettingsOverrides),
  permission_sources: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["user", "project", "local", "managed", "cli"]),
      path: AbsolutePath,
      revision: Schema.Union([Schema.Literal("absent"), Digest]),
    }),
  ).check(Schema.isMaxLength(32)),
});
export type BridgetClaudeLaunchContext = typeof BridgetClaudeLaunchContext.Type;
export const BridgetClaudeProviderPolicy = Schema.Struct({
  kind: Schema.Literal("claude"),
  permission_mode: BridgetClaudePermissionMode,
  tools: Schema.Union([
    Rules,
    Schema.Struct({ type: Schema.Literal("preset"), preset: Schema.Literal("claude_code") }),
  ]),
  allowed_tools: Schema.optionalKey(Rules),
  disallowed_tools: Schema.optionalKey(Rules),
  additional_directories: Schema.optionalKey(Paths),
  allow_dangerously_skip_permissions: Schema.optionalKey(Schema.Boolean),
  permission_callback: Schema.Struct({
    kind: Schema.Literal("t3_runtime"),
    tool_approval: Schema.Literals(["prompt", "allow"]),
    plan_exit: Schema.Literal("deny"),
  }),
  settings_sources: Schema.Literal("provider_default"),
  launch_context: Schema.optionalKey(BridgetClaudeLaunchContext),
});
export type BridgetClaudeProviderPolicy = typeof BridgetClaudeProviderPolicy.Type;
const CodexPolicy = Schema.Struct({
  kind: Schema.Literal("codex"),
  approval_policy: Schema.Union([
    Schema.Literals(["untrusted", "on-request", "never"]),
    Schema.Struct({
      granular: Schema.Struct({
        mcp_elicitations: Schema.Boolean,
        request_permissions: Schema.optionalKey(Schema.Boolean),
        rules: Schema.Boolean,
        sandbox_approval: Schema.Boolean,
        skill_approval: Schema.optionalKey(Schema.Boolean),
      }),
    }),
  ]),
  approvals_reviewer: Schema.Literals(["user", "auto_review", "guardian_subagent"]),
  sandbox_policy: Schema.Union([
    Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
    Schema.Struct({
      type: Schema.Literal("readOnly"),
      networkAccess: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("externalSandbox"),
      networkAccess: Schema.optionalKey(Schema.Literals(["restricted", "enabled"])),
    }),
    Schema.Struct({
      type: Schema.Literal("workspaceWrite"),
      writableRoots: Schema.optionalKey(Paths),
      networkAccess: Schema.optionalKey(Schema.Boolean),
      excludeSlashTmp: Schema.optionalKey(Schema.Boolean),
      excludeTmpdirEnvVar: Schema.optionalKey(Schema.Boolean),
    }),
  ]),
});
const common = {
  version: Schema.Literal(1),
  source: Schema.Literal("provider_turn"),
  run_id: Identity,
  provider_session_id: Identity,
  provider_instance_id: Identity,
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  cwd: AbsolutePath,
  runtime_mode: RuntimeMode,
  interaction_mode: ProviderInteractionMode,
};
const Permissions = Schema.Union([
  Schema.Struct({
    ...common,
    driver: Schema.Literal("codex_app_server"),
    provider_policy: CodexPolicy,
  }),
  Schema.Struct({
    ...common,
    driver: Schema.Literal("claude_stream_json"),
    provider_policy: BridgetClaudeProviderPolicy,
  }),
]);
export const BridgetPermissions = Schema.declareConstructor<
  typeof Permissions.Type,
  typeof Permissions.Encoded
>()([Permissions], ([codec]) => {
  const decode = SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" });
  return (input) => decode(input);
});
export type BridgetPermissions = typeof BridgetPermissions.Type;
const identityFields = {
  environmentId: Identity,
  threadId: boundedText(2048),
  providerSessionId: Identity,
  providerInstanceId: Identity,
};
const SessionIdentity = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), ...identityFields }),
  Schema.Struct({
    version: Schema.Literal(2),
    environmentId: Identity,
    threadId: boundedText(2048),
    providerSessionId: Identity,
    providerInstanceId: Identity,
    permissions: BridgetPermissions,
  }).check(
    Schema.makeFilter(
      (value) =>
        value.providerSessionId === value.permissions.provider_session_id &&
        value.providerInstanceId === value.permissions.provider_instance_id &&
        new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024,
    ),
  ),
]);
export const BridgetSessionIdentity = Schema.declareConstructor<
  typeof SessionIdentity.Type,
  typeof SessionIdentity.Encoded
>()([SessionIdentity], ([codec]) => {
  const decode = SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" });
  return (input) => decode(input);
});
export type BridgetSessionIdentity = typeof BridgetSessionIdentity.Type;
