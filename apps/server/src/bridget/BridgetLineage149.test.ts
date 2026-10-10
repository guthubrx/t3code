// Session 149 — server lineage lot (L). Oracles: BridgetLineage.synchronize stages the
// snapshot with a bounded retry, dispatches ONE atomic projection command, and marks the
// view unavailable on authority/transport/format failures (not on local journal/offset refusals); cancel never talks to the projection at all.
import { describe, expect, it } from "@effect/vitest";
import {
  BridgetLineageError,
  type BridgetLineageJournal,
  type BridgetLineageSnapshot,
  type BridgetLineageTask,
  type BridgetLineageView,
  type BridgetWatchEvent,
  CommandId,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as BridgetLineage from "./BridgetLineage.ts";
import * as BridgetReader from "./BridgetReader.ts";

const uuid = (n: number) =>
  `${String(n % 100000000).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const threadId = ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac");
const projectId = ProjectId.make("project-lineage-149");
const FIXED_UUID = "c0ffee00-0000-4000-8000-000000000001";

const task = (overrides: Partial<BridgetLineageTask> = {}): BridgetLineageTask => ({
  task_id: uuid(1),
  parent_task_id: null,
  parent_agent_id: uuid(900),
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
  cwd: "/tmp/project",
  posture: "development",
  title: "Task one",
  status: "working",
  error: null,
  result_available: false,
  journal_available: true,
  ...overrides,
});
const snapshot = (tasks: BridgetLineageTask[]): BridgetLineageSnapshot => ({
  version: 1,
  status: "ok",
  generation: uuid(900),
  seq: 7,
  root_owner_agent_id: uuid(901),
  tasks,
  next_cursor: null,
});
const error = (code: BridgetLineageError["code"]) => new BridgetLineageError({ code });
const journal = (): BridgetLineageJournal => ({
  version: 1,
  status: "ok",
  task_id: uuid(1),
  events: [],
  next_seq: 5,
  caught_up: true,
  gap: null,
});

interface HarnessOptions {
  /** Scripted lineageSnapshot outcomes in order; the last one repeats. */
  readonly snapshots?: ReadonlyArray<Effect.Effect<BridgetLineageSnapshot, BridgetLineageError>>;
  readonly read?: Effect.Effect<BridgetLineageView, BridgetLineageError>;
  readonly watchEvents?: ReadonlyArray<BridgetWatchEvent>;
  readonly watchFailure?: BridgetLineageError;
  readonly journalPage?: BridgetLineageJournal;
  readonly journalFailure?: BridgetLineageError;
  readonly cancel?: Effect.Effect<unknown, BridgetLineageError>;
  /** Make every orchestrator dispatch fail (the projection is down). */
  readonly failDispatch?: boolean;
  /** Virtual thread records by id: the root that owns the task, or absent = unknown thread. */
  readonly virtualThreads?: Readonly<Record<string, string>>;
  /** Explicit thread records overriding the defaults (an `undefined` value = unknown thread). */
  readonly threads?: Readonly<Record<string, ThreadStub | undefined>>;
}

interface ThreadStub {
  readonly projectId: string;
  readonly bridgetTaskRef?: { readonly rootThreadId: string };
}

interface DispatchAttempt {
  readonly type: string;
  readonly threadId: string;
  readonly ok: boolean;
}

const harness = Effect.fn("BridgetLineage149.harness")(function* (options: HarnessOptions = {}) {
  const attempts: Array<DispatchAttempt> = [];
  const counters = { snapshotAttempts: 0 };
  const readInputs: Array<unknown> = [];
  const cancelInputs: Array<unknown> = [];
  const queue = [...(options.snapshots ?? [])];
  let lastSnapshot: Effect.Effect<BridgetLineageSnapshot, BridgetLineageError> | undefined;

  const reader = BridgetReader.BridgetReader.of({
    lineageSnapshot: () => {
      counters.snapshotAttempts += 1;
      const next = queue.shift();
      if (next !== undefined) {
        lastSnapshot = next;
        return next;
      }
      return lastSnapshot ?? Effect.fail(error("unavailable"));
    },
    lineageRead: (raw: unknown) => {
      readInputs.push(raw);
      return options.read ?? Effect.succeed(snapshot([task()]));
    },
    lineageWatch: () =>
      options.watchFailure
        ? Stream.fail(options.watchFailure)
        : Stream.fromIterable(options.watchEvents ?? []),
    lineageJournal: () => {
      readInputs.push("journal");
      return options.journalFailure
        ? Stream.fail(options.journalFailure)
        : Stream.fromIterable(options.journalPage ? [options.journalPage] : []);
    },
    lineageCancel: (raw: unknown) => {
      cancelInputs.push(raw);
      return (
        options.cancel ?? Effect.succeed({ version: 1, task_id: uuid(1), status: "cancelling" })
      );
    },
  } as unknown as BridgetReader.BridgetReader["Service"]);

  // Real thread records: the host root belongs to `projectId`; a virtual child carries its
  // marker (bridgetTaskRef.rootThreadId) and the same project unless `threads` says otherwise.
  const records: Record<string, ThreadStub | undefined> = {
    [threadId]: { projectId },
    ...Object.fromEntries(
      Object.entries(options.virtualThreads ?? {}).map(([id, root]) => [
        id,
        { projectId, bridgetTaskRef: { rootThreadId: root } },
      ]),
    ),
    ...options.threads,
  };
  const orchestrator = Orchestrator.OrchestratorV2.of({
    getThreadRecords: (id: string) =>
      records[id] === undefined
        ? Effect.fail(error("binding_unavailable"))
        : Effect.succeed({ thread: { id, ...records[id] } }),
    dispatch: (command: { type: string; threadId: string }) =>
      Effect.gen(function* () {
        if (options.failDispatch === true) {
          attempts.push({ type: command.type, threadId: command.threadId, ok: false });
          return yield* Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: CommandId.make("stub-command"),
              commandType: command.type,
              cause: "projection down",
            }),
          );
        }
        attempts.push({ type: command.type, threadId: command.threadId, ok: true });
        return { sequence: attempts.length, storedEvents: [] };
      }),
  } as unknown as Orchestrator.OrchestratorV2["Service"]);

  const crypto = Crypto.Crypto.of({
    randomUUIDv4: Effect.succeed(FIXED_UUID),
  } as unknown as Crypto.Crypto);

  const lineage = yield* BridgetLineage.BridgetLineage.pipe(
    Effect.provide(
      BridgetLineage.layer.pipe(
        Layer.provide(Layer.succeed(BridgetReader.BridgetReader, reader)),
        Layer.provide(Layer.succeed(Orchestrator.OrchestratorV2, orchestrator)),
        Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
      ),
    ),
  );
  return { lineage, attempts, counters, readInputs, cancelInputs };
});

describe("BridgetLineage149 rpc scopes", () => {
  it("keeps reads on the real orchestration read scope", () => {
    expect(WS_METHODS.bridgetLineageRead).toBe("bridget.lineage.read");
    expect(requiredScopeForRpcMethod("bridget.lineage.read")).toBe("orchestration:read");
    expect(requiredScopeForRpcMethod("bridget.lineage.watch")).toBe("orchestration:read");
    expect(requiredScopeForRpcMethod("bridget.lineage.journal")).toBe("orchestration:read");
  });
  it("keeps cancel on the real orchestration operate scope", () => {
    expect(WS_METHODS.bridgetLineageCancel).toBe("bridget.lineage.cancel");
    expect(requiredScopeForRpcMethod("bridget.lineage.cancel")).toBe("orchestration:operate");
  });
});

describe("BridgetLineage149 read staging and atomic dispatch", () => {
  it.effect("stages the snapshot once and dispatches one atomic sync", () =>
    Effect.gen(function* () {
      const staged = snapshot([task()]);
      const h = yield* harness({ snapshots: [Effect.succeed(staged)] });
      expect(yield* h.lineage.read({ projectId, threadId, action: "list" })).toEqual(staged);
      expect(h.counters.snapshotAttempts).toBe(1);
      expect(h.attempts).toEqual([{ type: "bridget.lineage.sync", threadId, ok: true }]);
    }),
  );
  it.effect("uses a lineage command id derived from the real crypto service", () =>
    Effect.gen(function* () {
      const h = yield* harness({ snapshots: [Effect.succeed(snapshot([]))] });
      yield* h.lineage.read({ projectId, threadId, action: "list" });
      // The crypto stub returns FIXED_UUID; the command id carries it after the prefix.
      expect(FIXED_UUID).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.attempts).toHaveLength(1);
    }),
  );
  it.effect("retries staging twice on snapshot_changed before the dispatch", () =>
    Effect.gen(function* () {
      const staged = snapshot([task({ task_id: uuid(3) })]);
      const h = yield* harness({
        snapshots: [
          Effect.fail(error("snapshot_changed")),
          Effect.fail(error("snapshot_changed")),
          Effect.succeed(staged),
        ],
      });
      expect(yield* h.lineage.read({ projectId, threadId, action: "list" })).toEqual(staged);
      expect(h.counters.snapshotAttempts).toBe(3);
      expect(h.attempts).toEqual([{ type: "bridget.lineage.sync", threadId, ok: true }]);
    }),
  );
  it.effect("fails snapshot_changed after three failed staging attempts", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        snapshots: [
          Effect.fail(error("snapshot_changed")),
          Effect.fail(error("snapshot_changed")),
          Effect.fail(error("snapshot_changed")),
        ],
      });
      expect(
        (yield* h.lineage.read({ projectId, threadId, action: "list" }).pipe(Effect.flip)).code,
      ).toBe("snapshot_changed");
      expect(h.counters.snapshotAttempts).toBe(3);
      // The exhausted read still marks the live view unavailable (read taps every failure).
      expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
    }),
  );
  it.effect("does not retry a non-retryable staging error and marks the view unavailable", () =>
    Effect.gen(function* () {
      const h = yield* harness({ snapshots: [Effect.fail(error("task_unavailable"))] });
      expect(
        (yield* h.lineage.read({ projectId, threadId, action: "list" }).pipe(Effect.flip)).code,
      ).toBe("task_unavailable");
      expect(h.counters.snapshotAttempts).toBe(1);
      expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
    }),
  );
  it.effect(
    "maps a failed projection dispatch to invalid_output and marks the view unavailable",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({
          snapshots: [Effect.succeed(snapshot([]))],
          failDispatch: true,
        });
        expect(
          (yield* h.lineage.read({ projectId, threadId, action: "list" }).pipe(Effect.flip)).code,
        ).toBe("invalid_output");
        expect(h.counters.snapshotAttempts).toBe(1);
        expect(h.attempts.map((attempt) => attempt.type)).toEqual([
          "bridget.lineage.sync",
          "bridget.lineage.unavailable",
        ]);
        expect(h.attempts.every((attempt) => attempt.ok === false)).toBe(true);
      }),
  );
  it.effect("passes show reads through without staging or dispatching", () =>
    Effect.gen(function* () {
      const shown = snapshot([task()]);
      const h = yield* harness({
        read: Effect.succeed(shown),
        snapshots: [Effect.fail(error("unavailable"))],
      });
      expect(
        yield* h.lineage.read({ projectId, threadId, action: "show", taskId: uuid(1) }),
      ).toEqual(shown);
      expect(h.counters.snapshotAttempts).toBe(0);
      expect(h.attempts).toEqual([]);
      expect(h.readInputs).toEqual([{ projectId, threadId, action: "show", taskId: uuid(1) }]);
    }),
  );
  it.effect(
    "keeps the root available when a show read is refused locally (offset, journal, request)",
    () =>
      Effect.gen(function* () {
        for (const code of [
          "result_offset_invalid",
          "journal_unavailable",
          "invalid_request",
          "envelope_mismatch",
        ] as const) {
          const h = yield* harness({ read: Effect.fail(error(code)) });
          expect(
            (yield* h.lineage
              .read({ projectId, threadId, action: "show", taskId: uuid(1) })
              .pipe(Effect.flip)).code,
          ).toBe(code);
          // A local refusal says nothing about the root authority: no availability change at all.
          expect(h.attempts).toEqual([]);
        }
      }),
  );
  it.effect(
    "marks the root unavailable when a show read fails on authority, transport or format",
    () =>
      Effect.gen(function* () {
        for (const code of [
          "unavailable",
          "project_mismatch",
          "binding_unavailable",
          "invalid_output",
          "store_unavailable",
          "timeout",
        ] as const) {
          const h = yield* harness({ read: Effect.fail(error(code)) });
          expect(
            (yield* h.lineage
              .read({ projectId, threadId, action: "show", taskId: uuid(1) })
              .pipe(Effect.flip)).code,
          ).toBe(code);
          expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
        }
      }),
  );
  it.effect("task_unavailable on a known child of this root invalidates that child only", () =>
    Effect.gen(function* () {
      const childId = ThreadId.make(`thread:bridget-task:${uuid(1)}`);
      const h = yield* harness({
        read: Effect.fail(error("task_unavailable")),
        virtualThreads: { [childId]: threadId },
      });
      expect(
        (yield* h.lineage
          .read({ projectId, threadId, action: "show", taskId: uuid(1) })
          .pipe(Effect.flip)).code,
      ).toBe("task_unavailable");
      expect(h.attempts).toEqual([
        { type: "bridget.lineage.unavailable", threadId: childId, ok: true },
      ]);
    }),
  );
  it.effect("task_unavailable on a foreign or unknown task changes no root and no thread", () =>
    Effect.gen(function* () {
      const foreign = ThreadId.make("00000000-0000-4000-8000-0000000000ff");
      const foreignChild = ThreadId.make(`thread:bridget-task:${uuid(1)}`);
      // uuid(1): task bound to ANOTHER root; uuid(2): no thread record at all.
      for (const taskId of [uuid(1), uuid(2)]) {
        const h = yield* harness({
          read: Effect.fail(error("task_unavailable")),
          virtualThreads: { [foreignChild]: foreign },
        });
        expect(
          (yield* h.lineage.read({ projectId, threadId, action: "show", taskId }).pipe(Effect.flip))
            .code,
        ).toBe("task_unavailable");
        expect(h.attempts).toEqual([]);
      }
    }),
  );
});

describe("BridgetLineage149 watch and journal streams", () => {
  const event = (seq: number): BridgetWatchEvent => ({
    version: 1,
    generation: uuid(900),
    seq,
    status: "changed",
  });

  it.effect("synchronizes the projection once per watch event", () =>
    Effect.gen(function* () {
      const staged = snapshot([]);
      const h = yield* harness({
        snapshots: [Effect.succeed(staged)],
        watchEvents: [event(1), event(2)],
      });
      expect(
        yield* h.lineage
          .watch({ projectId, threadId })
          .pipe(Stream.runCollect, Effect.map(Array.from)),
      ).toEqual([event(1), event(2)]);
      expect(h.counters.snapshotAttempts).toBe(2);
      expect(h.attempts).toEqual([
        { type: "bridget.lineage.sync", threadId, ok: true },
        { type: "bridget.lineage.sync", threadId, ok: true },
      ]);
    }),
  );
  it.effect("marks the view unavailable once when the watch stream fails", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        watchEvents: [],
        watchFailure: error("task_unavailable"),
      });
      expect(
        (yield* Stream.runDrain(h.lineage.watch({ projectId, threadId })).pipe(Effect.flip)).code,
      ).toBe("task_unavailable");
      expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
    }),
  );
  it.effect("passes journal pages through without dispatching", () =>
    Effect.gen(function* () {
      const page = journal();
      const h = yield* harness({ journalPage: page });
      expect(
        yield* h.lineage
          .journal({ projectId, threadId, taskId: uuid(1) })
          .pipe(Stream.runCollect, Effect.map(Array.from)),
      ).toEqual([page]);
      expect(h.attempts).toEqual([]);
    }),
  );
  it.effect("keeps the root available when the journal of one task is absent", () =>
    Effect.gen(function* () {
      const h = yield* harness({ journalFailure: error("journal_unavailable") });
      expect(
        (yield* Stream.runDrain(h.lineage.journal({ projectId, threadId, taskId: uuid(1) })).pipe(
          Effect.flip,
        )).code,
      ).toBe("journal_unavailable");
      expect(h.attempts).toEqual([]);
    }),
  );
  it.effect("marks the root unavailable when the journal stream fails on transport", () =>
    Effect.gen(function* () {
      const h = yield* harness({ journalFailure: error("unavailable") });
      expect(
        (yield* Stream.runDrain(h.lineage.journal({ projectId, threadId, taskId: uuid(1) })).pipe(
          Effect.flip,
        )).code,
      ).toBe("unavailable");
      expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
    }),
  );
});

// Session 149 r4 — F1 safety: a refused caller context must never degrade the real root.
// The stubbed records are scientific: the root really belongs to `projectId`, is not virtual,
// and the forged input names another project / an unknown or virtual thread.
describe("BridgetLineage149 r4 forged context cannot degrade a real root", () => {
  const otherProject = ProjectId.make("project-other-149");
  const degrading = [
    "project_mismatch",
    "binding_unavailable",
    "unavailable",
    "invalid_output",
    "store_unavailable",
    "timeout",
  ] as const;
  const childId = ThreadId.make(`thread:bridget-task:${uuid(1)}`);

  it.effect("read list/show with a forged projectId and the real root: 0 dispatch", () =>
    Effect.gen(function* () {
      for (const code of degrading) {
        const hShow = yield* harness({ read: Effect.fail(error(code)) });
        expect(
          (yield* hShow.lineage
            .read({ projectId: otherProject, threadId, action: "show", taskId: uuid(1) })
            .pipe(Effect.flip)).code,
        ).toBe(code);
        expect(hShow.attempts).toEqual([]);
        const hList = yield* harness({ snapshots: [Effect.fail(error(code))] });
        expect(
          (yield* hList.lineage
            .read({ projectId: otherProject, threadId, action: "list" })
            .pipe(Effect.flip)).code,
        ).toBe(code);
        expect(hList.attempts).toEqual([]);
      }
    }),
  );
  it.effect("watch and journal with a forged projectId and the real root: 0 dispatch", () =>
    Effect.gen(function* () {
      for (const code of degrading) {
        const hWatch = yield* harness({ watchFailure: error(code) });
        expect(
          (yield* Stream.runDrain(hWatch.lineage.watch({ projectId: otherProject, threadId })).pipe(
            Effect.flip,
          )).code,
        ).toBe(code);
        expect(hWatch.attempts).toEqual([]);
        const hJournal = yield* harness({ journalFailure: error(code) });
        expect(
          (yield* Stream.runDrain(
            hJournal.lineage.journal({ projectId: otherProject, threadId, taskId: uuid(1) }),
          ).pipe(Effect.flip)).code,
        ).toBe(code);
        expect(hJournal.attempts).toEqual([]);
      }
    }),
  );
  it.effect(
    "an unknown or virtual thread used as root: 0 dispatch (even with the matching project)",
    () =>
      Effect.gen(function* () {
        const unknown = ThreadId.make("00000000-0000-4000-8000-0000000000aa");
        for (const [root, threads] of [
          [unknown, {}],
          [childId, { [childId]: { projectId, bridgetTaskRef: { rootThreadId: threadId } } }],
        ] as const) {
          for (const code of degrading) {
            const h = yield* harness({ read: Effect.fail(error(code)), threads });
            expect(
              (yield* h.lineage
                .read({ projectId, threadId: root, action: "show", taskId: uuid(1) })
                .pipe(Effect.flip)).code,
            ).toBe(code);
            expect(h.attempts).toEqual([]);
          }
        }
      }),
  );
  it.effect(
    "task_unavailable on a known child with a forged project or a child of another project: 0 dispatch",
    () =>
      Effect.gen(function* () {
        const forged = yield* harness({
          read: Effect.fail(error("task_unavailable")),
          virtualThreads: { [childId]: threadId },
        });
        expect(
          (yield* forged.lineage
            .read({ projectId: otherProject, threadId, action: "show", taskId: uuid(1) })
            .pipe(Effect.flip)).code,
        ).toBe("task_unavailable");
        expect(forged.attempts).toEqual([]);
        const crossProject = yield* harness({
          read: Effect.fail(error("task_unavailable")),
          threads: {
            [childId]: { projectId: otherProject, bridgetTaskRef: { rootThreadId: threadId } },
          },
        });
        expect(
          (yield* crossProject.lineage
            .read({ projectId, threadId, action: "show", taskId: uuid(1) })
            .pipe(Effect.flip)).code,
        ).toBe("task_unavailable");
        expect(crossProject.attempts).toEqual([]);
      }),
  );
  it.effect(
    "a genuine context still degrades the real root (no weakening of the safety oracle)",
    () =>
      Effect.gen(function* () {
        for (const code of degrading) {
          const h = yield* harness({ snapshots: [Effect.fail(error(code))] });
          expect(
            (yield* h.lineage.read({ projectId, threadId, action: "list" }).pipe(Effect.flip)).code,
          ).toBe(code);
          expect(h.attempts).toEqual([{ type: "bridget.lineage.unavailable", threadId, ok: true }]);
          const hJournal = yield* harness({ journalFailure: error(code) });
          yield* Stream.runDrain(
            hJournal.lineage.journal({ projectId, threadId, taskId: uuid(1) }),
          ).pipe(Effect.flip);
          expect(hJournal.attempts).toEqual([
            { type: "bridget.lineage.unavailable", threadId, ok: true },
          ]);
        }
      }),
  );
});
