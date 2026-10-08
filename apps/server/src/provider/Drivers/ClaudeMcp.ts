import type {
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveBridgetExecutable } from "../../bridget/BridgetExecutable.ts";
import { resolveClaudeHomePath } from "./ClaudeHome.ts";
import { claudeSettingsPaths, findRepositoryRoot } from "./ClaudeSettingsPaths.ts";

export class ClaudeMcpError extends Data.TaggedError("ClaudeMcpError")<{
  readonly code: "sdk_failed" | "timeout" | "catalogue_unavailable";
}> {}

type MetadataCode = "disabled" | "user_server" | "metadata_unavailable";
const McpPolicyEntry = Schema.Struct({
  serverName: Schema.optional(Schema.String),
  serverCommand: Schema.optional(Schema.Array(Schema.String)),
  serverUrl: Schema.optional(Schema.String),
});
const McpMetadata = Schema.Struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  disabledMcpServers: Schema.optional(Schema.Array(Schema.String)),
  disabledMcpjsonServers: Schema.optional(Schema.Array(Schema.String)),
  deniedMcpServers: Schema.optional(Schema.Array(McpPolicyEntry)),
  allowedMcpServers: Schema.optional(Schema.Array(McpPolicyEntry)),
});
const decodeMetadata = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      ...McpMetadata.fields,
      projects: Schema.optional(Schema.Record(Schema.String, McpMetadata)),
    }),
  ),
);

const metadataPolicy = Effect.fn("ClaudeMcp.metadataPolicy")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const home = yield* resolveClaudeHomePath(config, environment);
  const root = cwd ? yield* findRepositoryRoot(cwd, "strict") : undefined;
  const explicitHome = config.homePath.trim().length > 0 || !!environment.CLAUDE_CONFIG_DIR?.trim();
  const profileFile = explicitHome
    ? path.join(home, ".claude.json")
    : path.join(environment.HOME ?? path.dirname(home), ".claude.json");
  const files = [
    profileFile,
    ...claudeSettingsPaths(path, home, cwd, platform, environment, root),
    // Conservative auto-mount opt-out only; Skills keeps its native scopes.
    ...(root && root !== cwd ? [path.join(root, ".claude", "settings.json")] : []),
    ...(cwd ? [path.join(cwd, ".mcp.json")] : []),
    ...(root && root !== cwd ? [path.join(root, ".mcp.json")] : []),
  ];
  for (const file of files) {
    const stat = yield* fs
      .stat(file)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail("metadata_unavailable" as const),
        ),
      );
    if (stat === undefined) continue;
    if (stat.type !== "File" || stat.size > 4 * 1024 * 1024)
      return yield* Effect.fail("metadata_unavailable" as const);
    const contents = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => "metadata_unavailable" as const));
    const metadata = yield* decodeMetadata(contents).pipe(
      Effect.mapError(() => "metadata_unavailable" as const),
    );
    const project = cwd ? metadata.projects?.[path.resolve(cwd)] : undefined;
    const rootProject = root ? metadata.projects?.[path.resolve(root)] : undefined;
    for (const entry of [metadata, project, rootProject]) {
      if (!entry) continue;
      if (
        entry.disabledMcpServers?.includes("bridget") ||
        entry.disabledMcpjsonServers?.includes("bridget")
      )
        return "disabled" as const;
      if (entry.deniedMcpServers?.some((policy) => policy.serverName === "bridget"))
        return "disabled" as const;
      if (
        entry.allowedMcpServers &&
        entry.allowedMcpServers.every(
          (policy) => policy.serverName && !policy.serverCommand && !policy.serverUrl,
        ) &&
        !entry.allowedMcpServers.some((policy) => policy.serverName === "bridget")
      )
        return "disabled" as const;
      if (entry.mcpServers && Object.hasOwn(entry.mcpServers, "bridget"))
        return "user_server" as const;
    }
  }
  return undefined;
});

/**
 * Startup/cold path for a new or resumed candidate, while its user prompt queue is empty.
 * Metadata scopes are a fixed set, with a 4 MiB/file stat guard; ancestor discovery
 * scales with cwd depth. Local work is linear in the metadata bytes and SDK
 * catalogue/config entries inspected or copied, plus executable path lookup (not O(1)).
 * At most three SDK controls run under one 6-second preparation deadline.
 * SDK promises may outlive that deadline; the caller owns candidate closure and
 * must prevent publication or prompts after failed/interrupted preparation.
 */
export const prepareClaudeMcp = Effect.fn("prepareClaudeMcp")(function* (input: {
  readonly query: {
    readonly mcpServerStatus: () => Promise<McpServerStatus[]>;
    readonly setMcpServers: (
      servers: Record<string, McpServerConfig>,
    ) => Promise<McpSetServersResult>;
  };
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly extraArgs: Readonly<Record<string, unknown>>;
  readonly servers?: Record<string, McpServerConfig>;
}) {
  if (
    Object.hasOwn(input.extraArgs, "strict-mcp-config") ||
    Object.hasOwn(input.extraArgs, "mcp-config")
  )
    return { code: "explicit_config" as const };
  if (
    [input.environment.BRIDGET_AGENT_ID_FILE, input.environment.BRIDGET_AGENT_INSTANCE_ID].some(
      (value) => value !== undefined && value.length > 0,
    )
  )
    return { code: "inherited_identity" as const };
  const sdk = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => new ClaudeMcpError({ code: "sdk_failed" }) });
  const preparation = Effect.gen(function* () {
    const policy = yield* metadataPolicy(input.config, input.cwd, input.environment).pipe(
      Effect.catch(() => Effect.succeed("metadata_unavailable" as MetadataCode)),
    );
    if (policy) return { code: policy };
    const current = yield* sdk(() => input.query.mcpServerStatus());
    if (current.some((server) => server.name === "bridget"))
      return { code: "user_server" as const };
    const path = yield* Path.Path;
    const home = input.environment.HOME;
    const root =
      input.environment.BRIDGET_HOME ??
      (home ? path.join(home, ".cache", "bridget-core") : undefined);
    const socket =
      input.environment.BRIDGET_SOCKET ?? (root ? path.join(root, "bridget.sock") : undefined);
    if (
      !home ||
      !root ||
      !socket ||
      root === path.dirname(root) ||
      !path.isAbsolute(home) ||
      !path.isAbsolute(root) ||
      !path.isAbsolute(socket) ||
      path.dirname(socket) !== root ||
      new TextEncoder().encode(socket).length >= 104
    )
      return { code: "namespace_unavailable" as const };
    const executable = yield* resolveBridgetExecutable(input.environment).pipe(Effect.result);
    if (executable._tag === "Failure") return { code: "executable_unavailable" as const };
    const result = yield* sdk(() =>
      input.query.setMcpServers({
        ...input.servers,
        bridget: {
          type: "stdio",
          command: executable.success,
          args: ["mcp"],
          env: { HOME: home, BRIDGET_HOME: root, BRIDGET_SOCKET: socket },
        },
      }),
    );
    if (Object.keys(result.errors).length > 0)
      return yield* new ClaudeMcpError({ code: "sdk_failed" });
    const mounted = yield* sdk(() => input.query.mcpServerStatus());
    if (
      !mounted.some(
        (server) =>
          server.name === "bridget" &&
          server.status === "connected" &&
          server.tools?.some((tool) => tool.name === "bridget_thread"),
      )
    )
      return yield* new ClaudeMcpError({ code: "catalogue_unavailable" });
    return { code: "mounted" as const };
  });
  return yield* preparation.pipe(
    Effect.timeoutOrElse({
      duration: "6 seconds",
      orElse: () => Effect.fail(new ClaudeMcpError({ code: "timeout" })),
    }),
  );
});
