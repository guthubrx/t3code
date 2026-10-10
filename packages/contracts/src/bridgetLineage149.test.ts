import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  BridgetLineageCancelInput,
  BridgetLineageCancelResult,
  BridgetLineageDetail,
  BridgetLineageError,
  BridgetLineageJournal,
  BridgetLineageJournalInput,
  BridgetLineageReadInput,
  BridgetLineageSnapshot,
  BridgetLineageTask,
  BridgetLineageView,
  BridgetLineageWatchInput,
  BridgetNativeTaskStatus,
  BridgetTaskRef,
  bridgetTaskStatus,
} from "./bridgetLineage.ts";
import { WS_METHODS } from "./rpc.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope } from "./auth.ts";

const threadId = "8b09a229-dc14-4b38-91b5-2bf0e2a294ac";
const projectId = "project-1";
const context = { projectId, threadId };
const taskId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const parentTaskId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const childAgentId = "b1c2d3e4-5f60-4711-8293-a4b5c6d7e8f9";
const requestId = "9f8c3a52-7b1e-4d2a-b6c4-1e5f8a9d0c3b";
const generation = "c9bf9e57-1685-4c89-bafb-ff5af830be8a";
const maxSeq = Number.MAX_SAFE_INTEGER;
const maxUnix = 8_640_000_000_000;
const exact = (chars: number, fill = "x") => fill.repeat(chars);

const task = {
  task_id: taskId,
  parent_task_id: null,
  parent_agent_id: parentTaskId,
  child_agent_id: childAgentId,
  child_instance_id: null,
  created_at: 1_800_000_000,
  updated_at: 1_800_000_000,
  started_at: null,
  completed_at: null,
  agent_type: "codex",
  execution_protocol: "codex_app_server",
  model: "glm-5.3-flash",
  effort: null,
  cwd: "/tmp/project",
  posture: "development",
  title: "consigne bornée",
  status: "working",
  error: null,
  result_available: false,
  journal_available: false,
};
const decodeTask = Schema.decodeUnknownSync(BridgetLineageTask);
const decodeRef = Schema.decodeUnknownSync(BridgetTaskRef);
const decodeSnapshot = Schema.decodeUnknownSync(BridgetLineageSnapshot);
const decodeDetail = Schema.decodeUnknownSync(BridgetLineageDetail);
const decodeJournal = Schema.decodeUnknownSync(BridgetLineageJournal);
const decodeView = Schema.decodeUnknownSync(BridgetLineageView);
const decodeReadInput = Schema.decodeUnknownSync(BridgetLineageReadInput);
const decodeWatchInput = Schema.decodeUnknownSync(BridgetLineageWatchInput);
const decodeJournalInput = Schema.decodeUnknownSync(BridgetLineageJournalInput);
const decodeCancelInput = Schema.decodeUnknownSync(BridgetLineageCancelInput);
const decodeCancelResult = Schema.decodeUnknownSync(BridgetLineageCancelResult);
const decodeError = Schema.decodeUnknownSync(BridgetLineageError);

describe("S149-16 Bridget lineage task contract", () => {
  it("accepts the closed native task entry and exposes exactly the contracted keys", () => {
    expect(decodeTask(task)).toEqual(task);
    expect(Object.keys(decodeTask(task)).sort()).toEqual(Object.keys(task).sort());
    const decoded = decodeTask({ ...task, provider_session_id: "forged", provider_turn: "forged" });
    expect(Object.hasOwn(decoded as object, "provider_session_id")).toBe(false);
  });
  it("rejects noncanonical, non-36-char and uppercase UUIDs", () => {
    for (const field of ["task_id", "parent_agent_id", "child_agent_id"]) {
      for (const value of ["not-a-uuid", taskId.slice(0, 32), taskId.toUpperCase(), ""]) {
        expect(() => decodeTask({ ...task, [field]: value })).toThrow();
      }
    }
    expect(decodeTask({ ...task, parent_task_id: parentTaskId }).parent_task_id).toBe(parentTaskId);
  });
  it("rejects sequences beyond the JavaScript safe integer domain", () => {
    for (const seq of [-1, 0.5, maxSeq + 1, Number.NaN])
      expect(() => decodeTask({ ...task, created_at: seq })).toThrow();
    expect(decodeTask({ ...task, created_at: maxUnix }).created_at).toBe(maxUnix);
    expect(() => decodeTask({ ...task, created_at: maxUnix + 1 })).toThrow();
  });
  it("closes native status, posture and execution protocol to the frozen definitions", () => {
    for (const status of ["running", "pending", "completed", "", "WORKING"])
      expect(() => decodeTask({ ...task, status })).toThrow();
    for (const posture of ["inherit", "full-access", "readOnly"])
      expect(() => decodeTask({ ...task, posture })).toThrow();
    for (const protocol of ["claude_cli", "codex_exec", ""])
      expect(() => decodeTask({ ...task, execution_protocol: protocol })).toThrow();
  });
  it("rejects oversized free fields; the eponymous result rule stays a daemon guarantee", () => {
    // Transport schema only: lineage.md assigns "result_available only in the
    // eponymous native state" to the daemon snapshot, not to this validator.
    expect(() => decodeTask({ ...task, status: "queued", result_available: true })).not.toThrow();
    expect(decodeTask({ ...task, status: "result_available", result_available: true })).toEqual({
      ...task,
      status: "result_available",
      result_available: true,
    });
    expect(() => decodeTask({ ...task, title: exact(257) })).toThrow();
    expect(decodeTask({ ...task, title: exact(256) }).title).toHaveLength(256);
    expect(() => decodeTask({ ...task, error: exact(1025, "e") })).toThrow();
    expect(() => decodeTask({ ...task, cwd: exact(4097, "/") })).toThrow();
    expect(() => decodeTask({ ...task, model: exact(513) })).toThrow();
    expect(() => decodeTask({ ...task, child_instance_id: exact(2049) })).toThrow();
  });
});

describe("S149-16 Bridget task ref marker", () => {
  const marker = {
    version: 1,
    taskId,
    rootThreadId: threadId,
    parentTaskId: null,
    generation,
    seq: 42,
    status: "working",
  };
  it("accepts the camelCase marker for a root and a nested task", () => {
    expect(decodeRef(marker)).toEqual(marker);
    expect(decodeRef({ ...marker, parentTaskId: parentTaskId })).toEqual({
      ...marker,
      parentTaskId,
    });
  });
  it("closes version, identity, safe sequence and native status", () => {
    for (const version of [0, 2, "1"]) expect(() => decodeRef({ ...marker, version })).toThrow();
    expect(() => decodeRef({ ...marker, taskId: taskId.toUpperCase() })).toThrow();
    expect(() => decodeRef({ ...marker, generation: "generation" })).toThrow();
    expect(() => decodeRef({ ...marker, rootThreadId: "" })).toThrow();
    for (const seq of [-1, 0.5, maxSeq + 1]) expect(() => decodeRef({ ...marker, seq })).toThrow();
    expect(() => decodeRef({ ...marker, status: "running" })).toThrow();
  });
  it("strips unknown fields; malformed markers are closed by the Rust connector", () => {
    // Transport schema only: the strict refusal of an extra or snake_case field
    // belongs to the Rust connector (lineage.md projection, S149-22).
    const stripped = decodeRef({
      ...marker,
      root_thread_id: threadId,
      task_id: taskId,
      provider: "claude",
    }) as Record<string, unknown>;
    expect(stripped.taskId).toBe(taskId);
    expect(Object.hasOwn(stripped, "root_thread_id")).toBe(false);
    expect(Object.hasOwn(stripped, "provider")).toBe(false);
  });
});

describe("S149-27 lineage snapshot, detail and journal bounds", () => {
  const snapshot = {
    version: 1,
    status: "ok",
    generation,
    seq: maxSeq,
    root_owner_agent_id: childAgentId,
    tasks: [],
    next_cursor: null,
  };
  it("accepts an empty snapshot and closes version, status and the safe sequence", () => {
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeView(snapshot)).toEqual(snapshot);
    expect(() => decodeSnapshot({ ...snapshot, version: 2 })).toThrow();
    expect(() => decodeSnapshot({ ...snapshot, status: "partial" })).toThrow();
    expect(() => decodeSnapshot({ ...snapshot, seq: maxSeq + 1 })).toThrow();
    expect(() => decodeSnapshot({ ...snapshot, generation: "gen" })).toThrow();
  });
  it("bounds the task page to 4096 entries and the cursor to 2048 bytes", () => {
    const page = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...task, task_id: taskId, title: `t${i}` }));
    expect(decodeSnapshot({ ...snapshot, tasks: page(4096) }).tasks).toHaveLength(4096);
    expect(() => decodeSnapshot({ ...snapshot, tasks: page(4097) })).toThrow();
    expect(decodeSnapshot({ ...snapshot, next_cursor: exact(2048) }).next_cursor).toHaveLength(
      2048,
    );
    expect(() => decodeSnapshot({ ...snapshot, next_cursor: exact(2049) })).toThrow();
  });
  it("bounds the result window and total bytes on detail", () => {
    const detail = {
      version: 1,
      status: "ok",
      generation,
      seq: 1,
      root_owner_agent_id: childAgentId,
      task,
      result: null,
      result_offset: 0,
      result_next_offset: null,
      result_total_bytes: 0,
    };
    expect(decodeDetail(detail)).toEqual(detail);
    expect(decodeView(detail)).toEqual(detail);
    expect(() => decodeDetail({ ...detail, result: exact(16385, "r") })).toThrow();
    expect(() => decodeDetail({ ...detail, result_offset: -1 })).toThrow();
    expect(() => decodeDetail({ ...detail, result_total_bytes: 256 * 1024 + 1 })).toThrow();
    expect(decodeDetail({ ...detail, result_total_bytes: 256 * 1024 })).toEqual({
      ...detail,
      result_total_bytes: 256 * 1024,
    });
  });
  it("bounds the journal to 100 events with explicit gaps", () => {
    const event = {
      v: 1,
      seq: 1,
      ts: "2026-10-10T00:00:00Z",
      session_id: "session-1",
      event: "started",
      payload: { nonce: "a" },
    };
    const journal = {
      version: 1,
      status: "ok",
      task_id: taskId,
      events: [event],
      next_seq: 2,
      caught_up: true,
      gap: null,
    };
    expect(decodeJournal(journal)).toEqual(journal);
    expect(decodeView(journal)).toEqual(journal);
    expect(() =>
      decodeJournal({ ...journal, events: Array.from({ length: 101 }, () => ({ ...event })) }),
    ).toThrow();
    expect(
      decodeJournal({ ...journal, events: Array.from({ length: 100 }, () => ({ ...event })) })
        .events,
    ).toHaveLength(100);
    expect(() => decodeJournal({ ...journal, events: [{ ...event, v: 2 }] })).toThrow();
    expect(() =>
      decodeJournal({ ...journal, gap: { from_seq: -1, to_seq: 2, reason: "prune" } }),
    ).toThrow();
    expect(
      decodeJournal({ ...journal, gap: { from_seq: 3, to_seq: 5, reason: "prune" } }).gap,
    ).toEqual({
      from_seq: 3,
      to_seq: 5,
      reason: "prune",
    });
    expect(() => decodeJournal({ ...journal, events: [{ ...event, extra: "x" }] })).not.toThrow();
  });
});

describe("S149-27 lineage inputs close the human surface", () => {
  it("accepts list without limit or cursor and refuses every extra authority field", () => {
    expect(decodeReadInput({ ...context, action: "list" })).toEqual({ ...context, action: "list" });
    for (const field of ["taskId", "limit", "cursor", "afterSeq", "offset", "requestId"])
      expect(() => decodeReadInput({ ...context, action: "list", [field]: 1 })).toThrow();
    for (const forged of [
      "owner",
      "child",
      "path",
      "posture",
      "model",
      "provider_session",
      "permissions",
      "agentId",
    ])
      expect(() => decodeReadInput({ ...context, action: "list", [forged]: "forged" })).toThrow();
    expect(() => decodeReadInput({ ...context, action: "cancel" })).toThrow();
    expect(() => decodeReadInput({ ...context, action: "watch" })).toThrow();
  });
  it("accepts show with a canonical task and bounded offset and byte limit", () => {
    const show = { ...context, action: "show", taskId };
    expect(decodeReadInput(show)).toEqual(show);
    expect((decodeReadInput({ ...show, offset: maxSeq }) as { offset?: number }).offset).toBe(
      maxSeq,
    );
    expect(() => decodeReadInput({ ...show, offset: -1 })).toThrow();
    expect((decodeReadInput({ ...show, limit: 16384 }) as { limit?: number }).limit).toBe(16384);
    for (const limit of [0, 16385, 0.5])
      expect(() => decodeReadInput({ ...show, limit })).toThrow();
    expect(() => decodeReadInput({ ...context, action: "show" })).toThrow();
    expect(() => decodeReadInput({ ...show, taskId: "not-a-uuid" })).toThrow();
  });
  it("accepts journal reads with a safe afterSeq and a 1..100 limit", () => {
    const journalAction = { ...context, action: "journal", taskId };
    expect(decodeReadInput(journalAction)).toEqual(journalAction);
    expect(
      (decodeReadInput({ ...journalAction, afterSeq: 0 }) as { afterSeq?: number }).afterSeq,
    ).toBe(0);
    expect(() => decodeReadInput({ ...journalAction, afterSeq: 0.5 })).toThrow();
    expect((decodeReadInput({ ...journalAction, limit: 100 }) as { limit?: number }).limit).toBe(
      100,
    );
    for (const limit of [0, 101])
      expect(() => decodeReadInput({ ...journalAction, limit })).toThrow();
  });
  it("accepts the watch, journal and cancel inputs and refuses extra fields", () => {
    expect(decodeWatchInput(context)).toEqual(context);
    for (const field of ["taskId", "action", "limit", "follow"])
      expect(() => decodeWatchInput({ ...context, [field]: "x" })).toThrow();
    const journalInput = { ...context, taskId };
    expect(decodeJournalInput(journalInput)).toEqual(journalInput);
    expect(decodeJournalInput({ ...journalInput, afterSeq: 7 }).afterSeq).toBe(7);
    expect(() => decodeJournalInput({ ...journalInput, limit: 50 })).toThrow();
    const cancelInput = { ...context, taskId, requestId };
    expect(decodeCancelInput(cancelInput)).toEqual(cancelInput);
    expect(() => decodeCancelInput({ ...context, taskId })).toThrow();
    expect(() => decodeCancelInput({ ...cancelInput, requestId: "nope" })).toThrow();
    expect(() => decodeCancelInput({ ...cancelInput, force: true })).toThrow();
    expect(() => decodeCancelInput({ ...context, action: "list" })).toThrow();
  });
  it("requires a non-empty trimmed conversation context", () => {
    for (const broken of [
      { ...context, projectId: "" },
      { ...context, threadId: "  " },
    ])
      expect(() => decodeWatchInput(broken)).toThrow();
  });
});

describe("S149-16 lineage RPC namespace and scopes", () => {
  const lineageMethods = [
    "bridgetLineageRead",
    "bridgetLineageWatch",
    "bridgetLineageJournal",
    "bridgetLineageCancel",
  ] as const;
  it("exposes exactly the four bridget.lineage methods in WS_METHODS", () => {
    const expected = {
      bridgetLineageRead: "bridget.lineage.read",
      bridgetLineageWatch: "bridget.lineage.watch",
      bridgetLineageJournal: "bridget.lineage.journal",
      bridgetLineageCancel: "bridget.lineage.cancel",
    };
    for (const key of lineageMethods) expect(WS_METHODS[key]).toBe(expected[key]);
    expect(Object.keys(WS_METHODS).filter((key) => key.startsWith("bridgetLineage"))).toEqual([
      ...lineageMethods,
    ]);
    const existingBridgetKeys = Object.keys(WS_METHODS).filter(
      (key) => key.startsWith("bridget") && !key.startsWith("bridgetLineage"),
    );
    expect(existingBridgetKeys).toEqual(["bridgetRead", "bridgetWatch"]);
  });
  it("guards only cancel with the orchestration operate scope on the client", () => {
    expect(AuthOrchestrationOperateScope).toBe("orchestration:operate");
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.bridgetLineageCancel]).toBe(
      AuthOrchestrationOperateScope,
    );
    for (const key of [
      "bridgetLineageRead",
      "bridgetLineageWatch",
      "bridgetLineageJournal",
    ] as const)
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS[key])).toBe(false);
    expect(clientRpcRequiredScopes(WS_METHODS.bridgetLineageCancel, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    for (const method of [
      WS_METHODS.bridgetLineageRead,
      WS_METHODS.bridgetLineageWatch,
      WS_METHODS.bridgetLineageJournal,
    ])
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([]);
  });
});

describe("S149-16 lineage refusal codes and cancel receipt", () => {
  it("accepts exactly the contracted refusal codes and refuses unknown ones", () => {
    const contracted = [
      "unsupported_version",
      "invalid_request",
      "binding_unavailable",
      "project_mismatch",
      "task_unavailable",
      "snapshot_changed",
      "journal_unavailable",
      "result_offset_invalid",
      "envelope_mismatch",
      "resource_limit",
      "store_unavailable",
      "unavailable",
      "timeout",
      "invalid_output",
      "output_limit",
      "command_failed",
    ];
    for (const code of contracted) {
      const failure = decodeError({ _tag: "BridgetLineageError", code });
      expect(failure.code).toBe(code);
      expect(failure.message).toContain(code);
    }
    for (const code of ["forbidden", "task_not_found", "internal", ""])
      expect(() => decodeError({ _tag: "BridgetLineageError", code })).toThrow();
    expect(() =>
      decodeError({ _tag: "BridgetLineageError", code: "task_unavailable", extra: 1 }),
    ).not.toThrow();
  });
  it("validates the cancel receipt against the native task identity", () => {
    const receipt = { version: 1, task_id: taskId, status: "cancelling" };
    expect(decodeCancelResult(receipt)).toEqual(receipt);
    expect(() => decodeCancelResult({ ...receipt, status: "running" })).toThrow();
    expect(() => decodeCancelResult({ ...receipt, version: 2 })).toThrow();
    expect(() => decodeCancelResult({ ...receipt, result: "body" })).not.toThrow();
  });
});

describe("S149-16 presentation maps native states without a configured provider", () => {
  it("maps every native state to exactly its contracted presentation value", () => {
    const nativeStatuses = Schema.decodeUnknownSync(BridgetNativeTaskStatus);
    const expected: Array<[string, string]> = [
      ["queued", "pending"],
      ["starting", "pending"],
      ["mission_pending", "pending"],
      ["working", "running"],
      ["waiting_for_children", "waiting"],
      ["cancelling", "waiting"],
      ["result_available", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ];
    for (const [native, presentation] of expected)
      expect(bridgetTaskStatus(nativeStatuses(native))).toBe(presentation);
    expect(new Set(expected.map(([, presentation]) => presentation)).size).toBe(6);
    const allowed = new Set(["pending", "running", "waiting", "completed", "failed", "cancelled"]);
    for (const [native] of expected)
      expect(allowed.has(bridgetTaskStatus(nativeStatuses(native)))).toBe(true);
  });
});
