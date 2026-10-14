// Session 149 — server lineage lot (L). Oracles from specs/149-sous-agents-lineage/contracts/lineage.md:
// snapshot staging is atomic and bounded, refusals stay closed, and no free text becomes authority.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type BridgetLineageJournal,
  type BridgetLineageSnapshot,
  type BridgetLineageTaskV3,
  ProjectId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as BridgetReader from "./BridgetReader.ts";

const uuid = (n: number) =>
  `${String(n % 100000000).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const threadId = ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac");
const projectId = ProjectId.make("project-lineage-149");
const workspaceRoot = "/project with spaces/$(forged); é";
const input = { threadId, projectId };

const task = (overrides: Partial<BridgetLineageTaskV3> = {}): BridgetLineageTaskV3 => ({
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
  placement: null,
  decision: null,
  ...overrides,
});
const snapshot = (
  tasks: BridgetLineageTaskV3[],
  overrides: Partial<Extract<BridgetLineageSnapshot, { readonly version: 3 }>> = {},
): Extract<BridgetLineageSnapshot, { readonly version: 3 }> => ({
  version: 3,
  status: "ok",
  generation: uuid(900),
  seq: 7,
  root_owner_agent_id: uuid(901),
  tasks,
  next_cursor: null,
  ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}): unknown => ({
  version: 3,
  status: "ok",
  generation: uuid(900),
  seq: 7,
  root_owner_agent_id: uuid(901),
  task: task(),
  result: null,
  result_offset: 0,
  result_next_offset: null,
  result_total_bytes: 0,
  ...overrides,
});
const journalEvent = (seq: number) => ({
  v: 1 as const,
  seq,
  ts: "2026-10-10T00:00:00.000Z",
  session_id: uuid(55),
  event: "prompt",
  payload: { ok: true },
});
const journal = (overrides: Partial<BridgetLineageJournal> = {}): BridgetLineageJournal => ({
  version: 1,
  status: "ok",
  task_id: uuid(1),
  events: [journalEvent(1), journalEvent(2)],
  next_seq: 5,
  caught_up: true,
  gap: null,
  ...overrides,
});
const refusal = (code: string, retryable = false) => ({
  version: 1,
  status: "error",
  code,
  ...(retryable ? { retryable: true } : {}),
});

const encode = (value: unknown) => JSON.stringify(value);
const output = (stdout: unknown, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout: typeof stdout === "string" ? stdout : encode(stdout),
  stderr: "private diagnostic secret",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

interface HarnessOptions {
  readonly deletedThread?: boolean;
  readonly virtualThread?: boolean;
  readonly missingThread?: boolean;
  readonly differentProject?: boolean;
  readonly missingProject?: boolean;
  /** Outputs served in order; the last one repeats once the queue is empty. */
  readonly results?: ReadonlyArray<ProcessRunner.ProcessRunOutput>;
  readonly error?: ProcessRunner.ProcessRunError;
  readonly streamOutput?: Stream.Stream<Uint8Array>;
}

const harness = Effect.fn("BridgetReader149.harness")(function* (options: HarnessOptions = {}) {
  const calls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly maxOutputBytes: number | undefined;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected shell command");
        calls.push({ args: command.args, maxOutputBytes: -1 });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(147),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: options.streamOutput ?? Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
      () => Effect.sync(() => {}),
    ),
  );
  const shell = {
    id: threadId,
    projectId: options.differentProject ? ProjectId.make("another-lineage-project") : projectId,
    deletedAt: options.deletedThread === true ? DateTime.toDateUtc(DateTime.makeUnsafe(0)) : null,
    ...(options.virtualThread === true
      ? {
          bridgetTaskRef: {
            version: 1,
            taskId: uuid(1),
            rootThreadId: ThreadId.make("thread:root"),
            parentTaskId: null,
            generation: uuid(900),
            seq: 7,
            status: "working",
          },
        }
      : {}),
  } as unknown as OrchestrationV2ThreadShell;
  const snapshots = ProjectionStoreV2.of({
    getThreadShell: () => Effect.succeed(options.missingThread ? null : shell),
  } as unknown as ProjectionStoreV2["Service"]);
  const projects = ProjectStoreV2.of({
    getShell: () =>
      Effect.succeed(
        options.missingProject
          ? Option.none()
          : Option.some({ id: projectId, workspaceRoot } as OrchestrationProjectShell),
      ),
  } as unknown as ProjectStoreV2["Service"]);
  const queued: Array<ProcessRunner.ProcessRunOutput> = [...(options.results ?? [])];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (request) => {
      const next = queued.length === 0 ? output(snapshot([])) : (queued.shift() ?? queued[0]!);
      calls.push({ args: request.args, maxOutputBytes: request.maxOutputBytes });
      return options.error ? Effect.fail(options.error) : Effect.succeed(next);
    },
  });
  const reader = yield* BridgetReader.BridgetReader.pipe(
    Effect.provide(
      BridgetReader.layer.pipe(
        Layer.provide(Layer.succeed(ProjectionStoreV2, snapshots)),
        Layer.provide(Layer.succeed(ProjectStoreV2, projects)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.succeed(HostProcessEnvironment, {
            T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
            PATH: "/usr/bin:/bin",
          }),
        ),
        Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
      ),
    ),
  );
  return { reader, calls };
});

describe("BridgetReader149 lineage context", () => {
  it.effect.each([
    { name: "missing thread", options: { missingThread: true } },
    { name: "deleted thread", options: { deletedThread: true } },
    { name: "virtual child as context", options: { virtualThread: true } },
    { name: "missing project", options: { missingProject: true } },
  ])("refuses $name before any spawn with binding_unavailable", ({ options }) =>
    Effect.gen(function* () {
      const h = yield* harness(options);
      expect((yield* h.reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "binding_unavailable",
      );
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("maps a project mismatch to project_mismatch and never spawns", () =>
    Effect.gen(function* () {
      const h = yield* harness({ differentProject: true });
      expect((yield* h.reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "project_mismatch",
      );
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("resolves the workspace root on the server side, never from the caller", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness();
      yield* reader.lineageSnapshot({ ...input, projectRoot: "/forged" } as typeof input);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toContain(workspaceRoot);
      expect(calls[0]!.args).not.toContain("/forged");
    }),
  );
  it.effect("carries the resolved server workspace root in fixed lineage argv", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness();
      yield* reader.lineageSnapshot(input);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([
        "lineage",
        "inspect",
        "--t3-thread",
        threadId,
        "--project-root",
        workspaceRoot,
        "--response-version",
        "3",
        "--action",
        "list",
        "--limit",
        "100",
        "--json",
      ]);
      expect(calls[0]!.maxOutputBytes).toBe(128 * 1024 + 1024);
    }),
  );
});

describe("BridgetReader149 lineage snapshot staging", () => {
  it.effect("stages pages atomically and passes one cursor per page", () =>
    Effect.gen(function* () {
      const first = snapshot([task()], { next_cursor: "cursor-1" });
      const second = snapshot([
        task({ task_id: uuid(2), parent_task_id: uuid(1), title: "Nested" }),
      ]);
      const { reader, calls } = yield* harness({ results: [output(first), output(second)] });
      expect(yield* reader.lineageSnapshot(input)).toEqual({
        ...second,
        tasks: [...first.tasks, ...second.tasks],
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args).not.toContain("--cursor");
      expect(calls[1]!.args.slice(-3)).toEqual(["--cursor", "cursor-1", "--json"]);
    }),
  );
  it.effect.each([
    {
      name: "the sequence moved",
      first: snapshot([task()], { seq: 7, next_cursor: "cursor-1" }),
      second: snapshot([task()], { seq: 8 }),
    },
    {
      name: "the generation moved",
      first: snapshot([task()], { generation: uuid(900), next_cursor: "cursor-1" }),
      second: snapshot([task()], { generation: uuid(910) }),
    },
    {
      name: "the root owner moved",
      first: snapshot([task()], { root_owner_agent_id: uuid(901), next_cursor: "cursor-1" }),
      second: snapshot([task()], { root_owner_agent_id: uuid(911) }),
    },
    {
      name: "a page carried more than the page size",
      first: snapshot(
        Array.from({ length: 101 }, (_, index) => task({ task_id: uuid(index + 1) })),
        { next_cursor: "cursor-1" },
      ),
      second: snapshot([]),
    },
  ])("fails staging with snapshot_changed when $name", ({ first, second }) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [output(first), output(second)] });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "snapshot_changed",
      );
    }),
  );
  it.effect("keeps the 4096 task projection limit with resource_limit", () =>
    Effect.gen(function* () {
      const page = (index: number) =>
        output(
          snapshot(
            Array.from({ length: 100 }, (_, offset) =>
              task({
                task_id: uuid(index * 100 + offset + 1),
                parent_task_id: index === 0 && offset === 0 ? null : uuid(index * 100 + offset),
              }),
            ),
            { next_cursor: `cursor-${index + 1}` },
          ),
        );
      const { reader, calls } = yield* harness({
        results: Array.from({ length: 41 }, (_, index) => page(index)),
      });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe("resource_limit");
      expect(calls).toHaveLength(41);
    }),
  );
  it.effect("refuses a cursor loop and a non-null cursor with no rows as invalid_output", () =>
    Effect.gen(function* () {
      const looping = yield* harness({
        results: [
          output(snapshot([task()], { next_cursor: "cursor-1" })),
          output(snapshot([], { next_cursor: "cursor-1" })),
        ],
      });
      expect((yield* looping.reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "invalid_output",
      );
      const empty = yield* harness({
        results: [output(snapshot([], { next_cursor: "cursor-1" })), output(snapshot([]))],
      });
      expect((yield* empty.reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "invalid_output",
      );
    }),
  );
  it.effect("returns a task-free final snapshot for an empty lineage", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({ results: [output(snapshot([]))] });
      expect(yield* reader.lineageSnapshot(input)).toEqual(snapshot([]));
      expect(calls).toHaveLength(1);
    }),
  );
});

describe("BridgetReader149 closed refusals and transport bounds", () => {
  it.effect.each([
    { name: "task_unavailable", code: "task_unavailable", exit: 2 },
    { name: "binding_unavailable", code: "binding_unavailable", exit: 2 },
    { name: "envelope_mismatch", code: "envelope_mismatch", exit: 2 },
    { name: "store_unavailable", code: "store_unavailable", exit: 3 },
  ])("preserves the daemon refusal $name across the reader", ({ code, exit }) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [output(refusal(code), exit)] });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(code);
    }),
  );
  it.effect("refuses an unknown refusal code as invalid_output", () =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [output(refusal("forbidden"))] });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe("invalid_output");
    }),
  );
  it.effect.each([
    {
      name: "an oversized body",
      make: () => output(" ".repeat(128 * 1024 + 1)),
      code: "output_limit",
    },
    {
      name: "invalid utf-8",
      make: () => ({ ...output(snapshot([])), stdoutInvalidUtf8: true }),
      code: "invalid_output",
    },
    {
      name: "a non-zero exit over a valid body",
      make: () => output(snapshot([]), 3),
      code: "unavailable",
    },
    {
      name: "a failed process over a valid body",
      make: () => output(snapshot([]), 1),
      code: "command_failed",
    },
    { name: "malformed json", make: () => output("not json"), code: "invalid_output" },
  ] as const)("maps $name to its closed reader error", ({ make, code }) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [make()] });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(code);
    }),
  );
  it.effect("maps runner timeouts, output limits and spawn failures to fixed errors", () =>
    Effect.gen(function* () {
      for (const [error, code] of [
        [
          new ProcessRunner.ProcessTimeoutError({
            command: "bridget",
            argumentCount: 1,
            timeoutMs: 6000,
          }),
          "timeout",
        ],
        [
          new ProcessRunner.ProcessOutputLimitError({
            command: "bridget",
            argumentCount: 1,
            stream: "stdout",
            maxBytes: 129024,
            observedBytes: 129025,
          }),
          "output_limit",
        ],
        [
          new ProcessRunner.ProcessSpawnError({
            command: "bridget",
            argumentCount: 1,
            cause: "absent",
          }),
          "unavailable",
        ],
      ] as const) {
        const { reader } = yield* harness({ error });
        expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(code);
      }
    }),
  );
});

describe("BridgetReader149 detail and journal reads", () => {
  it.effect("reads a result window with offset and limit arguments", () =>
    Effect.gen(function* () {
      const result = "nonce-result";
      const { reader, calls } = yield* harness({
        results: [
          output(
            detail({
              task: task(),
              result,
              result_offset: 8,
              result_next_offset: 8 + result.length,
              result_total_bytes: 32,
            }),
          ),
        ],
      });
      expect(
        yield* reader.lineageRead({
          ...input,
          action: "show",
          taskId: uuid(1),
          offset: 8,
          limit: 1024,
        }),
      ).toMatchObject({ task: { task_id: uuid(1) }, result, result_offset: 8 });
      expect(calls[0]!.args.slice(-7)).toEqual([
        "--task",
        uuid(1),
        "--json",
        "--limit",
        "1024",
        "--offset",
        "8",
      ]);
      expect(calls[0]!.maxOutputBytes).toBe(24 * 1024 + 1024);
    }),
  );
  it.effect.each([
    { name: "a task id mismatch", detail: detail({ task: task({ task_id: uuid(9) }) }) },
    { name: "an offset mismatch", detail: detail({ result_offset: 4 }) },
    {
      name: "a window beyond the total",
      detail: detail({ result: "12345", result_total_bytes: 3, result_next_offset: 5 }),
    },
    {
      name: "a next offset disagreeing with the window",
      detail: detail({ result: "12345", result_total_bytes: 5, result_next_offset: 4 }),
    },
    {
      name: "an empty window with a next offset",
      detail: detail({ result: "", result_total_bytes: 5, result_next_offset: 0 }),
    },
  ])("refuses a show reply with $name as invalid_output", ({ detail: value }) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [output(value)] });
      expect(
        (yield* reader.lineageRead({ ...input, action: "show", taskId: uuid(1) }).pipe(Effect.flip))
          .code,
      ).toBe("invalid_output");
    }),
  );
  it.effect("bounds the show result window to the requested limit", () =>
    Effect.gen(function* () {
      const { reader } = yield* harness({
        results: [
          output(
            detail({ result: "x".repeat(17), result_total_bytes: 64, result_next_offset: 17 }),
          ),
        ],
      });
      expect(
        (yield* reader
          .lineageRead({ ...input, action: "show", taskId: uuid(1), limit: 16 })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_output");
    }),
  );
  it.effect("reads a journal page and passes after-seq verbatim", () =>
    Effect.gen(function* () {
      const page = journal({ events: [journalEvent(3), journalEvent(4)] });
      const { reader, calls } = yield* harness({ results: [output(page)] });
      expect(
        yield* reader.lineageRead({
          ...input,
          action: "journal",
          taskId: uuid(1),
          afterSeq: 2,
          limit: 50,
        }),
      ).toEqual(page);
      expect(calls[0]!.args.slice(-7)).toEqual([
        "--task",
        uuid(1),
        "--json",
        "--limit",
        "50",
        "--after-seq",
        "2",
      ]);
      // Transport budget only — lineage.md does not fix it; BridgetReader unifies
      // show and journal pages on a 24 KiB envelope plus 1 KiB of JSON overhead.
      expect(calls[0]!.maxOutputBytes).toBe(24 * 1024 + 1024);
    }),
  );
  it.effect.each([
    { name: "a task id mismatch", journal: journal({ task_id: uuid(9) }), afterSeq: 0 },
    { name: "a next_seq before the request", journal: journal({ next_seq: 1 }), afterSeq: 2 },
    {
      name: "an inverted gap",
      journal: journal({ gap: { from_seq: 9, to_seq: 4, reason: "loss" } }),
      afterSeq: 0,
    },
    {
      name: "non-increasing events",
      journal: journal({ events: [journalEvent(3), journalEvent(3)] }),
      afterSeq: 0,
    },
    {
      name: "an event beyond next_seq",
      journal: journal({ events: [journalEvent(9)] }),
      afterSeq: 0,
    },
    {
      name: "an event at the resume boundary",
      journal: journal({ events: [journalEvent(1)] }),
      afterSeq: 1,
    },
  ])("refuses a journal reply with $name as invalid_output", ({ journal: value, afterSeq }) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ results: [output(value)] });
      expect(
        (yield* reader
          .lineageRead({ ...input, action: "journal", taskId: uuid(1), afterSeq })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_output");
    }),
  );
  it.effect("returns the cancel receipt with the exact task and request identity", () =>
    Effect.gen(function* () {
      const receipt = { version: 1, task_id: uuid(1), status: "cancelling" };
      const { reader, calls } = yield* harness({ results: [output(receipt)] });
      expect(
        yield* reader.lineageCancel({ ...input, taskId: uuid(1), requestId: uuid(2) }),
      ).toEqual(receipt);
      expect(calls[0]!.args).toEqual([
        "lineage",
        "cancel",
        "--t3-thread",
        threadId,
        "--project-root",
        workspaceRoot,
        "--task",
        uuid(1),
        "--request-id",
        uuid(2),
        "--json",
      ]);
      expect(calls[0]!.maxOutputBytes).toBe(4096 + 1024);
    }),
  );
  it.effect("refuses a cancel receipt for another task as invalid_output", () =>
    Effect.gen(function* () {
      const { reader } = yield* harness({
        results: [output({ version: 1, task_id: uuid(9), status: "cancelling" })],
      });
      expect(
        (yield* reader
          .lineageCancel({ ...input, taskId: uuid(1), requestId: uuid(2) })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_output");
    }),
  );
});

describe("BridgetReader149 lineage watch", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(`${encode(value)}\n`);
  const ready = { version: 1, generation: uuid(900), seq: 0, status: "ready" };

  it.effect("passes ready, changed and resync without collecting a final body", () =>
    Effect.gen(function* () {
      const events = [
        ready,
        { ...ready, seq: 1, status: "changed" },
        { ...ready, generation: uuid(910), seq: 0, status: "resync" },
        { ...ready, generation: uuid(910), seq: 1, status: "changed" },
      ];
      const h = yield* harness({
        streamOutput: Stream.make(...events.map((event) => bytes(event))).pipe(
          Stream.concat(Stream.never),
        ),
      });
      expect(
        yield* h.reader
          .lineageWatch(input)
          .pipe(Stream.take(4), Stream.runCollect, Effect.map(Array.from)),
      ).toEqual(events);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.args.slice(0, 2)).toEqual(["lineage", "watch"]);
    }),
  );
  it.effect.each([
    { name: "the first event is not ready", lines: [{ ...ready, seq: 1, status: "changed" }] },
    { name: "the first event is not at seq zero", lines: [{ ...ready, seq: 3 }] },
    { name: "a second ready appears", lines: [ready, ready] },
    {
      name: "the sequence regresses",
      lines: [
        ready,
        { ...ready, seq: 2, status: "changed" },
        { ...ready, seq: 2, status: "changed" },
      ],
    },
    {
      name: "the generation changes without resync",
      lines: [ready, { ...ready, generation: uuid(910), seq: 5, status: "changed" }],
    },
    { name: "an unknown status appears", lines: [ready, { ...ready, seq: 1, status: "reset" }] },
    { name: "a free-text body rides an event", lines: [{ ...ready, body: "private" }] },
  ])("refuses a lineage watch stream where $name", ({ lines }) =>
    Effect.gen(function* () {
      const h = yield* harness({
        streamOutput: Stream.make(...lines.map((line) => bytes(line))),
      });
      expect((yield* Stream.runDrain(h.reader.lineageWatch(input)).pipe(Effect.flip)).code).toBe(
        "invalid_output",
      );
    }),
  );
  it.effect("preserves daemon refusal lines during the watch", () =>
    Effect.gen(function* () {
      for (const code of ["binding_unavailable", "task_unavailable", "snapshot_changed"]) {
        const h = yield* harness({
          streamOutput: Stream.make(bytes({ version: 1, status: "error", code })),
        });
        expect((yield* Stream.runDrain(h.reader.lineageWatch(input)).pipe(Effect.flip)).code).toBe(
          code,
        );
      }
    }),
  );
  it.effect("rejects invalid utf-8, oversized lines and truncated endings", () =>
    Effect.gen(function* () {
      for (const [chunk, code] of [
        [new TextEncoder().encode("x".repeat(4097)), "output_limit"],
        [new TextEncoder().encode(`${encode(ready).padEnd(4097)}\n`), "output_limit"],
        [new Uint8Array([0xff, 10]), "invalid_output"],
        [bytes(ready).slice(0, 20), "invalid_output"],
        [bytes(ready), "command_failed"],
      ] as const) {
        const h = yield* harness({ streamOutput: Stream.make(chunk) });
        expect((yield* Stream.runDrain(h.reader.lineageWatch(input)).pipe(Effect.flip)).code).toBe(
          code,
        );
      }
    }),
  );
  it.effect("expires only the initial lineage watch handshake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const h = yield* harness({
          streamOutput: Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
        });
        const fiber = yield* Stream.runDrain(h.reader.lineageWatch(input)).pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber).pipe(Effect.flip)).code).toBe("timeout");
      }),
    ),
  );
});

describe("BridgetReader149 lineage journal follow", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(`${encode(value)}\n`);

  it.effect("follows journal pages and advances the resume sequence", () =>
    Effect.gen(function* () {
      const first = journal({ next_seq: 5 });
      const second = journal({ events: [journalEvent(6), journalEvent(7)], next_seq: 7 });
      const h = yield* harness({
        streamOutput: Stream.make(...[first, second].map((page) => bytes(page))).pipe(
          Stream.concat(Stream.never),
        ),
      });
      expect(
        yield* h.reader
          .lineageJournal({ ...input, taskId: uuid(1) })
          .pipe(Stream.take(2), Stream.runCollect, Effect.map(Array.from)),
      ).toEqual([first, second]);
      expect(h.calls[0]!.args).toEqual([
        "lineage",
        "inspect",
        "--t3-thread",
        threadId,
        "--project-root",
        workspaceRoot,
        "--action",
        "journal",
        "--task",
        uuid(1),
        "--after-seq",
        "0",
        "--limit",
        "100",
        "--follow",
        "--json",
      ]);
    }),
  );
  it.effect.each([
    {
      name: "an event replaying the resume boundary",
      pages: [journal({ next_seq: 5 }), journal({ events: [journalEvent(5)], next_seq: 9 })],
    },
    {
      name: "a page beyond the durable boundary",
      pages: [journal({ next_seq: 5 }), journal({ events: [journalEvent(6)], next_seq: 5 })],
    },
    {
      name: "an inverted gap",
      pages: [journal({ gap: { from_seq: 8, to_seq: 2, reason: "loss" } })],
    },
  ])("refuses a followed journal with $name", ({ pages }) =>
    Effect.gen(function* () {
      const h = yield* harness({
        streamOutput: Stream.make(...pages.map((page) => bytes(page))),
      });
      expect(
        (yield* Stream.runDrain(h.reader.lineageJournal({ ...input, taskId: uuid(1) })).pipe(
          Effect.flip,
        )).code,
      ).toBe("invalid_output");
    }),
  );
  it.effect("refuses a truncated followed line and a clean journal stream end", () =>
    Effect.gen(function* () {
      const truncated = yield* harness({
        streamOutput: Stream.make(bytes(journal()).slice(0, 30)),
      });
      expect(
        (yield* Stream.runDrain(
          truncated.reader.lineageJournal({ ...input, taskId: uuid(1) }),
        ).pipe(Effect.flip)).code,
      ).toBe("invalid_output");
      const clean = yield* harness({ streamOutput: Stream.make(bytes(journal())) });
      expect(
        (yield* Stream.runDrain(clean.reader.lineageJournal({ ...input, taskId: uuid(1) })).pipe(
          Effect.flip,
        )).code,
      ).toBe("command_failed");
    }),
  );
});

describe("BridgetReader162 negotiated remote metadata", () => {
  const placement = {
    machine_id: "cartae",
    display_name: "Cartae",
    worker_id: "worker-cartae",
    last_contact_at: 1790000010,
    contact_state: "connected" as const,
  };
  const { placement: _placement, decision: _decision, ...legacyTask } = task();
  const legacySnapshot = { ...snapshot([]), version: 1, tasks: [legacyTask] };
  const legacyDetail = {
    version: 1,
    status: "ok",
    generation: uuid(900),
    seq: 7,
    root_owner_agent_id: uuid(901),
    task: legacyTask,
    result: null,
    result_offset: 0,
    result_next_offset: null,
    result_total_bytes: 0,
  };

  const v2Snapshot = (
    rows: ReadonlyArray<BridgetLineageTaskV3> = [task()],
    nextCursor: string | null = null,
  ) => ({
    ...snapshot([]),
    version: 2,
    tasks: rows.map(({ decision: _decision, ...row }) => row),
    next_cursor: nextCursor,
  });
  const v2Detail = { ...legacyDetail, version: 2, task: { ...legacyTask, placement } };

  it.effect(
    "reads v3 placement and decision once and keeps contact observations from each page",
    () =>
      Effect.gen(function* () {
        const first = snapshot(
          [
            task({
              placement,
              decision: {
                mode: "automatic",
                candidate_id: "c01",
                reason: "profil autorisé",
              },
            }),
          ],
          { next_cursor: "next" },
        );
        const second = snapshot([
          task({
            task_id: uuid(2),
            placement: { ...placement, last_contact_at: 1790000011 },
          }),
        ]);
        const { reader, calls } = yield* harness({ results: [output(first), output(second)] });
        const result = yield* reader.lineageSnapshot(input);
        expect(result).toEqual({
          ...first,
          tasks: [...first.tasks, ...second.tasks],
          next_cursor: null,
        });
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => call.args?.includes("--response-version"))).toBe(true);
      }),
  );

  it.effect.each(["invalid_request", "unsupported_version"])(
    "falls back exactly once to closed v1 after the structured %s refusal",
    (code) =>
      Effect.gen(function* () {
        const { reader, calls } = yield* harness({
          results: [
            output(refusal("unsupported_version"), 2),
            output(refusal(code), 2),
            output(legacySnapshot),
          ],
        });
        expect(yield* reader.lineageSnapshot(input)).toEqual(legacySnapshot);
        expect(calls).toHaveLength(3);
        expect(calls[0]!.args).toContain("3");
        expect(calls[1]!.args).toContain("2");
        expect(calls[2]!.args).not.toContain("--response-version");
        expect(calls[2]!.args).not.toContain("--cursor");
      }),
  );

  it.effect(
    "discards every v2 page before restarting the v1 snapshot at cursor zero after v3 refusal",
    () =>
      Effect.gen(function* () {
        const first = snapshot([task({ task_id: uuid(77), placement })], {
          next_cursor: "v2-cursor",
        });
        const { reader, calls } = yield* harness({
          results: [
            output(refusal("unsupported_version"), 2),
            output(v2Snapshot(first.tasks, "v2-cursor")),
            output(refusal("unsupported_version"), 2),
            output(legacySnapshot),
          ],
        });
        expect(yield* reader.lineageSnapshot(input)).toEqual(legacySnapshot);
        expect(calls).toHaveLength(4);
        expect(calls[2]!.args).toContain("v2-cursor");
        expect(calls[3]!.args).not.toContain("--cursor");
        expect(calls[3]!.args).not.toContain("--response-version");
      }),
  );

  it.effect("keeps a refused final fallback closed without a fourth attempt", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({
        results: [
          output(refusal("unsupported_version"), 2),
          output(refusal("invalid_request"), 2),
          output(refusal("unsupported_version"), 2),
        ],
      });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "unsupported_version",
      );
      expect(calls).toHaveLength(3);
    }),
  );

  it.effect.each([
    "invalid_request",
    "binding_unavailable",
    "project_mismatch",
    "task_unavailable",
    "store_unavailable",
  ])("does not downgrade another structured refusal: %s", (code) =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({
        results: [output(refusal(code), 2), output(legacySnapshot)],
      });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(code);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "implicit v1 success", response: output(legacySnapshot) },
    { name: "future success", response: output({ ...snapshot([]), version: 4 }) },
    { name: "malformed JSON", response: output("not JSON") },
    { name: "missing placement", response: output({ ...snapshot([]), tasks: [legacyTask] }) },
    { name: "non-v1 error", response: output({ ...refusal("invalid_request"), version: 2 }, 2) },
  ])("does not downgrade $name", ({ response }) =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({ results: [response, output(legacySnapshot)] });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe("invalid_output");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("does not downgrade a timeout", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({
        results: [{ ...output(snapshot([])), timedOut: true }, output(legacySnapshot)],
      });
      expect((yield* reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe("timeout");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect(
    "negotiates detail v3 and falls back twice without changing the requested result window",
    () =>
      Effect.gen(function* () {
        const rich = detail({
          task: task({
            placement,
            decision: {
              mode: "fallback",
              candidate_id: "c02",
              reason: "service indisponible",
            },
          }),
        });
        const success = yield* harness({ results: [output(rich)] });
        expect(
          yield* success.reader.lineageRead({ ...input, action: "show", taskId: uuid(1) }),
        ).toEqual(rich);
        expect(success.calls).toHaveLength(1);
        const fallback = yield* harness({
          results: [
            output(refusal("unsupported_version"), 2),
            output(refusal("invalid_request"), 2),
            output(legacyDetail),
          ],
        });
        expect(
          yield* fallback.reader.lineageRead({
            ...input,
            action: "show",
            taskId: uuid(1),
            offset: 0,
            limit: 12,
          }),
        ).toEqual(legacyDetail);
        expect(fallback.calls).toHaveLength(3);
        expect(fallback.calls[2]!.args).not.toContain("--response-version");
        expect(fallback.calls[2]!.args.slice(-4)).toEqual(["--limit", "12", "--offset", "0"]);
      }),
  );

  it.effect("discards v3 staging before reading a homogeneous v2 snapshot and detail", () =>
    Effect.gen(function* () {
      const first = snapshot(
        [
          task({
            task_id: uuid(77),
            decision: {
              mode: "automatic",
              candidate_id: "c01",
              reason: "profil autorisé",
            },
          }),
        ],
        { next_cursor: "v3-cursor" },
      );
      const old = v2Snapshot();
      const list = yield* harness({
        results: [output(first), output(refusal("unsupported_version"), 2), output(old)],
      });
      expect(yield* list.reader.lineageSnapshot(input)).toEqual(old);
      expect(list.calls).toHaveLength(3);
      expect(list.calls[1]!.args).toContain("v3-cursor");
      expect(list.calls[2]!.args).toContain("2");
      expect(list.calls[2]!.args).not.toContain("--cursor");
      const show = yield* harness({
        results: [output(refusal("unsupported_version"), 2), output(v2Detail)],
      });
      expect(yield* show.reader.lineageRead({ ...input, action: "show", taskId: uuid(1) })).toEqual(
        v2Detail,
      );
      expect(show.calls).toHaveLength(2);
    }),
  );

  it.effect("refuses mixed success versions without downgrade or partial publication", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        results: [output(snapshot([task()], { next_cursor: "v3-cursor" })), output(v2Snapshot())],
      });
      expect((yield* h.reader.lineageSnapshot(input).pipe(Effect.flip)).code).toBe(
        "invalid_output",
      );
      expect(h.calls).toHaveLength(2);
    }),
  );

  it.effect.each([
    "invalid_request",
    "binding_unavailable",
    "project_mismatch",
    "store_unavailable",
  ])("does not downgrade a structured v3 detail refusal %s", (code) =>
    Effect.gen(function* () {
      const h = yield* harness({ results: [output(refusal(code), 2), output(v2Detail)] });
      expect(
        (yield* h.reader
          .lineageRead({ ...input, action: "show", taskId: uuid(1) })
          .pipe(Effect.flip)).code,
      ).toBe(code);
      expect(h.calls).toHaveLength(1);
    }),
  );

  it.effect("does not negotiate or replay journal reads and cancellation", () =>
    Effect.gen(function* () {
      for (const operation of ["journal", "cancel"] as const) {
        const { reader, calls } = yield* harness({
          results: [output(refusal("invalid_request"), 2)],
        });
        const request =
          operation === "journal"
            ? reader
                .lineageRead({ ...input, action: "journal", taskId: uuid(1) })
                .pipe(Effect.asVoid)
            : reader
                .lineageCancel({ ...input, taskId: uuid(1), requestId: uuid(55) })
                .pipe(Effect.asVoid);
        expect((yield* request.pipe(Effect.flip)).code).toBe("invalid_request");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).not.toContain("--response-version");
      }
    }),
  );
});
