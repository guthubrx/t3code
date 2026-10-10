import {
  BridgetLineageError,
  CommandId,
  ThreadId,
  type BridgetLineageReadInput,
  type BridgetLineageWatchInput,
  type BridgetLineageCancelInput,
  type BridgetLineageView,
  type BridgetLineageCancelResult,
  type BridgetLineageJournal,
  type BridgetWatchEvent,
  type BridgetLineageSnapshot,
  type BridgetLineageJournalInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BridgetReader from "./BridgetReader.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

export class BridgetLineage extends Context.Service<
  BridgetLineage,
  {
    readonly read: (
      input: BridgetLineageReadInput,
    ) => Effect.Effect<BridgetLineageView, BridgetLineageError>;
    readonly watch: (
      input: BridgetLineageWatchInput,
    ) => Stream.Stream<BridgetWatchEvent, BridgetLineageError>;
    readonly journal: (
      input: BridgetLineageJournalInput,
    ) => Stream.Stream<BridgetLineageJournal, BridgetLineageError>;
    readonly cancel: (
      input: BridgetLineageCancelInput,
    ) => Effect.Effect<BridgetLineageCancelResult, BridgetLineageError>;
  }
>()("t3/bridget/BridgetLineage") {}

const make = Effect.gen(function* () {
  const reader = yield* BridgetReader.BridgetReader;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Crypto.Crypto;
  const commandId = crypto.randomUUIDv4.pipe(
    Effect.map((id) => CommandId.make(`bridget-lineage:${id}`)),
    Effect.orDie,
  );
  const unavailable = (input: BridgetLineageWatchInput, taskThreadId?: ThreadId) =>
    Effect.gen(function* () {
      const { thread: root } = yield* orchestrator.getThreadRecords(input.threadId, []);
      // A caller-provided context that the reader refused cannot invalidate a
      // different project or use a virtual child as an authoritative root.
      if (root.projectId !== input.projectId || root.bridgetTaskRef !== undefined) return;
      const threadId = taskThreadId ?? input.threadId;
      if (taskThreadId !== undefined) {
        const { thread: child } = yield* orchestrator.getThreadRecords(taskThreadId, []);
        if (child.projectId !== input.projectId || child.bridgetTaskRef?.rootThreadId !== root.id)
          return;
      }
      yield* orchestrator.dispatch({
        type: "bridget.lineage.unavailable",
        commandId: yield* commandId,
        threadId,
      });
    }).pipe(Effect.ignore);
  const observeFailure = (
    input: BridgetLineageWatchInput | BridgetLineageReadInput | BridgetLineageJournalInput,
    error: BridgetLineageError,
  ): Effect.Effect<void> => {
    // A missing journal or invalid result offset says nothing about the root's
    // authority or the other tasks observed by its independently guarded watch.
    switch (error.code) {
      case "journal_unavailable":
      case "result_offset_invalid":
      case "invalid_request":
      case "envelope_mismatch":
        return Effect.void;
      case "task_unavailable":
        return "taskId" in input
          ? unavailable(input, ThreadId.make(`thread:bridget-task:${input.taskId}`))
          : unavailable(input);
      default:
        return unavailable(input);
    }
  };
  // O(n): bounded native pages stage before the single atomic projection command.
  const snapshotAttempt = (
    input: BridgetLineageWatchInput,
    remaining: number,
  ): Effect.Effect<BridgetLineageSnapshot, BridgetLineageError> =>
    reader
      .lineageSnapshot(input)
      .pipe(
        Effect.catch((error) =>
          error.code === "snapshot_changed" && remaining > 1
            ? snapshotAttempt(input, remaining - 1)
            : Effect.fail(error),
        ),
      );
  const synchronize = Effect.fn("BridgetLineage.synchronize")(function* (
    input: BridgetLineageWatchInput,
  ): Effect.fn.Return<BridgetLineageSnapshot, BridgetLineageError> {
    const snapshot = yield* snapshotAttempt(input, 3);
    yield* orchestrator
      .dispatch({
        type: "bridget.lineage.sync",
        commandId: yield* commandId,
        threadId: input.threadId,
        snapshot,
      })
      .pipe(Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })));
    return snapshot;
  });
  const read = (
    input: BridgetLineageReadInput,
  ): Effect.Effect<BridgetLineageView, BridgetLineageError> =>
    Effect.gen(function* () {
      if (input.action === "list") return yield* synchronize(input);
      return yield* reader.lineageRead(input);
    }).pipe(Effect.tapError((error) => observeFailure(input, error)));
  const watch = (
    input: BridgetLineageWatchInput,
  ): Stream.Stream<BridgetWatchEvent, BridgetLineageError> =>
    reader.lineageWatch(input).pipe(
      Stream.mapEffect((event) => synchronize(input).pipe(Effect.as(event))),
      Stream.catch((error) =>
        Stream.fromEffect(observeFailure(input, error)).pipe(
          Stream.flatMap(() => Stream.fail(error)),
        ),
      ),
    );
  return BridgetLineage.of({
    read,
    watch,
    journal: (input) =>
      reader
        .lineageJournal(input)
        .pipe(
          Stream.catch((error) =>
            Stream.fromEffect(observeFailure(input, error)).pipe(
              Stream.flatMap(() => Stream.fail(error)),
            ),
          ),
        ),
    cancel: reader.lineageCancel,
  });
});

export const layer = Layer.effect(BridgetLineage, make);
