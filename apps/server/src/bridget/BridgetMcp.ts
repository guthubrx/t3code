import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveBridgetExecutable } from "./BridgetExecutable.ts";

/** Private identity belongs to this MCP subprocess, never to the provider process. */
export const bridgetMcpServer = Effect.fn("bridgetMcpServer")(function* (
  environment: NodeJS.ProcessEnv,
  session: McpProviderSessionConfig | undefined,
) {
  if (!session) return { code: "identity_unavailable" as const };
  if (
    [environment.BRIDGET_AGENT_ID_FILE, environment.BRIDGET_AGENT_INSTANCE_ID].some(
      (value) => value !== undefined && value.length > 0,
    )
  )
    return { code: "inherited_identity" as const };
  const path = yield* Path.Path;
  const home = environment.HOME;
  const root =
    environment.BRIDGET_HOME ?? (home ? path.join(home, ".cache", "bridget-core") : undefined);
  const socket = environment.BRIDGET_SOCKET ?? (root ? path.join(root, "bridget.sock") : undefined);
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
  const executable = yield* resolveBridgetExecutable(environment).pipe(Effect.result);
  if (executable._tag === "Failure") return { code: "executable_unavailable" as const };
  const t3codeHome = session.t3codeHome ?? environment.T3CODE_HOME;
  return {
    code: "ready" as const,
    server: {
      type: "stdio" as const,
      command: executable.success,
      args: ["mcp"],
      env: {
        HOME: home,
        BRIDGET_HOME: root,
        BRIDGET_SOCKET: socket,
        ...(t3codeHome ? { T3CODE_HOME: t3codeHome } : {}),
        BRIDGET_T3_MCP_ENDPOINT: session.endpoint,
        BRIDGET_T3_MCP_AUTHORIZATION: session.authorizationHeader,
      },
    },
  };
});
