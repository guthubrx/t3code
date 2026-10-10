import {
  BridgetPermissions,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeBridgetPermissions = Schema.decodeUnknownOption(BridgetPermissions);

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** T3 runtime namespace for the private Bridget subprocess. */
  readonly t3codeHome?: string;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();
type PermissionFact = {
  readonly owner: McpProviderSessionConfig;
  readonly runId: string;
  readonly revision: number;
  readonly attemptId?: string;
  readonly providerThreadId?: string;
  readonly permissions?: BridgetPermissions;
  readonly verify?: () => Promise<boolean>;
};
const permissionsByThread = new Map<ThreadId, PermissionFact>();

/** O(1) lookup; the adapter's verifier rechecks only its bounded source inputs. */
export async function readMcpProviderPermissions(
  config: McpProviderSessionConfig,
  runId: string,
  binding: { readonly attemptId: string | null; readonly providerThreadId: string | null },
): Promise<
  | { readonly status: "absent" }
  | { readonly status: "unavailable" }
  | { readonly status: "valid"; readonly permissions: BridgetPermissions }
> {
  if (sessionsByThread.get(config.threadId) !== config) return { status: "unavailable" };
  const fact = permissionsByThread.get(config.threadId);
  if (fact === undefined) return { status: "absent" };
  if (
    fact.owner !== config ||
    fact.runId !== runId ||
    fact.attemptId !== binding.attemptId ||
    fact.providerThreadId !== binding.providerThreadId ||
    fact.permissions === undefined
  )
    return { status: "unavailable" };
  if (fact.verify !== undefined) {
    let valid = false;
    try {
      valid = await fact.verify();
    } catch {
      /* Never expose source contents or credentials. */
    }
    if (!valid) {
      if (permissionsByThread.get(config.threadId) === fact)
        invalidateMcpProviderPermissions(config, runId);
      return { status: "unavailable" };
    }
  }
  if (
    sessionsByThread.get(config.threadId) !== config ||
    permissionsByThread.get(config.threadId) !== fact
  )
    return { status: "unavailable" };
  return { status: "valid", permissions: fact.permissions };
}

/** Publish only against the credential object captured by the owning adapter. */
export function publishMcpProviderPermissions(
  config: McpProviderSessionConfig,
  permissions: Omit<BridgetPermissions, "revision">,
  binding: { readonly attemptId: string; readonly providerThreadId: string },
  verify?: () => Promise<boolean>,
): number | undefined {
  if (sessionsByThread.get(config.threadId) !== config) return undefined;
  const previous = permissionsByThread.get(config.threadId);
  const revision = (previous?.owner === config ? previous.revision : 0) + 1;
  const decoded = decodeBridgetPermissions({ ...permissions, revision });
  const valid =
    Option.isSome(decoded) &&
    decoded.value.provider_session_id === config.providerSessionId &&
    decoded.value.provider_instance_id === config.providerInstanceId;
  permissionsByThread.set(config.threadId, {
    owner: config,
    runId: permissions.run_id,
    revision,
    ...binding,
    ...(valid && Option.isSome(decoded)
      ? { permissions: decoded.value, ...(verify ? { verify } : {}) }
      : {}),
  });
  return revision;
}

/** A tombstone prevents an ended or invalid fact from downgrading to identity-only v1. */
export function invalidateMcpProviderPermissions(
  config: McpProviderSessionConfig,
  runId: string,
  expectedRevision?: number,
): void {
  if (sessionsByThread.get(config.threadId) !== config) return;
  const current = permissionsByThread.get(config.threadId);
  if (current !== undefined && (current.owner !== config || current.runId !== runId)) return;
  if (expectedRevision !== undefined && current?.revision !== expectedRevision) return;
  permissionsByThread.set(config.threadId, {
    owner: config,
    runId,
    revision: current?.revision ?? 0,
  });
}

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  if (sessionsByThread.get(config.threadId) !== config) permissionsByThread.delete(config.threadId);
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  permissionsByThread.delete(threadId);
  sessionsByThread.delete(threadId);
}

function clearAllMcpProviderSessions(): void {
  permissionsByThread.clear();
  sessionsByThread.clear();
}
