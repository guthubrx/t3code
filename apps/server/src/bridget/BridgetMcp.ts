import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveBridgetExecutable } from "./BridgetExecutable.ts";

const isServer = Schema.is(Schema.Record(Schema.String, Schema.Json));
const isEnvironment = Schema.is(Schema.Record(Schema.String, Schema.String));

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

/** Reuse only verified local Bridget definitions; session proof never enters user config. */
export const refreshBridgetMcpServer = Effect.fn("refreshBridgetMcpServer")(
  function* (
    environment: NodeJS.ProcessEnv,
    session: McpProviderSessionConfig | undefined,
    definitions: ReadonlyArray<unknown>,
  ) {
    const servers = [];
    for (const definition of definitions) {
      if (!isServer(definition)) return { code: "user_server" as const };
      if (definition.enabled === false) return { code: "disabled" as const };
      if (
        (definition.enabled !== undefined && definition.enabled !== true) ||
        (definition.type !== undefined && definition.type !== "stdio") ||
        definition.url !== undefined ||
        typeof definition.command !== "string" ||
        !Array.isArray(definition.args) ||
        definition.args.length !== 1 ||
        definition.args[0] !== "mcp" ||
        (definition.env !== undefined && !isEnvironment(definition.env))
      )
        return { code: "user_server" as const };
      servers.push({ ...definition, command: definition.command, env: definition.env ?? {} });
    }
    const mount = yield* bridgetMcpServer(environment, session);
    if (mount.code !== "ready") return mount;
    const fs = yield* FileSystem.FileSystem;
    const executable = yield* fs.realPath(mount.server.command);
    for (const server of servers) {
      if (
        [server.env.BRIDGET_AGENT_ID_FILE, server.env.BRIDGET_AGENT_INSTANCE_ID].some(
          (value) => value !== undefined && value.length > 0,
        )
      )
        return { code: "inherited_identity" as const };
      for (const key of ["HOME", "BRIDGET_HOME", "BRIDGET_SOCKET", "T3CODE_HOME"] as const) {
        if (server.env[key] !== undefined && server.env[key] !== mount.server.env[key])
          return { code: "namespace_unavailable" as const };
      }
      // A project-defined loader variable must not receive the private session proof.
      if (Object.keys(server.env).some((key) => !Object.hasOwn(mount.server.env, key)))
        return { code: "user_server" as const };
      const command = yield* resolveCommandPath(server.command, {
        env: { ...environment, ...server.env },
      });
      if ((yield* fs.realPath(command)) !== executable) return { code: "user_server" as const };
    }
    const current = servers.at(-1);
    return {
      code: "ready" as const,
      server: {
        ...mount.server,
        ...current,
        type: "stdio" as const,
        command: executable,
        args: ["mcp"],
        env: mount.server.env,
      },
    };
  },
  Effect.catch(() => Effect.succeed({ code: "executable_unavailable" as const })),
);
