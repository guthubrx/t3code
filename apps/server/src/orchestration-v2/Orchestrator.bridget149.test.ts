// Session 149 — server lineage lot (L). Oracles: the virtual projection is provider-free,
// the read-only guard protects it, thread.stop cancels natives through the real BridgetReader
// without creating runs, and no transport means refusal with no fallback.
//
// t3149 FIXED by Sol: Orchestrator.ts:10212 now builds
// `ProviderInstanceId.make(\`bridget-task-${task.task_id}\`)` — a synthetic instance
// derived from the validated task UUID: slug-valid, injective per task, independent of
// agent_type. lineage.md does not fix the native instance format, so the sync oracle
// below asserts the chosen real format (slug rule, uniqueness, displayed native model,
// no provider run) while guards, stop and markers stay provable through the public
// projections.apply path seeded with the same exact shapes.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  BridgetLineageError,
  BridgetTaskRef,
  isProviderNativeSubagentThread,
  NodeId,
  OrchestrationV2Subagent,
  type BridgetLineageSnapshot,
  type BridgetLineageTask,
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BridgetReader from "../bridget/BridgetReader.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const uuid = (n: number) =>
  `${String(n % 100000000).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = ProjectId.make("project:bridget-149");
const rootId = ThreadId.make("thread:bridget-root-149");
const otherRootId = ThreadId.make("thread:bridget-other-149");
const childId = (taskIndex: number) => ThreadId.make(`thread:bridget-task:${uuid(taskIndex)}`);
const childA = childId(1);
const childB = childId(2);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;

interface HarnessOptions {
  /** Omit to run without a native transport: only Crypto stays injected. */
  readonly reader?: boolean;
  readonly snapshots?: ReadonlyArray<Effect.Effect<BridgetLineageSnapshot, BridgetLineageError>>;
  /** Defaults to the module adapter; the G5 matrix passes a counting dry adapter. */
  readonly adapter?: ProviderAdapterV2Shape;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const cancelInputs: Array<{
    readonly threadId: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly requestId: string;
  }> = [];
  const snapshotRequests: Array<{ readonly threadId: string; readonly projectId: string }> = [];
  const queue = [...(options.snapshots ?? [])];
  const stub = BridgetReader.BridgetReader.of({
    lineageSnapshot: (raw: { threadId: string; projectId: string }) => {
      snapshotRequests.push({ threadId: raw.threadId, projectId: raw.projectId });
      const next = queue.shift() ?? queue[queue.length - 1];
      return next ?? Effect.fail(new BridgetLineageError({ code: "unavailable" }));
    },
    lineageCancel: (raw: {
      threadId: string;
      projectId: string;
      taskId: string;
      requestId: string;
    }) => {
      cancelInputs.push({
        threadId: raw.threadId,
        projectId: raw.projectId,
        taskId: raw.taskId,
        requestId: raw.requestId,
      });
      return Effect.succeed({ version: 1, task_id: raw.taskId, status: "cancelling" });
    },
  } as unknown as BridgetReader.BridgetReader["Service"]);
  const base = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bridget-149" },
      ProviderAdapterRegistry.layerFromAdapters([options.adapter ?? adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
  const layer =
    options.reader === false
      ? base
      : Layer.provideMerge(
          base,
          Layer.mergeAll(Layer.succeed(BridgetReader.BridgetReader, stub), NodeCrypto.layer),
        );
  return { layer, cancelInputs, snapshotRequests };
};

const nativeTask = (overrides: Partial<BridgetLineageTask> = {}): BridgetLineageTask => ({
  task_id: uuid(1),
  parent_task_id: null,
  parent_agent_id: uuid(901),
  child_agent_id: uuid(101),
  child_instance_id: null,
  created_at: 1790000000,
  updated_at: 1790000001,
  started_at: 1790000001,
  completed_at: null,
  agent_type: "claude",
  execution_protocol: "claude_stream_json",
  model: "glm-5.3-flash",
  effort: null,
  cwd: "/repo",
  posture: "development",
  title: "Task A",
  status: "working",
  error: null,
  result_available: false,
  journal_available: true,
  ...overrides,
});
const nativeSnapshot = (
  tasks: BridgetLineageTask[],
  overrides: Partial<BridgetLineageSnapshot> = {},
): BridgetLineageSnapshot => ({
  version: 1,
  status: "ok",
  generation: uuid(900),
  seq: 7,
  root_owner_agent_id: uuid(901),
  tasks,
  next_cursor: null,
  ...overrides,
});
const ok = (snapshot: BridgetLineageSnapshot) => Effect.succeed(snapshot);
const createRoot = (orchestrator: Orchestrator.OrchestratorV2Shape, threadId: ThreadId) =>
  orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`bridget-149-create-${threadId.replace(/[^a-zA-Z0-9-]/g, "-")}`),
    threadId,
    projectId,
    title: "Root conversation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
const sync = (
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  snapshot: BridgetLineageSnapshot,
  tag: string,
) =>
  orchestrator.dispatch({
    type: "bridget.lineage.sync",
    commandId: CommandId.make(`bridget-149-sync-${tag}`),
    threadId,
    snapshot,
  });

const seedError = new BridgetLineageError({ code: "unavailable" });

/**
 * Applies exactly the events dispatchBridgetLineageSync emits, through the public
 * projection path, with the same synthetic bridget-task-<task UUID> instance ids and
 * native models the production sync writes.
 */
const seedVirtual = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  rootThreadId: ThreadId,
  tasks: BridgetLineageTask[],
  generation = uuid(900),
  seq = 7,
) =>
  Effect.gen(function* () {
    const root = yield* projections.getThread(rootThreadId);
    const now = yield* DateTime.now;
    let eventCounter = 0;
    const apply = (type: string, threadId: ThreadId, payload: unknown) =>
      projections.apply({
        id: EventId.make(`bridget-149-seed-${(eventCounter += 1)}`),
        type: type as never,
        threadId,
        occurredAt: now,
        payload: payload as never,
      });
    for (const task of tasks) {
      const childThreadId = ThreadId.make(`thread:bridget-task:${task.task_id}`);
      const parentThreadId =
        task.parent_task_id === null
          ? rootThreadId
          : ThreadId.make(`thread:bridget-task:${task.parent_task_id}`);
      const driver = ProviderDriverKind.make(
        task.execution_protocol === "codex_app_server" ? "codex" : "claudeAgent",
      );
      const taskInstanceId = ProviderInstanceId.make(`bridget-task-${task.task_id}`);
      const child = {
        ...root,
        createdBy: "agent",
        creationSource: "server",
        id: childThreadId,
        title: task.title.trim() || task.agent_type,
        providerInstanceId: taskInstanceId,
        modelSelection: { instanceId: taskInstanceId, model: task.model },
        activeProviderThreadId: null,
        worktreePath: task.cwd,
        branch: null,
        lineage: {
          parentThreadId,
          rootThreadId: root.lineage.rootThreadId,
          relationshipToParent: "subagent",
        },
        bridgetTaskRef: {
          version: 1,
          taskId: task.task_id,
          rootThreadId: rootThreadId,
          parentTaskId: task.parent_task_id,
          generation,
          seq,
          status: task.status,
        },
        bridgetTask: task,
        bridgetLineage: { generation, seq, available: true },
      };
      yield* apply("thread.created", childThreadId, child);
      yield* apply("subagent.updated", parentThreadId, {
        id: `node:bridget-task:${task.task_id}`,
        threadId: parentThreadId,
        runId: null,
        parentNodeId:
          task.parent_task_id === null
            ? `node:bridget-root:${rootThreadId}`
            : `node:bridget-task:${task.parent_task_id}`,
        origin: "bridget_native",
        createdBy: "agent",
        driver,
        providerInstanceId: taskInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "",
        title: task.title,
        model: task.model,
        modelSelection: { instanceId: taskInstanceId, model: task.model },
        status:
          task.status === "working"
            ? "running"
            : task.status === "result_available"
              ? "completed"
              : task.status === "failed"
                ? "failed"
                : task.status === "cancelled"
                  ? "cancelled"
                  : "pending",
        result: null,
        progress: task.error ?? task.status,
        startedAt: task.started_at === null ? null : DateTime.makeUnsafe(task.started_at * 1000),
        completedAt:
          task.completed_at === null ? null : DateTime.makeUnsafe(task.completed_at * 1000),
        updatedAt: DateTime.makeUnsafe(task.updated_at * 1000),
      });
    }
    yield* apply("thread.metadata-updated", rootThreadId, {
      ...root,
      bridgetLineage: { generation, seq, available: true },
    });
    return { generation, seq, seedError };
  });

describe("Orchestrator.bridget149 virtual projection", () => {
  it.effect("sync writes the exact virtual threads, markers and native subagents", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const taskA = nativeTask();
      const taskB = nativeTask({
        task_id: uuid(2),
        parent_task_id: uuid(1),
        parent_agent_id: uuid(101),
        child_agent_id: uuid(102),
        title: "Task B",
        // Arbitrary registry name (max 256, long + unicode): the synthetic instance
        // id must stay valid and independent of it.
        agent_type: `agenté-🎉-${"x".repeat(200)}`,
        model: "qwen3-coder",
      });
      yield* createRoot(orchestrator, rootId);
      const result = yield* sync(orchestrator, rootId, nativeSnapshot([taskA, taskB]), "initial");
      expect(result.storedEvents.map((stored) => stored.event.type)).toEqual([
        "thread.created",
        "subagent.updated",
        "thread.created",
        "subagent.updated",
        "thread.metadata-updated",
      ]);
      const storedA = yield* projections.getThread(childA);
      expect(storedA.createdBy).toBe("agent");
      expect(storedA.creationSource).toBe("server");
      expect(storedA.title).toBe("Task A");
      expect(storedA.activeProviderThreadId).toBeNull();
      expect(storedA.worktreePath).toBe("/repo");
      expect(storedA.branch).toBeNull();
      expect(storedA.runtimeMode).toBe("full-access");
      expect(storedA.lineage).toEqual({
        parentThreadId: rootId,
        rootThreadId: rootId,
        relationshipToParent: "subagent",
      });
      expect(storedA.bridgetTaskRef).toEqual({
        version: 1,
        taskId: uuid(1),
        rootThreadId: rootId,
        parentTaskId: null,
        generation: uuid(900),
        seq: 7,
        status: "working",
      });
      expect(storedA.bridgetTask).toEqual(taskA);
      // t3149 format oracle: the real production instance is the synthetic
      // bridget-task-<task UUID>, slug-valid, unique per task, never a configured
      // provider instance, and the displayed model stays the native task model.
      const expectedA = ProviderInstanceId.make(`bridget-task-${uuid(1)}`);
      expect(storedA.providerInstanceId).toBe(expectedA);
      expect(storedA.modelSelection).toEqual({ instanceId: expectedA, model: "glm-5.3-flash" });
      expect(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(expectedA)).toBe(true);
      expect(expectedA.length).toBeLessThanOrEqual(64);
      const records = yield* projections.getThreadRecords(childA, [
        "runs",
        "providerThreads",
        "turnItems",
      ]);
      expect(records.runs).toEqual([]);
      expect(records.providerThreads).toEqual([]);
      expect(records.turnItems).toEqual([]);
      const storedB = yield* projections.getThread(childB);
      const expectedB = ProviderInstanceId.make(`bridget-task-${uuid(2)}`);
      expect(storedB.providerInstanceId).toBe(expectedB);
      expect(expectedB).not.toBe(expectedA);
      expect(storedB.modelSelection).toEqual({ instanceId: expectedB, model: "qwen3-coder" });
      expect(storedB.lineage).toEqual({
        parentThreadId: childA,
        rootThreadId: rootId,
        relationshipToParent: "subagent",
      });
      const root = yield* projections.getThread(rootId);
      expect(root.bridgetLineage).toEqual({ generation: uuid(900), seq: 7, available: true });
      expect(root.bridgetTaskRef).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "the seeded virtual projection carries no provider session, run, turn item or outbox effect",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        yield* createRoot(orchestrator, rootId);
        yield* seedVirtual(projections, rootId, [
          nativeTask(),
          nativeTask({
            task_id: uuid(2),
            parent_task_id: uuid(1),
            parent_agent_id: uuid(101),
            child_agent_id: uuid(102),
            title: "Task B",
          }),
        ]);
        for (const thread of [childA, childB, rootId]) {
          const records = yield* projections.getThreadRecords(thread, [
            "runs",
            "providerThreads",
            "turnItems",
          ]);
          expect(records.runs).toEqual([]);
          expect(records.providerThreads).toEqual([]);
          expect(records.turnItems).toEqual([]);
        }
        const storedA = yield* projections.getThread(childA);
        expect(storedA.activeProviderThreadId).toBeNull();
        const outbox = yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox`;
        expect(Number((outbox[0] as { n: number | string }).n)).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("Orchestrator.bridget149 read-only guard", () => {
  const refusal = (command: Parameters<Orchestrator.OrchestratorV2Shape["dispatch"]>[0]) => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const failure = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestratorSubagentThreadReadOnlyError");
      expect((failure as { threadId: string }).threadId).toBe(childA);
    }).pipe(Effect.provide(h.layer));
  };
  // it.effect takes a lambda: passing the Effect directly suspends a non-function.
  it.effect("refuses message.dispatch on a virtual thread", () =>
    refusal({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("bridget-149-dispatch"),
      threadId: childA,
      messageId: MessageId.make("message-bridget-149"),
      text: "hello",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    }),
  );
  it.effect("refuses a fork targeting a virtual thread", () =>
    refusal({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("bridget-149-fork"),
      sourceThreadId: rootId,
      targetThreadId: childA,
      sourcePoint: { type: "latest_stable" },
    }),
  );
  it.effect("refuses provider.switch on a virtual thread", () =>
    refusal({
      type: "provider.switch",
      commandId: CommandId.make("bridget-149-switch"),
      threadId: childA,
      modelSelection,
    }),
  );
  it.effect("refuses checkpoint.rollback on a virtual thread", () =>
    refusal({
      type: "checkpoint.rollback",
      commandId: CommandId.make("bridget-149-rollback"),
      threadId: childA,
      scopeId: CheckpointScopeId.make("scope-bridget-149"),
      checkpointId: CheckpointId.make("checkpoint-bridget-149"),
    }),
  );
  it.effect("refuses queue.resume on a virtual thread", () =>
    refusal({
      type: "queue.resume",
      commandId: CommandId.make("bridget-149-resume"),
      threadId: childA,
    }),
  );
  it.effect("still allows thread.visit on a virtual thread", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("bridget-149-visit"),
        threadId: childA,
        visitedAt: "2026-10-10T00:00:00.000Z",
      });
    }).pipe(Effect.provide(h.layer));
  });
});

describe("Orchestrator.bridget149 native stop", () => {
  const seed = (projections: ProjectionStore.ProjectionStoreV2Shape, tasks: BridgetLineageTask[]) =>
    Effect.gen(function* () {
      yield* seedVirtual(projections, rootId, tasks);
      return nativeSnapshot(tasks);
    });
  const stopRoot = (orchestrator: Orchestrator.OrchestratorV2Shape, tag: string) =>
    orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`bridget-149-stop-${tag}`),
      threadId: rootId,
    });

  it.effect("stop on a virtual child cancels the native task once and creates nothing", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("bridget-149-stop-child"),
        threadId: childA,
      });
      expect(h.cancelInputs).toHaveLength(1);
      expect(h.cancelInputs[0]).toEqual({
        threadId: rootId,
        projectId,
        taskId: uuid(1),
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      });
      const records = yield* projections.getThreadRecords(childA, [
        "runs",
        "providerThreads",
        "turnItems",
      ]);
      expect(records.runs).toEqual([]);
      expect(records.providerThreads).toEqual([]);
      expect(records.turnItems).toEqual([]);
      const outbox = yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox`;
      expect(Number((outbox[0] as { n: number | string }).n)).toBe(0);
      const shell = yield* projections.getThreadShell(childA);
      expect(shell?.bridgetTaskRef).toBeDefined();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("stop on a virtual child without transport is refused with no fallback", () => {
    const h = makeHarness({ reader: false });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const failure = yield* orchestrator
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make("bridget-149-stop-notransport"),
          threadId: childA,
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestratorDispatchError");
      // No reader means no native cancel is even attempted (the harness base
      // always resolves Crypto, so the identity branch is unreachable here).
      expect((failure as { cause: string }).cause).toBe("Native Bridget transport is unavailable.");
      expect(h.cancelInputs).toEqual([]);
      const shell = yield* projections.getThreadShell(childA);
      expect(shell?.bridgetTaskRef).toBeDefined();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "stop on a parent with active children without transport is refused with no fallback",
    () => {
      const h = makeHarness({ reader: false });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* createRoot(orchestrator, rootId);
        yield* seedVirtual(projections, rootId, [
          nativeTask(),
          nativeTask({
            task_id: uuid(2),
            parent_task_id: uuid(1),
            parent_agent_id: uuid(101),
            child_agent_id: uuid(102),
            title: "Task B",
          }),
        ]);
        const failure = yield* stopRoot(orchestrator, "noreader").pipe(Effect.flip);
        expect(failure._tag).toBe("OrchestratorDispatchError");
        expect((failure as { cause: string }).cause).toBe(
          "Native Bridget transport is unavailable.",
        );
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("stop on the parent cancels only the task without an active ancestor", () => {
    const h = makeHarness({
      snapshots: [
        ok(
          nativeSnapshot([
            nativeTask(),
            nativeTask({
              task_id: uuid(2),
              parent_task_id: uuid(1),
              parent_agent_id: uuid(101),
              child_agent_id: uuid(102),
              title: "Task B",
            }),
          ]),
        ),
      ],
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seed(projections, [
        nativeTask(),
        nativeTask({
          task_id: uuid(2),
          parent_task_id: uuid(1),
          parent_agent_id: uuid(101),
          child_agent_id: uuid(102),
          title: "Task B",
        }),
      ]);
      yield* stopRoot(orchestrator, "parent");
      expect(h.cancelInputs).toHaveLength(1);
      expect(h.cancelInputs[0]!.taskId).toBe(uuid(1));
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("a failed ancestor still yields its independently active descendant", () => {
    const failedParent = nativeTask({
      status: "failed",
      completed_at: 1790000009,
      result_available: false,
    });
    const activeChild = nativeTask({
      task_id: uuid(4),
      parent_task_id: uuid(1),
      parent_agent_id: uuid(101),
      child_agent_id: uuid(104),
      title: "Task D",
    });
    const h = makeHarness({ snapshots: [ok(nativeSnapshot([failedParent, activeChild]))] });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seed(projections, [failedParent, activeChild]);
      yield* stopRoot(orchestrator, "failed");
      expect(h.cancelInputs).toHaveLength(1);
      expect(h.cancelInputs[0]!.taskId).toBe(uuid(4));
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("stop with only settled children needs no native call", () => {
    const settled = nativeTask({
      status: "result_available",
      completed_at: 1790000009,
      result_available: true,
    });
    const settledChild = nativeTask({
      task_id: uuid(2),
      parent_task_id: uuid(1),
      parent_agent_id: uuid(101),
      child_agent_id: uuid(102),
      title: "Task B",
      status: "result_available",
      completed_at: 1790000009,
      result_available: true,
    });
    const h = makeHarness({ snapshots: [ok(nativeSnapshot([settled, settledChild]))] });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seed(projections, [settled, settledChild]);
      yield* stopRoot(orchestrator, "settled");
      expect(h.cancelInputs).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("stop on a plain thread never needs a reader", () => {
    const h = makeHarness({ reader: false });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createRoot(orchestrator, rootId);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("bridget-149-stop-plain"),
        threadId: rootId,
      });
    }).pipe(Effect.provide(h.layer));
  });
});

describe("Orchestrator.bridget149 sync validation", () => {
  const expectRefused = (
    tag: string,
    tasks: BridgetLineageTask[],
    cause: string,
    overrides: Partial<BridgetLineageSnapshot> = {},
  ) => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      const failure = yield* sync(orchestrator, rootId, nativeSnapshot(tasks, overrides), tag).pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("OrchestratorDispatchError");
      expect((failure as { cause: string }).cause).toBe(cause);
      expect(yield* projections.getBridgetTaskThreads(rootId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  };
  it.effect("refuses duplicate task ids atomically", () =>
    expectRefused(
      "duplicates",
      [nativeTask(), nativeTask()],
      "An atomic, unique native snapshot is required.",
    ),
  );
  it.effect("refuses a non-null staging cursor", () =>
    expectRefused("cursor", [nativeTask()], "An atomic, unique native snapshot is required.", {
      next_cursor: "cursor-1",
    }),
  );
  it.effect("refuses a root task owned by a foreign agent", () =>
    expectRefused(
      "root-owner",
      [nativeTask({ parent_agent_id: uuid(999) })],
      "Invalid native parent ownership.",
    ),
  );
  it.effect("refuses a nested task with an unknown parent", () =>
    expectRefused(
      "unknown-parent",
      [nativeTask({ parent_task_id: uuid(42), parent_agent_id: uuid(999) })],
      "Invalid native parent ownership.",
    ),
  );
  it.effect("refuses a nested task owned by a foreign agent", () =>
    expectRefused(
      "nested-owner",
      [
        nativeTask(),
        nativeTask({
          task_id: uuid(2),
          parent_task_id: uuid(1),
          parent_agent_id: uuid(999),
          title: "Task B",
        }),
      ],
      "Invalid native parent ownership.",
    ),
  );
  it.effect("refuses a two-task cycle", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      const failure = yield* sync(
        orchestrator,
        rootId,
        nativeSnapshot([
          nativeTask({ parent_task_id: uuid(2), parent_agent_id: uuid(102) }),
          nativeTask({
            task_id: uuid(2),
            parent_task_id: uuid(1),
            parent_agent_id: uuid(101),
            child_agent_id: uuid(102),
            title: "Task B",
          }),
        ]),
        "cycle",
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestratorDispatchError");
      expect((failure as { cause: string }).cause).toBe("Invalid native task ancestry.");
      expect(yield* projections.getBridgetTaskThreads(rootId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses a ten-task ancestry beyond the depth bound", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      const chain = Array.from({ length: 10 }, (_, index) =>
        nativeTask({
          task_id: uuid(300 + index),
          parent_task_id: index === 0 ? null : uuid(300 + index - 1),
          parent_agent_id: index === 0 ? uuid(901) : uuid(200 + index - 1),
          child_agent_id: uuid(200 + index),
          title: `Task ${index + 1}`,
        }),
      );
      const failure = yield* sync(orchestrator, rootId, nativeSnapshot(chain), "depth").pipe(
        Effect.flip,
      );
      expect(failure._tag).toBe("OrchestratorDispatchError");
      expect((failure as { cause: string }).cause).toBe("Invalid native task ancestry.");
      expect(yield* projections.getBridgetTaskThreads(rootId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses a sync that targets a virtual thread as its root", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const failure = yield* sync(
        orchestrator,
        childA,
        nativeSnapshot([nativeTask({ task_id: uuid(9), child_agent_id: uuid(109) })]),
        "nested-root",
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestratorDispatchError");
      expect((failure as { cause: string }).cause).toBe("A live root conversation is required.");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses to adopt a task that already belongs to another root", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* createRoot(orchestrator, otherRootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const failure = yield* sync(
        orchestrator,
        otherRootId,
        nativeSnapshot([nativeTask()]),
        "foreign",
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("OrchestratorDispatchError");
      expect((failure as { cause: string }).cause).toBe("Native task belongs to a different root.");
      expect(yield* projections.getBridgetTaskThreads(otherRootId)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("Orchestrator.bridget149 marker persistence", () => {
  it.effect("unavailable preserves threads and markers and only flips availability", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const down = yield* orchestrator.dispatch({
        type: "bridget.lineage.unavailable",
        commandId: CommandId.make("bridget-149-down"),
        threadId: rootId,
      });
      expect(down.storedEvents.map((stored) => stored.event.type)).toEqual([
        "thread.metadata-updated",
        "thread.metadata-updated",
      ]);
      const child = yield* projections.getThread(childA);
      expect(child.bridgetTaskRef).toBeDefined();
      expect(child.bridgetLineage).toEqual({ generation: uuid(900), seq: 7, available: false });
      expect((yield* projections.getThread(rootId)).bridgetLineage?.available).toBe(false);
      expect(
        (yield* orchestrator.dispatch({
          type: "bridget.lineage.unavailable",
          commandId: CommandId.make("bridget-149-down-again"),
          threadId: rootId,
        })).storedEvents,
      ).toEqual([]);
      expect((yield* projections.getBridgetTaskThreads(rootId)).map((thread) => thread.id)).toEqual(
        [childA],
      );
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("another root and its plain children stay untouched", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* createRoot(orchestrator, otherRootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      const other = yield* projections.getThread(otherRootId);
      expect(other.bridgetTaskRef).toBeUndefined();
      expect(other.bridgetLineage).toBeUndefined();
      expect(yield* projections.getBridgetTaskThreads(otherRootId)).toEqual([]);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("bridget-149-resume-other"),
        threadId: otherRootId,
      });
    }).pipe(Effect.provide(h.layer));
  });
});

// Session 149 r3 — sync writes only what changed. The root owns the snapshot watermark;
// an unchanged child keeps its last verified marker; only task facts reach subagent.updated.
describe("Orchestrator.bridget149 sync delta", () => {
  const taskA = () => nativeTask();
  const taskB = () =>
    nativeTask({
      task_id: uuid(2),
      parent_task_id: uuid(1),
      parent_agent_id: uuid(101),
      child_agent_id: uuid(102),
      title: "Task B",
    });
  const taskC = () => nativeTask({ task_id: uuid(3), child_agent_id: uuid(103), title: "Task C" });
  const taskD = () => nativeTask({ task_id: uuid(4), child_agent_id: uuid(104), title: "Task D" });
  const all = () => [taskA(), taskB(), taskC(), taskD()];
  const types = (result: {
    readonly storedEvents: ReadonlyArray<{ readonly event: { readonly type: string } }>;
  }) => result.storedEvents.map((stored) => stored.event.type);
  const count = (list: ReadonlyArray<string>, type: string) =>
    list.filter((entry) => entry === type).length;

  it.effect("a journal tick (same facts, new seq) writes the root watermark only", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* sync(orchestrator, rootId, nativeSnapshot(all()), "tick-0");
      const tick = yield* sync(orchestrator, rootId, nativeSnapshot(all(), { seq: 8 }), "tick-1");
      expect(types(tick)).toEqual(["thread.metadata-updated"]);
      expect(tick.storedEvents[0]?.event).toMatchObject({ threadId: rootId });
      expect((yield* projections.getThread(rootId)).bridgetLineage).toEqual({
        generation: uuid(900),
        seq: 8,
        available: true,
      });
      // The unchanged children keep their last verified marker (seq 7), not the root watermark.
      expect((yield* projections.getThread(childId(3))).bridgetTaskRef?.seq).toBe(7);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("one changed task among four writes that task alone plus the root", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* sync(orchestrator, rootId, nativeSnapshot(all()), "one-0");
      const changed = [
        taskA(),
        taskB(),
        nativeTask({
          task_id: uuid(3),
          child_agent_id: uuid(103),
          title: "Task C",
          status: "result_available",
          updated_at: 1790000050,
          completed_at: 1790000050,
          result_available: true,
        }),
        taskD(),
      ];
      const result = yield* sync(
        orchestrator,
        rootId,
        nativeSnapshot(changed, { seq: 8 }),
        "one-1",
      );
      const list = types(result);
      expect(count(list, "subagent.updated")).toBe(1);
      expect(count(list, "thread.created")).toBe(0);
      // Task C metadata + root watermark; the one subagent.updated lands on C's parent (the root).
      expect(count(list, "thread.metadata-updated")).toBe(2);
      expect(
        result.storedEvents.map((stored) => (stored.event as { threadId: string }).threadId).sort(),
      ).toEqual([childId(3), rootId, rootId].sort());
      expect((yield* projections.getThread(childId(3))).bridgetTaskRef).toMatchObject({
        seq: 8,
        status: "result_available",
      });
      expect((yield* projections.getThread(childId(4))).bridgetTaskRef?.seq).toBe(7);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "a new generation with unchanged facts rewrites markers without any subagent update",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* createRoot(orchestrator, rootId);
        yield* sync(orchestrator, rootId, nativeSnapshot(all()), "gen-0");
        const result = yield* sync(
          orchestrator,
          rootId,
          nativeSnapshot(all(), { generation: uuid(999), seq: 1 }),
          "gen-1",
        );
        const list = types(result);
        expect(count(list, "subagent.updated")).toBe(0);
        expect(count(list, "thread.created")).toBe(0);
        expect(count(list, "thread.metadata-updated")).toBe(5);
        for (const index of [1, 2, 3, 4]) {
          expect((yield* projections.getThread(childId(index))).bridgetTaskRef).toMatchObject({
            generation: uuid(999),
            seq: 1,
          });
        }
        expect((yield* projections.getThread(rootId)).bridgetLineage).toEqual({
          generation: uuid(999),
          seq: 1,
          available: true,
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "a complete identical snapshot restores availability at the same seq without duplicates",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* createRoot(orchestrator, rootId);
        yield* sync(orchestrator, rootId, nativeSnapshot(all()), "restore-0");
        yield* orchestrator.dispatch({
          type: "bridget.lineage.unavailable",
          commandId: CommandId.make("bridget-149-restore-down"),
          threadId: rootId,
        });
        expect((yield* projections.getThread(rootId)).bridgetLineage?.available).toBe(false);
        const restored = yield* sync(orchestrator, rootId, nativeSnapshot(all()), "restore-1");
        const list = types(restored);
        expect(count(list, "subagent.updated")).toBe(0);
        expect(count(list, "thread.created")).toBe(0);
        expect(count(list, "thread.metadata-updated")).toBe(5);
        expect((yield* projections.getThread(rootId)).bridgetLineage).toEqual({
          generation: uuid(900),
          seq: 7,
          available: true,
        });
        for (const index of [1, 2, 3, 4]) {
          expect((yield* projections.getThread(childId(index))).bridgetLineage?.available).toBe(
            true,
          );
        }
        // A second identical snapshot is idempotent: nothing to write.
        expect(
          types(yield* sync(orchestrator, rootId, nativeSnapshot(all()), "restore-2")),
        ).toEqual([]);
        expect((yield* projections.getBridgetTaskThreads(rootId)).length).toBe(4);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("a stale seq on the same generation writes nothing", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* sync(orchestrator, rootId, nativeSnapshot(all(), { seq: 9 }), "stale-0");
      const stale = yield* sync(
        orchestrator,
        rootId,
        nativeSnapshot([taskA()], { seq: 8 }),
        "stale-1",
      );
      expect(types(stale)).toEqual([]);
      expect((yield* projections.getBridgetTaskThreads(rootId)).length).toBe(4);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "a task absent from a complete snapshot keeps its history and turns unavailable; a partial snapshot changes nothing",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* createRoot(orchestrator, rootId);
        yield* sync(orchestrator, rootId, nativeSnapshot(all()), "gone-0");
        // Partial snapshot (cursor still open): refused, projection untouched.
        const refused = yield* sync(
          orchestrator,
          rootId,
          nativeSnapshot([taskA()], { seq: 8, next_cursor: "more" }),
          "gone-partial",
        ).pipe(Effect.flip);
        expect((refused as { cause: string }).cause).toBe(
          "An atomic, unique native snapshot is required.",
        );
        expect((yield* projections.getThread(rootId)).bridgetLineage).toEqual({
          generation: uuid(900),
          seq: 7,
          available: true,
        });
        expect((yield* projections.getThread(childId(4))).bridgetLineage?.available).toBe(true);
        // Complete snapshot without D: D keeps its verified task and marker, but is no longer available.
        const complete = yield* sync(
          orchestrator,
          rootId,
          nativeSnapshot([taskA(), taskB(), taskC()], { seq: 8 }),
          "gone-1",
        );
        expect(count(types(complete), "subagent.updated")).toBe(0);
        const kept = yield* projections.getThread(childId(4));
        expect(kept.bridgetTask).toEqual(taskD());
        expect(kept.bridgetTaskRef).toMatchObject({ taskId: uuid(4), seq: 7 });
        expect(kept.bridgetLineage).toEqual({ generation: uuid(900), seq: 8, available: false });
        expect((yield* projections.getBridgetTaskThreads(rootId)).length).toBe(4);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("unavailable on one virtual child leaves its siblings and the root available", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* sync(orchestrator, rootId, nativeSnapshot(all()), "child-down-0");
      yield* orchestrator.dispatch({
        type: "bridget.lineage.unavailable",
        commandId: CommandId.make("bridget-149-child-down"),
        threadId: childId(4),
      });
      expect((yield* projections.getThread(childId(4))).bridgetLineage?.available).toBe(false);
      for (const sibling of [childId(1), childId(2), childId(3)]) {
        expect((yield* projections.getThread(sibling)).bridgetLineage?.available).toBe(true);
      }
      expect((yield* projections.getThread(rootId)).bridgetLineage?.available).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });
});

// Gap G5 (spec 149, T035). The three subagent origins meet four branches that
// read `origin`: start (a message sent to the child thread), resume (startup
// recovery), result delivery ("remise": the completion-delivery commands) and
// the outbox (what a Stop enqueues and what its effect later executes). Every
// cell below goes through the real producer (`delegated_task.request`,
// `bridget.lineage.sync`, or the projection events the provider ingestor
// writes for a provider-native subagent) and the real consumer
// (`message.dispatch`, `ProviderRuntimeRecoveryService`, the delivery commands,
// `run.interrupt` + `ThreadManagementService.stopDelegatedTasks`). The sinks
// are SQL row counts and a counting dry provider, never a real auth or model:
// `openSession` is never reached, and a `provider-turn.start` outbox row is
// the only way a provider turn can start.
type OriginName = "app_owned" | "provider_native" | "bridget_native";
const ORIGINS: ReadonlyArray<OriginName> = ["app_owned", "provider_native", "bridget_native"];
const providerNativeChildId = ThreadId.make("thread:provider-native-child-149");
const providerNativeNodeId = NodeId.make("node:provider-native-149");

const makeCountingAdapter = () => {
  const calls = { getCapabilities: 0, planSelectionTransition: 0, openSession: 0 };
  const counting = {
    ...adapter,
    getCapabilities: () => {
      calls.getCapabilities += 1;
      return Effect.succeed(CodexProviderCapabilitiesV2);
    },
    planSelectionTransition: () => {
      calls.planSelectionTransition += 1;
      return Effect.succeed({ type: "apply_on_next_turn" as const });
    },
    openSession: () => {
      calls.openSession += 1;
      return Effect.die("dry fake provider: no session may open in the origin matrix");
    },
  } as ProviderAdapterV2Shape;
  return { calls, counting };
};

const makeMatrixLayer = () => {
  const { calls, counting } = makeCountingAdapter();
  const h = makeHarness({ adapter: counting });
  const layerRecoveryDeps = Layer.mergeAll(
    ServerSettings.layerTest().pipe(Layer.orDie),
    IdAllocator.layer,
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  );
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provideMerge(layerRecoveryDeps),
    Layer.provideMerge(ThreadManagementService.layer),
    Layer.provideMerge(h.layer),
  );
  return { layer, calls, cancelInputs: h.cancelInputs };
};

const sendTo = (
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  tag: string,
  type: "start_immediately" | "queue_after_active",
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`bridget-149-matrix-send-${tag}`),
    threadId,
    messageId: MessageId.make(`message-bridget-149-matrix-${tag}`),
    text: tag,
    attachments: [],
    dispatchMode: { type },
    createdBy: "user",
    creationSource: "web",
  });

/** The sinks every cell reads: provider runs/threads/turns/sessions and the whole outbox. */
const readSinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs =
    yield* sql`SELECT thread_id, status FROM orchestration_v2_projection_runs ORDER BY thread_id, run_id`;
  const providerThreads =
    yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`;
  const turns =
    yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_turns ORDER BY provider_turn_id`;
  const sessions =
    yield* sql`SELECT thread_id FROM orchestration_v2_projection_provider_sessions ORDER BY provider_session_id`;
  const effects =
    yield* sql`SELECT thread_id, effect_type, status FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
  return {
    runs: runs as ReadonlyArray<{ thread_id: string; status: string }>,
    providerThreads: providerThreads as ReadonlyArray<{ thread_id: string }>,
    turns: turns as ReadonlyArray<{ thread_id: string }>,
    sessions: sessions as ReadonlyArray<{ thread_id: string | null }>,
    effects: effects as ReadonlyArray<{ thread_id: string; effect_type: string; status: string }>,
  };
});
/** Provider threads, turns and sessions owned by `threadId`: none may exist for a virtual thread. */
const providerRowsOf = (sinks: Effect.Success<typeof readSinks>, threadId: ThreadId) => ({
  providerThreads: sinks.providerThreads.filter((row) => row.thread_id === threadId).length,
  turns: sinks.turns.filter((row) => row.thread_id === threadId).length,
  sessions: sinks.sessions.filter((row) => row.thread_id === threadId).length,
});
const runsOf = (
  sinks: { runs: ReadonlyArray<{ thread_id: string; status: string }> },
  threadId: ThreadId,
) => sinks.runs.filter((row) => row.thread_id === threadId).map((row) => row.status);
const effectsOf = (
  sinks: { effects: ReadonlyArray<{ thread_id: string; effect_type: string }> },
  threadId: ThreadId,
) => sinks.effects.filter((row) => row.thread_id === threadId).map((row) => row.effect_type);

/**
 * Root conversation with a started parent run, then one child of `origin` made
 * by the real producer of that origin. Returns the ids the cells need.
 */
const seedMatrix = (origin: OriginName) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createRoot(orchestrator, rootId);
    yield* sendTo(orchestrator, rootId, "root-work", "start_immediately");
    const parentRun = (yield* orchestrator.getThreadProjection(rootId)).runs.at(-1)!;
    let childThreadId: ThreadId;
    let taskId: NodeId;
    if (origin === "app_owned") {
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("bridget-149-matrix-delegate"),
        parentThreadId: rootId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "app owned task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = (yield* orchestrator.getThreadProjection(rootId)).subagents.find(
        (candidate) => candidate.origin === "app_owned",
      )!;
      childThreadId = task.childThreadId!;
      taskId = task.id;
    } else if (origin === "provider_native") {
      const root = yield* projections.getThread(rootId);
      const now = yield* DateTime.now;
      let counter = 0;
      const apply = (type: string, threadId: ThreadId, payload: unknown) =>
        projections.apply({
          id: EventId.make(`bridget-149-matrix-provider-${(counter += 1)}`),
          type: type as never,
          threadId,
          runId: (payload as { runId?: unknown }).runId as never,
          occurredAt: now,
          payload: payload as never,
        });
      const driver = ProviderDriverKind.make("codex");
      // The same shapes the Codex adapter emits through ProviderEventIngestor
      // (`app_thread.created`, `node.updated`, `subagent.updated`).
      yield* apply(
        "thread.created",
        providerNativeChildId,
        makeSubagentChildThread({
          parentThread: root,
          childThreadId: providerNativeChildId,
          parentNodeId: providerNativeNodeId,
          activeProviderThreadId: null,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          title: "Provider native child",
          now,
          createdBy: "agent",
          creationSource: "provider",
        }),
      );
      yield* apply("node.updated", rootId, {
        id: providerNativeNodeId,
        threadId: rootId,
        runId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        rootNodeId: parentRun.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      });
      yield* apply("subagent.updated", rootId, {
        id: providerNativeNodeId,
        threadId: rootId,
        runId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: providerNativeChildId,
        nativeTaskRef: null,
        prompt: "native task",
        title: null,
        model: modelSelection.model,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      });
      childThreadId = providerNativeChildId;
      taskId = providerNativeNodeId;
    } else {
      yield* sync(orchestrator, rootId, nativeSnapshot([nativeTask()]), "matrix");
      childThreadId = childA;
      taskId = NodeId.make(`node:bridget-task:${uuid(1)}`);
    }
    const subagent = (yield* orchestrator.getThreadProjection(rootId)).subagents.find(
      (candidate) => candidate.id === taskId,
    )!;
    expect(subagent.origin).toBe(origin);
    return { orchestrator, projections, parentRun, childThreadId, taskId };
  });

describe("Orchestrator.bridget149 origin matrix (T035 gap G5)", () => {
  it.effect.each(ORIGINS)("start: a message to the %s child", (origin) => {
    const m = makeMatrixLayer();
    return Effect.gen(function* () {
      const s = yield* seedMatrix(origin);
      const before = yield* readSinks;
      const outcome = yield* sendTo(
        s.orchestrator,
        s.childThreadId,
        "to-child",
        "queue_after_active",
      ).pipe(Effect.exit);
      const after = yield* readSinks;
      const child = yield* s.projections.getThread(s.childThreadId);
      if (origin === "app_owned") {
        // Normal branch: the delegation producer already started the child
        // (one provider-turn.start row); a second message queues behind it.
        expect(outcome._tag).toBe("Success");
        expect(runsOf(before, s.childThreadId)).toEqual(["starting"]);
        expect(effectsOf(before, s.childThreadId)).toEqual(["provider-turn.start"]);
        expect(runsOf(after, s.childThreadId)).toEqual(["starting", "queued"]);
        expect(isProviderNativeSubagentThread(child)).toBe(false);
        expect(child.bridgetTaskRef).toBeUndefined();
      } else {
        // Provider-native refuses by its creation source, Bridget-native by
        // its marker: the Bridget child is NOT provider-native, so only the
        // canonical `bridgetTaskRef` can explain its refusal.
        expect(outcome._tag).toBe("Failure");
        const failure = outcome._tag === "Failure" ? JSON.stringify(outcome.cause) : "";
        expect(failure).toContain("OrchestratorSubagentThreadReadOnlyError");
        expect(runsOf(after, s.childThreadId)).toEqual([]);
        expect(effectsOf(after, s.childThreadId)).toEqual([]);
        expect(after).toEqual(before);
        expect(isProviderNativeSubagentThread(child)).toBe(origin === "provider_native");
        expect(child.bridgetTaskRef !== undefined).toBe(origin === "bridget_native");
      }
      expect(providerRowsOf(after, s.childThreadId)).toEqual(
        origin === "app_owned"
          ? providerRowsOf(before, s.childThreadId)
          : { providerThreads: 0, turns: 0, sessions: 0 },
      );
      expect(after.sessions).toEqual([]);
      expect(m.calls.openSession).toBe(0);
    }).pipe(Effect.provide(m.layer));
  });
});

describe("Orchestrator.bridget149 origin matrix: resume, delivery and outbox", () => {
  it.effect.each(ORIGINS)("resume: startup recovery with a %s child", (origin) => {
    const m = makeMatrixLayer();
    return Effect.gen(function* () {
      const s = yield* seedMatrix(origin);
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const beforeSinks = yield* readSinks;
      const childBefore = yield* s.projections.getThread(s.childThreadId);
      const taskBefore = (yield* s.orchestrator.getThreadProjection(rootId)).subagents.find(
        (task) => task.id === s.taskId,
      )!;
      const summary = yield* recovery.recover;
      const resumed = yield* s.orchestrator.resumeQueuedRuns;
      const afterSinks = yield* readSinks;
      const rootAfter = yield* s.orchestrator.getThreadProjection(rootId);
      const taskAfter = rootAfter.subagents.find((task) => task.id === s.taskId)!;
      // The parent run was `starting`: recovery cancels it for every origin.
      expect(runsOf(beforeSinks, rootId)).toEqual(["starting"]);
      expect(runsOf(afterSinks, rootId)).toEqual(["cancelled"]);
      expect(summary.terminalizedRuns).toBeGreaterThanOrEqual(1);
      expect(resumed).toBe(0);
      if (origin === "app_owned") {
        // A delegated task stays open: its child thread settles it.
        expect(taskAfter.status).toBe("running");
        expect(runsOf(afterSinks, s.childThreadId)).toEqual(["cancelled"]);
      } else if (origin === "provider_native") {
        // Provider background work dies with the provider process.
        expect(taskAfter.status).toBe("cancelled");
      } else {
        // Native work belongs to Bridget, not to a T3 provider process:
        // recovery leaves the record and its virtual thread untouched.
        expect(taskAfter).toEqual(taskBefore);
        expect(taskAfter.status).toBe("running");
        expect(taskAfter.runId).toBeNull();
        expect(yield* s.projections.getThread(s.childThreadId)).toEqual(childBefore);
        expect(runsOf(afterSinks, s.childThreadId)).toEqual([]);
        expect(effectsOf(afterSinks, s.childThreadId)).toEqual([]);
        expect(providerRowsOf(afterSinks, s.childThreadId)).toEqual({
          providerThreads: 0,
          turns: 0,
          sessions: 0,
        });
      }
      expect(m.calls.openSession).toBe(0);
    }).pipe(Effect.provide(m.layer));
  });

  it.effect.each(ORIGINS)("remise: result delivery acknowledge for the %s task", (origin) => {
    const m = makeMatrixLayer();
    return Effect.gen(function* () {
      const s = yield* seedMatrix(origin);
      const before = yield* readSinks;
      const taskBefore = (yield* s.orchestrator.getThreadProjection(rootId)).subagents.find(
        (task) => task.id === s.taskId,
      )!;
      const outcome = yield* s.orchestrator
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`bridget-149-matrix-ack-${origin}`),
          parentThreadId: rootId,
          taskId: s.taskId,
          observedByRunId: s.parentRun.id,
        })
        .pipe(Effect.exit);
      const after = yield* readSinks;
      const taskAfter = (yield* s.orchestrator.getThreadProjection(rootId)).subagents.find(
        (task) => task.id === s.taskId,
      )!;
      if (origin === "app_owned") {
        expect(outcome._tag).toBe("Success");
        expect(taskAfter.completionDelivery).toEqual({
          state: "acknowledged",
          observedByRunId: s.parentRun.id,
        });
      } else {
        // Only an app-owned task has a result to deliver to its parent.
        expect(outcome._tag).toBe("Failure");
        expect(JSON.stringify(outcome._tag === "Failure" ? outcome.cause : "")).toContain(
          "is not an app-owned task",
        );
        expect(taskAfter).toEqual(taskBefore);
        expect(taskAfter.completionDelivery).toBeUndefined();
        expect(after).toEqual(before);
      }
      expect(m.calls.openSession).toBe(0);
    }).pipe(Effect.provide(m.layer));
  });

  it.effect.each(ORIGINS)(
    "outbox: Stop on the parent run and its executed effect with a %s child",
    (origin) => {
      const m = makeMatrixLayer();
      return Effect.gen(function* () {
        const s = yield* seedMatrix(origin);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const stopId = CommandId.make(`bridget-149-matrix-stop-${origin}`);
        // The parent turn is running but its provider session is gone, as in
        // ThreadStop.test.ts: Stop settles it locally, which runs the
        // run-owned subagent cascade (the one line whose meaning changed).
        const live = yield* s.orchestrator.getThreadProjection(rootId);
        const liveRun = live.runs.find((run) => run.id === s.parentRun.id)!;
        const liveAttempt = live.attempts.find(
          (attempt) => attempt.id === liveRun.activeAttemptId,
        )!;
        const now = yield* DateTime.now;
        yield* s.projections.apply({
          id: EventId.make("event:matrix-live-run"),
          type: "run.updated",
          threadId: rootId,
          runId: liveRun.id,
          occurredAt: now,
          payload: { ...liveRun, status: "running", startedAt: now },
        });
        yield* s.projections.apply({
          id: EventId.make("event:matrix-live-attempt"),
          type: "run-attempt.updated",
          threadId: rootId,
          runId: liveRun.id,
          nodeId: liveRun.rootNodeId!,
          occurredAt: now,
          payload: { ...liveAttempt, status: "running" },
        });
        yield* s.projections.apply({
          id: EventId.make("event:matrix-live-turn"),
          type: "provider-turn.updated",
          threadId: rootId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("provider-turn:matrix"),
            providerThreadId: liveRun.providerThreadId!,
            nodeId: liveRun.rootNodeId!,
            runAttemptId: liveRun.activeAttemptId!,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
        const before = yield* readSinks;
        const childBefore = yield* s.projections.getThread(s.childThreadId);
        yield* s.orchestrator.dispatch({
          type: "run.interrupt",
          commandId: stopId,
          threadId: rootId,
          runId: s.parentRun.id,
          holdQueue: true,
        });
        const sql = yield* SqlClient.SqlClient;
        const stopEffects =
          (yield* sql`SELECT thread_id, effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopId}`) as ReadonlyArray<{
            thread_id: string;
            effect_type: string;
          }>;
        // The enqueue side: one `delegated-tasks.stop` on the parent for every
        // origin, and never any effect addressed to the virtual thread.
        expect(
          stopEffects
            .filter((row) => row.effect_type === "delegated-tasks.stop")
            .map((row) => row.thread_id),
        ).toEqual([rootId]);
        expect(stopEffects.some((row) => row.thread_id === s.childThreadId)).toBe(false);
        const taskAfterStop = (yield* s.orchestrator.getThreadProjection(rootId)).subagents.find(
          (task) => task.id === s.taskId,
        )!;
        // The execute side: what the worker runs once the Stop commits.
        yield* threads.stopDelegatedTasks({ threadId: rootId, commandId: stopId });
        const after = yield* readSinks;
        const taskAfter = (yield* s.orchestrator.getThreadProjection(rootId)).subagents.find(
          (task) => task.id === s.taskId,
        )!;
        if (origin === "app_owned") {
          expect(taskAfterStop.completionDelivery?.state).toBe("disposed");
          expect(runsOf(after, s.childThreadId)).toEqual(["interrupted"]);
        } else if (origin === "provider_native") {
          // Only a provider-native subagent is terminalized by the run-owned cascade.
          expect(taskAfterStop.status).toBe("interrupted");
          expect(runsOf(after, s.childThreadId)).toEqual([]);
          expect(effectsOf(after, s.childThreadId)).toEqual([]);
        } else {
          // The parent's Stop reaches no virtual thread and no native cancel:
          // the app-owned loop skips the origin, no cohort or cascade touches it.
          expect(taskAfterStop.status).toBe("running");
          expect(taskAfterStop.completionDelivery).toBeUndefined();
          expect(taskAfter).toEqual(taskAfterStop);
          expect(yield* s.projections.getThread(s.childThreadId)).toEqual(childBefore);
          expect(m.cancelInputs).toEqual([]);
          expect(runsOf(after, s.childThreadId)).toEqual([]);
          expect(effectsOf(after, s.childThreadId)).toEqual([]);
          expect(providerRowsOf(after, s.childThreadId)).toEqual({
            providerThreads: 0,
            turns: 0,
            sessions: 0,
          });
          expect(effectsOf(before, s.childThreadId)).toEqual([]);
        }
        expect(m.calls.openSession).toBe(0);
      }).pipe(Effect.provide(m.layer));
    },
  );
});

describe("Orchestrator.bridget149 origin matrix: canonical markers", () => {
  const dispatchToChild = (
    orchestrator: Orchestrator.OrchestratorV2Shape,
    threadId: ThreadId,
    tag: string,
  ) => sendTo(orchestrator, threadId, tag, "start_immediately");

  it.effect("an origin label and an id prefix alone never make a thread virtual", () => {
    const m = makeMatrixLayer();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      const root = yield* projections.getThread(rootId);
      const lookalikeId = ThreadId.make(`thread:bridget-task:${uuid(77)}`);
      const lookalikeNode = NodeId.make(`node:bridget-task:${uuid(77)}`);
      const now = yield* DateTime.now;
      // Bridget's id format, "server" creation source, subagent lineage and a
      // `bridget_native` record, but no `bridgetTaskRef` marker.
      yield* projections.apply({
        id: EventId.make("bridget-149-lookalike-thread"),
        type: "thread.created",
        threadId: lookalikeId,
        occurredAt: now,
        payload: {
          ...root,
          createdBy: "agent",
          creationSource: "server",
          id: lookalikeId,
          title: "Lookalike",
          lineage: {
            parentThreadId: rootId,
            rootThreadId: rootId,
            relationshipToParent: "subagent",
          },
        } as never,
      });
      yield* projections.apply({
        id: EventId.make("bridget-149-lookalike-task"),
        type: "subagent.updated",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: lookalikeNode,
          threadId: rootId,
          runId: null,
          parentNodeId: `node:bridget-root:${rootId}`,
          origin: "bridget_native",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: lookalikeId,
          nativeTaskRef: null,
          prompt: "",
          title: "Lookalike",
          model: modelSelection.model,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as never,
      });
      const outcome = yield* dispatchToChild(orchestrator, lookalikeId, "lookalike").pipe(
        Effect.exit,
      );
      const sinks = yield* readSinks;
      // The canonical marker is the only guard: the lookalike takes the
      // ordinary start branch (a run and one provider-turn.start row).
      expect(outcome._tag).toBe("Success");
      expect(runsOf(sinks, lookalikeId)).toEqual(["starting"]);
      expect(effectsOf(sinks, lookalikeId)).toEqual(["provider-turn.start"]);
      expect(m.calls.openSession).toBe(0);
    }).pipe(Effect.provide(m.layer));
  });

  it.effect(
    "a Bridget marker stays guarded when the task record carries another origin label",
    () => {
      const m = makeMatrixLayer();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* createRoot(orchestrator, rootId);
        yield* sync(orchestrator, rootId, nativeSnapshot([nativeTask()]), "relabel");
        const record = (yield* orchestrator.getThreadProjection(rootId)).subagents.find(
          (task) => task.childThreadId === childA,
        )!;
        yield* projections.apply({
          id: EventId.make("bridget-149-relabel"),
          type: "subagent.updated",
          threadId: rootId,
          nodeId: record.id,
          occurredAt: yield* DateTime.now,
          payload: { ...record, origin: "app_owned" } as never,
        });
        expect(
          (yield* orchestrator.getThreadProjection(rootId)).subagents.find(
            (task) => task.id === record.id,
          )!.origin,
        ).toBe("app_owned");
        const failure = yield* dispatchToChild(orchestrator, childA, "relabelled").pipe(
          Effect.flip,
        );
        expect(failure._tag).toBe("OrchestratorSubagentThreadReadOnlyError");
        const sinks = yield* readSinks;
        expect(runsOf(sinks, childA)).toEqual([]);
        expect(effectsOf(sinks, childA)).toEqual([]);
        expect(providerRowsOf(sinks, childA)).toEqual({
          providerThreads: 0,
          turns: 0,
          sessions: 0,
        });
        expect(m.calls.openSession).toBe(0);
      }).pipe(Effect.provide(m.layer));
    },
  );

  it("keeps the origin enum at three values and the Bridget marker closed at seven fields", () => {
    const decodeOrigin = Schema.decodeUnknownExit(OrchestrationV2Subagent.fields.origin);
    for (const origin of ORIGINS) expect(decodeOrigin(origin)._tag).toBe("Success");
    for (const origin of ["bridget", "native", "APP_OWNED", ""])
      expect(decodeOrigin(origin)._tag).toBe("Failure");
    expect(Object.keys(BridgetTaskRef.fields).sort()).toEqual([
      "generation",
      "parentTaskId",
      "rootThreadId",
      "seq",
      "status",
      "taskId",
      "version",
    ]);
    const marker = {
      version: 1,
      taskId: uuid(1),
      rootThreadId: rootId,
      parentTaskId: null,
      generation: uuid(900),
      seq: 7,
      status: "working",
    };
    const strict = Schema.decodeUnknownExit(BridgetTaskRef, { onExcessProperty: "error" });
    expect(strict(marker)._tag).toBe("Success");
    expect(strict({ ...marker, extra: true })._tag).toBe("Failure");
    expect(strict({ ...marker, taskId: "thread:bridget-task:not-a-uuid" })._tag).toBe("Failure");
  });
});
