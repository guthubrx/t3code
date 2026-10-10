// Session 149 — server lineage lot (L). Oracles: a thread launch targeting a virtual
// Bridget subagent thread is refused with operation "update-thread" before any worktree,
// title or branch work happens, and the projection stays untouched; a plain launch on a
// fresh thread still succeeds.
//
// The virtual thread is seeded through the public projections.apply path with exactly
// the events dispatchBridgetLineageSync would emit (provider instance id uses a
// slug-valid stand-in because of the reported production bug at Orchestrator.ts:10210).
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type { BridgetLineageSnapshot, BridgetLineageTask } from "@t3tools/contracts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as DateTime from "effect/DateTime";
import { EventId } from "@t3tools/contracts";

const uuid = (n: number) =>
  `${String(n % 100000000).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = ProjectId.make("project:launch-test");
const rootId = ThreadId.make("thread:bridget-root-launch-149");
const childId = ThreadId.make(`thread:bridget-task:${uuid(1)}`);
const freshThreadId = ThreadId.make("thread:launch-fresh-149");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapterV2Shape;

function makeHarness() {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch-149" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerProjection = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(Layer.provide(layerOrchestrator));
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(((input) =>
    Effect.succeed({
      worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
    } as never)) as GitWorkflow.GitWorkflowService["Service"]["createWorktree"]);
  const renameBranch = vi.fn(((input) =>
    Effect.succeed({
      branch: input.newBranch,
    })) as GitWorkflow.GitWorkflowService["Service"]["renameBranch"]);
  const runSetup = vi.fn((() =>
    Effect.succeed({
      status: "no-script" as const,
    })) as ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]);
  const generateBranchName = vi.fn((() =>
    Effect.succeed({
      branch: "generated-branch",
    })) as TextGeneration.TextGeneration["Service"]["generateBranchName"]);
  const generateThreadTitle = vi.fn((() =>
    Effect.succeed({
      title: "Generated title",
    })) as TextGeneration.TextGeneration["Service"]["generateThreadTitle"]);
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id: ProjectId) =>
        Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchRemote: () => Effect.void,
      hasCommit: () => Effect.succeed(false),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree: () => Effect.void,
      resolveRemoteTrackingCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    ServerSettings.layerTest(),
    ProviderRegistryMock.layer([] as ReadonlyArray<ServerProvider>),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layer = Layer.mergeAll(
    layerLaunch,
    layerOrchestrator,
    layerProjection,
    layerThreadManagement,
    layerOutbox,
    layerDatabase,
    layerExternalServices,
  );
  return {
    layer,
    createWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
  };
}

const launchInput = (input: { readonly command: string; readonly thread: ThreadId }) => ({
  commandId: CommandId.make(input.command),
  threadId: input.thread,
  projectId,
  title: "New thread",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceStrategy: { type: "root" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

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
 * Applies exactly the events dispatchBridgetLineageSync would emit, through the public
 * projection path. Only the provider instance id differs (slug-valid stand-in, see the
 * production bug note above).
 */
const seedVirtual = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  rootThreadId: ThreadId,
  task: BridgetLineageTask,
  generation = uuid(900),
  seq = 7,
) =>
  Effect.gen(function* () {
    const root = yield* projections.getThread(rootThreadId);
    const now = yield* DateTime.now;
    const standInInstanceId = ProviderInstanceId.make("bridget-claude");
    const parentThreadId =
      task.parent_task_id === null
        ? rootThreadId
        : ThreadId.make(`thread:bridget-task:${task.parent_task_id}`);
    const child = {
      ...root,
      createdBy: "agent",
      creationSource: "server",
      id: childId,
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
    yield* projections.apply({
      id: EventId.make("bridget-149-launch-seed-1"),
      type: "thread.created" as never,
      threadId: childId,
      occurredAt: now,
      payload: child as never,
    });
    yield* projections.apply({
      id: EventId.make("bridget-149-launch-seed-2"),
      type: "subagent.updated" as never,
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        id: `node:bridget-task:${task.task_id}`,
        threadId: parentThreadId,
        runId: null,
        parentNodeId: `node:bridget-root:${rootThreadId}`,
        origin: "bridget_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: standInInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "",
        title: task.title,
        model: task.model,
        modelSelection: { instanceId: standInInstanceId, model: task.model },
        status: "running",
        result: null,
        progress: task.error ?? task.status,
        startedAt: task.started_at === null ? null : DateTime.makeUnsafe(task.started_at * 1000),
        completedAt:
          task.completed_at === null ? null : DateTime.makeUnsafe(task.completed_at * 1000),
        updatedAt: DateTime.makeUnsafe(task.updated_at * 1000),
      } as never,
    });
    yield* projections.apply({
      id: EventId.make("bridget-149-launch-seed-3"),
      type: "thread.metadata-updated" as never,
      threadId: rootThreadId,
      occurredAt: now,
      payload: { ...root, bridgetLineage: { generation, seq, available: true } } as never,
    });
    return { generation, seq } satisfies Partial<BridgetLineageSnapshot>;
  });

describe("ThreadLaunchService.bridget149 read-only guard", () => {
  it.effect("refuses a launch targeting a virtual Bridget thread", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createRoot(orchestrator, rootId);
      yield* seedVirtual(projections, rootId, nativeTask());
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const failure = yield* launches
        .launch(launchInput({ command: "bridget-149-launch-virtual", thread: childId }))
        .pipe(Effect.flip);
      expect(failure._tag).toBe("ThreadLaunchError");
      expect(failure.operation).toBe("update-thread");
      expect(failure.threadId).toBe(childId);
      expect(failure.cause).toBe("Native Bridget tasks are read-only.");
      expect(h.createWorktree).not.toHaveBeenCalled();
      expect(h.renameBranch).not.toHaveBeenCalled();
      expect(h.generateBranchName).not.toHaveBeenCalled();
      expect(h.generateThreadTitle).not.toHaveBeenCalled();
      expect(h.runSetup).not.toHaveBeenCalled();
      const shell = yield* projections.getThreadShell(childId);
      expect(shell?.bridgetTaskRef).toBeDefined();
      const stored = yield* projections.getThread(childId);
      expect(stored.bridgetLineage).toEqual({ generation: uuid(900), seq: 7, available: true });
      const records = yield* projections.getThreadRecords(childId, [
        "runs",
        "providerThreads",
        "turnItems",
      ]);
      expect(records.runs).toEqual([]);
      expect(records.providerThreads).toEqual([]);
      expect(records.turnItems).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("a plain launch on a fresh thread still succeeds", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const result = yield* launches.launch(
        launchInput({ command: "bridget-149-launch-fresh", thread: freshThreadId }),
      );
      expect(result.threadId).toBe(freshThreadId);
      expect(result.resumed).toBe(false);
      expect(result.projection.thread.id).toBe(freshThreadId);
      expect(result.projection.thread.bridgetTaskRef).toBeUndefined();
      expect(h.createWorktree).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });
});
