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
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

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
const permissionsByThread = new WeakMap<McpProviderSessionConfig, PermissionFact>();
const activeConfigs = new WeakSet<McpProviderSessionConfig>();

export function activateMcpProviderSession(config: McpProviderSessionConfig): void {
  activeConfigs.add(config);
}
export function deactivateMcpProviderSession(config: McpProviderSessionConfig): void {
  activeConfigs.delete(config);
  permissionsByThread.delete(config);
}
export function isMcpProviderSessionActive(config: McpProviderSessionConfig): boolean {
  return activeConfigs.has(config);
}

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
  if (!activeConfigs.has(config)) return { status: "unavailable" };
  const fact = permissionsByThread.get(config);
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
      if (permissionsByThread.get(config) === fact) invalidateMcpProviderPermissions(config, runId);
      return { status: "unavailable" };
    }
  }
  if (!activeConfigs.has(config) || permissionsByThread.get(config) !== fact)
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
  if (!activeConfigs.has(config)) return undefined;
  const previous = permissionsByThread.get(config);
  const revision = (previous?.owner === config ? previous.revision : 0) + 1;
  const decoded = decodeBridgetPermissions({ ...permissions, revision });
  const valid =
    Option.isSome(decoded) &&
    decoded.value.provider_session_id === config.providerSessionId &&
    decoded.value.provider_instance_id === config.providerInstanceId;
  permissionsByThread.set(config, {
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
  if (!activeConfigs.has(config)) return;
  const current = permissionsByThread.get(config);
  if (current !== undefined && (current.owner !== config || current.runId !== runId)) return;
  if (expectedRevision !== undefined && current?.revision !== expectedRevision) return;
  permissionsByThread.set(config, {
    owner: config,
    runId,
    revision: current?.revision ?? 0,
  });
}

// Legacy fixture helpers. Production ownership is environment-scoped in McpProviderSessions.
export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  const previous = sessionsByThread.get(config.threadId);
  if (previous !== undefined && previous !== config) deactivateMcpProviderSession(previous);
  sessionsByThread.set(config.threadId, config);
  activateMcpProviderSession(config);
}
export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}
export function clearMcpProviderSession(threadId: ThreadId): void {
  const previous = sessionsByThread.get(threadId);
  if (previous !== undefined) deactivateMcpProviderSession(previous);
  sessionsByThread.delete(threadId);
}
