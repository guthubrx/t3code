import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  clearMcpProviderSession,
  publishMcpProviderPermissions,
  readMcpProviderPermissions,
  readMcpProviderSession,
  setMcpProviderSession,
} from "./mcpSession.ts";

// Spec 149 (permissions lineage). The permission fact registry is private and
// keyed by the credential OBJECT: two configs with equal fields are different
// credentials. A fact binds to the run, its attempt and its provider thread.
// A tombstone (invalidate) must never downgrade an ended or invalid fact back
// to identity-only, and a stale cleanup (wrong revision or wrong run) is a no-op.

let nextThread = 0;
const credential = (over: Record<string, unknown> = {}) => ({
  environmentId: "environment:bridget" as EnvironmentId,
  threadId: `thread:perm-${++nextThread}` as ThreadId,
  providerSessionId: "session-1",
  providerInstanceId: "codex" as ProviderInstanceId,
  endpoint: "http://127.0.0.1:9/private-endpoint",
  authorizationHeader: "Bearer private-proof-149",
  browserToolsAvailable: false,
  ...over,
});
const fact = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  source: "provider_turn" as const,
  run_id: "run-1",
  provider_session_id: "session-1",
  provider_instance_id: "codex",
  driver: "codex_app_server" as const,
  cwd: "/tmp/project",
  runtime_mode: "full-access" as const,
  interaction_mode: "default" as const,
  provider_policy: {
    kind: "codex" as const,
    approval_policy: "never" as const,
    approvals_reviewer: "user" as const,
    sandbox_policy: { type: "dangerFullAccess" } as const,
  },
  ...over,
});
const binding = (attemptId = "attempt-1", providerThreadId = "native-1") => ({
  attemptId,
  providerThreadId,
});
const mounted = (config: ReturnType<typeof credential>) => {
  setMcpProviderSession(config);
  return config;
};

describe("private permission fact publication", () => {
  it("publishes, reads and clears a fact bound to one credential object", async () => {
    const config = mounted(credential());
    try {
      expect(publishMcpProviderPermissions(config, fact(), binding())).toBe(1);
      const read = await readMcpProviderPermissions(config, "run-1", binding());
      expect(read).toMatchObject({ status: "valid" });
      if (read.status !== "valid") return;
      expect(read.permissions.provider_policy).toEqual(fact().provider_policy);
      expect(read.permissions.revision).toBe(1);
      clearMcpProviderSession(config.threadId);
      // Fail-closed: only the legitimately mounted credential can observe
      // "absent"; a credential that is no longer mounted sees "unavailable".
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(readMcpProviderSession(config.threadId)).toBeUndefined();
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("refuses to publish for an unmounted credential", () => {
    const config = credential();
    expect(publishMcpProviderPermissions(config, fact(), binding())).toBeUndefined();
    expect(readMcpProviderSession(config.threadId)).toBeUndefined();
  });

  it("keeps two equal-field credentials distinct (object identity, same UUID is not enough)", async () => {
    const owner = mounted(credential());
    const impostor = credential({ threadId: owner.threadId });
    try {
      publishMcpProviderPermissions(owner, fact(), binding());
      // Mounting another equal-field object on the same thread drops the
      // previous fact: the registry is keyed by object identity, so the same
      // UUID in another object is not the credential.
      setMcpProviderSession(impostor);
      expect(readMcpProviderSession(owner.threadId)).toBe(impostor);
      expect(await readMcpProviderPermissions(owner, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(await readMcpProviderPermissions(impostor, "run-1", binding())).toEqual({
        status: "absent",
      });
    } finally {
      clearMcpProviderSession(owner.threadId);
    }
  });
});

describe("fact binding to run, attempt and provider thread", () => {
  it("refuses a read from another run", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact({ run_id: "run-2" }), binding());
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(await readMcpProviderPermissions(config, "run-2", binding())).toMatchObject({
        status: "valid",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("refuses a reuse of the same run id with another attempt or provider thread", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding("attempt-1", "native-1"));
      expect(
        await readMcpProviderPermissions(config, "run-1", binding("attempt-2", "native-1")),
      ).toEqual({ status: "unavailable" });
      expect(
        await readMcpProviderPermissions(config, "run-1", binding("attempt-1", "native-2")),
      ).toEqual({ status: "unavailable" });
      expect(
        await readMcpProviderPermissions(config, "run-1", {
          attemptId: null,
          providerThreadId: "native-1",
        }),
      ).toEqual({ status: "unavailable" });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("refuses a read from another credential on the same thread without dropping the fact", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding());
      const stranger = credential({ threadId: config.threadId });
      expect(await readMcpProviderPermissions(stranger, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toMatchObject({
        status: "valid",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });
});

describe("stale-safe cleanup and tombstones", () => {
  it("keeps a newer run fact when a cleanup targets the older run", async () => {
    const { invalidateMcpProviderPermissions } = await import("./mcpSession.ts");
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact({ run_id: "run-1" }), binding());
      publishMcpProviderPermissions(config, fact({ run_id: "run-2" }), binding());
      // Stale cleanup: older run, older revision — both guards refuse.
      invalidateMcpProviderPermissions(config, "run-1", 1);
      invalidateMcpProviderPermissions(config, "run-2", 1);
      expect(await readMcpProviderPermissions(config, "run-2", binding())).toMatchObject({
        status: "valid",
      });
      // Exact cleanup turns the current fact into a tombstone.
      invalidateMcpProviderPermissions(config, "run-2", 2);
      expect(await readMcpProviderPermissions(config, "run-2", binding())).toEqual({
        status: "unavailable",
      });
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("never lets a foreign credential cleanup the mounted fact", async () => {
    const { invalidateMcpProviderPermissions } = await import("./mcpSession.ts");
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding());
      invalidateMcpProviderPermissions(credential({ threadId: config.threadId }), "run-1", 1);
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toMatchObject({
        status: "valid",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("drops the fact on session rotation and restarts revisions for the new credential", async () => {
    const first = mounted(credential());
    const second = mounted(
      credential({ threadId: first.threadId, providerSessionId: "session-2" }),
    );
    try {
      publishMcpProviderPermissions(first, fact(), binding());
      expect(
        publishMcpProviderPermissions(
          second,
          fact({ provider_session_id: "session-2" }),
          binding(),
        ),
      ).toBe(1);
      // Fail-closed: the rotated-out credential never sees "absent".
      expect(await readMcpProviderPermissions(first, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(await readMcpProviderPermissions(second, "run-1", binding())).toMatchObject({
        status: "valid",
      });
    } finally {
      clearMcpProviderSession(first.threadId);
    }
  });
});

describe("source verification and closed payload", () => {
  it("invalidates the fact when the verifier reports a changed source", async () => {
    const config = mounted(credential());
    let fresh = true;
    try {
      publishMcpProviderPermissions(config, fact(), binding(), async () => fresh);
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toMatchObject({
        status: "valid",
      });
      fresh = false;
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      // The failed verification left a tombstone: the fact never falls back to valid again.
      fresh = true;
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("treats a throwing verifier as unavailable without leaking the error", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding(), async () => {
        throw new Error("secret source contents");
      });
      const read = await readMcpProviderPermissions(config, "run-1", binding());
      expect(read).toEqual({ status: "unavailable" });
      expect(JSON.stringify(read)).not.toContain("secret source contents");
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("rechecks the session after verification and refuses a cleared credential", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding(), async () => {
        clearMcpProviderSession(config.threadId);
        return true;
      });
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("stores no permissions for a payload that violates the closed wire contract", async () => {
    const config = mounted(credential());
    try {
      expect(
        publishMcpProviderPermissions(config, fact({ env: { KEY: "value" } }), binding()),
      ).toBe(1);
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toEqual({
        status: "unavailable",
      });
      expect(publishMcpProviderPermissions(config, fact(), binding())).toBe(2);
      expect(await readMcpProviderPermissions(config, "run-1", binding())).toMatchObject({
        status: "valid",
      });
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });

  it("exposes no endpoint or authorization material through the read result", async () => {
    const config = mounted(credential());
    try {
      publishMcpProviderPermissions(config, fact(), binding());
      const read = await readMcpProviderPermissions(config, "run-1", binding());
      const serialized = JSON.stringify(read);
      expect(serialized).not.toContain("private-proof-149");
      expect(serialized).not.toContain("private-endpoint");
      if (read.status === "valid") {
        expect(Object.keys(read.permissions).sort()).toEqual([
          "cwd",
          "driver",
          "interaction_mode",
          "provider_instance_id",
          "provider_policy",
          "provider_session_id",
          "revision",
          "run_id",
          "runtime_mode",
          "source",
          "version",
        ]);
      }
    } finally {
      clearMcpProviderSession(config.threadId);
    }
  });
});
