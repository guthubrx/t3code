import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Legacy from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Existing attestation fixtures rotate exact credential objects synchronously.
// Keep those fixtures on one registry while adapters use the scoped service API.
export const layer = Layer.succeed(Sessions.McpProviderSessions, {
  set: (config) => Effect.sync(() => Legacy.setMcpProviderSession(config)),
  read: (threadId) => Effect.sync(() => Legacy.readMcpProviderSession(threadId)),
  clear: (threadId) => Effect.sync(() => Legacy.clearMcpProviderSession(threadId)),
  recordHtmlRender: () => Effect.void,
  takeHtmlRender: () => Effect.undefined,
});
