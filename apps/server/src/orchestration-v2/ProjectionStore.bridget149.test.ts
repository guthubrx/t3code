// Session 149 — server lineage lot (L). Oracles: getBridgetTaskThreads selects every
// thread whose bridgetTaskRef points at the root, extends the result with explicit
// candidates (cross-root candidates are returned by design), and refuses beyond 4096.
// getSettlementCandidates never offers a virtual subagent thread.
//
// The virtual threads are seeded through the public projections.apply path with exactly
// the events dispatchBridgetLineageSync would emit (provider instance id uses a
// slug-valid stand-in because of the reported production bug at Orchestrator.ts:10210).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type BridgetLineageTask,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BridgetReader from "../bridget/BridgetReader.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const uuid = (n: number) =>
  `${String(n % 100000000).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = ProjectId.make("project:bridget-149");
const rootId = ThreadId.make("thread:bridget-root-149");
const otherRootId = ThreadId.make("thread:bridget-other-149");
const childThreadId = (taskId: string) => ThreadId.make(`thread:bridget-task:${taskId}`);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for projection reads"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;

const makeHarness = () => {
  const base = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bridget-149" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
  const layer = Layer.provideMerge(
    base,
    Layer.mergeAll(
      Layer.succeed(
        BridgetReader.BridgetReader,
        BridgetReader.BridgetReader.of({
          lineageSnapshot: () => Effect.die("Not expected in projection reads"),
        } as unknown as BridgetReader.BridgetReader["Service"]),
      ),
      NodeCrypto.layer,
    ),
  );
  return { layer };
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

/**
 * Applies exactly the events dispatchBridgetLineageSync would emit for one root, through
 * the public projection path. Only the provider instance id differs (slug-valid stand-in,
 * see the production bug note above).
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
    const standInInstanceId = ProviderInstanceId.make("bridget-claude");
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
      const childThreadIdForTask = childThreadId(task.task_id);
      const parentThreadId =
        task.parent_task_id === null ? rootThreadId : childThreadId(task.parent_task_id);
      const child = {
        ...root,
        createdBy: "agent",
        creationSource: "server",
        id: childThreadIdForTask,
        title: task.title.trim() || task.agent_type,
        providerInstanceId: standInInstanceId,
        modelSelection: { instanceId: standInInstanceId, model: task.model },
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
          rootThreadId,
          parentTaskId: task.parent_task_id,
          generation,
          seq,
          status: task.status,
        },
        bridgetTask: task,
        bridgetLineage: { generation, seq, available: true },
      };
      yield* apply("thread.created", childThreadIdForTask, child);
    }
    yield* apply("thread.metadata-updated", rootThreadId, {
      ...root,
      bridgetLineage: { generation, seq, available: true },
    });
    return { generation, seq };
  });

describe("ProjectionStore.bridget149 getBridgetTaskThreads", () => {
  it.effect("selects only the threads whose marker points at the root", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* createRoot(orchestrator, otherRootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      yield* seedVirtual(projections, otherRootId, [
        nativeTask({ task_id: uuid(3), title: "Task C" }),
      ]);
      expect((yield* projections.getBridgetTaskThreads(rootId)).map((thread) => thread.id)).toEqual(
        [childThreadId(uuid(1))],
      );
      expect(
        (yield* projections.getBridgetTaskThreads(otherRootId)).map((thread) => thread.id),
      ).toEqual([childThreadId(uuid(3))]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("extends the result with explicit candidates without duplication", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* createRoot(orchestrator, otherRootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      yield* seedVirtual(projections, otherRootId, [
        nativeTask({ task_id: uuid(3), title: "Task C" }),
      ]);
      // A repeated candidate stays one row.
      expect(
        (yield* projections.getBridgetTaskThreads(rootId, [
          childThreadId(uuid(1)),
          childThreadId(uuid(1)),
        ])).map((thread) => thread.id),
      ).toEqual([childThreadId(uuid(1))]);
      // A candidate owned by another root is returned by design: the OR clause widens
      // the root filter, callers use it to check adoption conflicts.
      expect(
        (yield* projections.getBridgetTaskThreads(otherRootId, [childThreadId(uuid(1))])).map(
          (thread) => thread.id,
        ),
      ).toEqual([childThreadId(uuid(1)), childThreadId(uuid(3))]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("accepts 4096 native threads and refuses 4097", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      const bulk: BridgetLineageTask[] = Array.from({ length: 4096 }, (_, index) =>
        nativeTask({ task_id: uuid(10 + index), title: `Task ${index}` }),
      );
      yield* seedVirtual(projections, rootId, bulk);
      expect(yield* projections.getBridgetTaskThreads(rootId)).toHaveLength(4096);
      yield* seedVirtual(
        projections,
        rootId,
        [nativeTask({ task_id: uuid(9999), title: "Overflow" })],
        uuid(901),
        8,
      );
      const failure = yield* projections.getBridgetTaskThreads(rootId).pipe(Effect.flip);
      expect(failure._tag).toBe("ProjectionStoreReadError");
      // The read wraps its own limit error once more on the way out.
      expect((failure.cause as { cause: string }).cause).toBe("Native projection limit exceeded.");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("ProjectionStore.bridget149 getSettlementCandidates", () => {
  it.effect("never offers a virtual subagent thread for settlement", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, [nativeTask()]);
      expect(
        (yield* projections.getSettlementCandidates()).map((candidate) => candidate.id),
      ).toEqual([rootId]);
    }).pipe(Effect.provide(h.layer));
  });
});
