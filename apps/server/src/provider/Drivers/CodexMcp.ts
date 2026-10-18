import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { refreshBridgetMcpServer } from "../../bridget/BridgetMcp.ts";

// Même plafond que le wrapper Codex natif Bridget : attente métier de 3600 s
// plus attestation et transport. Les délais des missions restent indépendants.
const BRIDGET_TOOL_TIMEOUT_SECONDS = 3700;

const decodeConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.Struct({
      mcp_servers: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  }),
);

/** Effective project config is authoritative; uncertain policy leaves native threads available. */
export const prepareCodexBridgetMcp = Effect.fn("prepareCodexBridgetMcp")(function* (input: {
  readonly session: McpProviderSessionConfig | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly readConfig: () => Effect.Effect<unknown, unknown>;
}) {
  if (!input.session) return undefined;
  return yield* Effect.gen(function* () {
    const config = yield* input.readConfig().pipe(Effect.flatMap(decodeConfig));
    const servers = config.config.mcp_servers ?? {};
    const mount = yield* refreshBridgetMcpServer(
      input.environment,
      input.session,
      Object.hasOwn(servers, "bridget") ? [servers.bridget] : [],
    );
    if (mount.code !== "ready") return undefined;
    const { type: _type, ...server } = mount.server;
    return {
      ...server,
      tool_timeout_sec: Math.max(
        typeof server.tool_timeout_sec === "number" ? server.tool_timeout_sec : 0,
        BRIDGET_TOOL_TIMEOUT_SECONDS,
      ),
    } satisfies Schema.Json;
  }).pipe(
    Effect.timeout("6 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
