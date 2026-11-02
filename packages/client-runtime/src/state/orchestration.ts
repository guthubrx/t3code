import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  BridgetReadError,
  BridgetLineageError,
  type BridgetWatchEvent,
  type BridgetWatchInput,
  type BridgetLineageWatchInput,
  type BridgetLineageJournalInput,
  type BridgetLineageJournal,
  type BridgetJournalEvent,
  type EnvironmentId,
  type ThreadId,
  type OrchestrationGetTurnDiffResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT } from "./commandOutput.ts";

import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentCommand,
  type QueryAnswerHandler,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  mergeJournalEvents,
  retainBridgetJournalGaps,
  type BridgetJournalConflict,
  type BridgetJournalContinuityCut,
  type BridgetJournalGap,
} from "../bridgetJournalPresentation.ts";

export interface BridgetWatchState {
  readonly event: BridgetWatchEvent | null;
  readonly readyGeneration: string | null;
  readonly subscriptionId: symbol;
}

const isBridgetReadError = Schema.is(BridgetReadError);
const isBridgetLineageError = Schema.is(BridgetLineageError);
const isTechnicalWatchFailure = (error: unknown): boolean =>
  isBridgetReadError(error) &&
  (error.code === "unavailable" || error.code === "timeout" || error.code === "command_failed");

export interface BridgetJournalState {
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly nextSeq: number;
  readonly caughtUp: boolean;
  /** Legacy latest marker remains available to current consumers. */
  readonly gap: BridgetLineageJournal["gap"];
  /** Ephemeral continuity boundaries; never persisted or sent over RPC. */
  readonly gaps: ReadonlyArray<BridgetJournalGap>;
  readonly continuityCut: BridgetJournalContinuityCut | null;
  readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
  readonly evicted: number;
}
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelayDpopSigner from "../relay/managedRelay.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  options: {
    /** Runs on each turn-range and full-thread diff the server answers. */
    readonly onCheckpointDiffAnswer?: QueryAnswerHandler<
      { readonly ignoreWhitespace?: boolean },
      OrchestrationGetTurnDiffResult
    >;
  } = {},
) {
  const watch = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:orchestration:bridget-watch",
    idleTtlMs: 0,
    subscribe: ({ context }: { readonly context: BridgetWatchInput; readonly visitId: string }) =>
      Stream.suspend(() => {
        const subscriptionId = Symbol("bridget-watch");
        let retries = 0;
        // Keep handshake proof when an atom consumer first sees a coalesced changed event.
        return subscribe(WS_METHODS.bridgetWatch, context).pipe(
          Stream.catch((error) =>
            isTechnicalWatchFailure(error)
              ? Stream.make(null).pipe(Stream.concat(Stream.fail(error)))
              : Stream.fail(error),
          ),
          Stream.retry(
            Schedule.spaced("1 second").pipe(
              // Stream.retry resets its schedule after values. Keep this budget per visit,
              // including attempts that emitted ready before their child failed.
              Schedule.while(({ input }) => isTechnicalWatchFailure(input) && retries++ < 3),
            ),
          ),
          Stream.scan<BridgetWatchState | null, BridgetWatchEvent | null>(
            () => null,
            (previous, event) => ({
              event,
              readyGeneration:
                event === null
                  ? null
                  : event.status === "ready"
                    ? event.generation
                    : (previous?.readyGeneration ?? null),
              subscriptionId,
            }),
          ),
          Stream.filter((state): state is BridgetWatchState => state !== null),
        );
      }),
  });
  const onCheckpointDiffAnswer =
    options.onCheckpointDiffAnswer === undefined
      ? {}
      : { onAnswer: options.onCheckpointDiffAnswer };
  return {
    bridgetLineageRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:bridget-lineage-read",
      tag: WS_METHODS.bridgetLineageRead,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    bridgetLineageWatch: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:bridget-lineage-watch",
      idleTtlMs: 0,
      subscribe: ({ context }: { context: BridgetLineageWatchInput; visitId: string }) =>
        Stream.suspend(() => {
          let retries = 0;
          return subscribe(WS_METHODS.bridgetLineageWatch, context).pipe(
            Stream.retry(
              Schedule.spaced("1 second").pipe(
                Schedule.while(
                  ({ input }) =>
                    isBridgetLineageError(input) &&
                    ["unavailable", "timeout", "command_failed", "store_unavailable"].includes(
                      input.code,
                    ) &&
                    retries++ < 3,
                ),
              ),
            ),
          );
        }),
    }),
    bridgetLineageJournal: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:bridget-lineage-journal",
      idleTtlMs: 0,
      subscribe: ({ context }: { context: BridgetLineageJournalInput; visitId: string }) =>
        subscribe(WS_METHODS.bridgetLineageJournal, context).pipe(
          // Preserve every envelope even when React coalesces several stream values.
          Stream.scan<BridgetJournalState, BridgetLineageJournal>(
            () => ({
              events: [],
              nextSeq: context.afterSeq ?? 0,
              caughtUp: false,
              gap: null,
              gaps: [],
              continuityCut: null,
              conflicts: [],
              evicted: 0,
            }),
            (previous, envelope) => {
              const merged = mergeJournalEvents(
                previous.events,
                envelope.events,
                previous.conflicts,
              );
              const firstRetainedSeq = merged.events[0]?.seq ?? null;
              const gapState = retainBridgetJournalGaps(
                { gaps: previous.gaps, continuityCut: previous.continuityCut },
                envelope.gap,
                firstRetainedSeq,
              );
              return {
                events: merged.events,
                nextSeq: envelope.next_seq,
                caughtUp: envelope.caught_up,
                gap: envelope.gap ?? previous.gap,
                gaps: gapState.gaps,
                continuityCut: gapState.continuityCut,
                conflicts: merged.conflicts,
                evicted: previous.evicted + merged.evicted,
              };
            },
          ),
        ),
    }),
    bridgetLineageCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:bridget-lineage-cancel",
      tag: WS_METHODS.bridgetLineageCancel,
    }),
    bridgetRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:bridget-read",
      tag: WS_METHODS.bridgetRead,
      staleTimeMs: 3_000,
      // Leave no pending human read alive when its last visiting consumer leaves.
      idleTtlMs: 0,
    }),
    bridgetWatch: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: BridgetWatchInput;
      readonly visitId: string;
    }) =>
      watch({
        environmentId: target.environmentId,
        input: { context: target.input, visitId: target.visitId },
      }),
    threadTranscript: createEnvironmentCommand(runtime, {
      label: "environment-data:orchestration:thread-transcript",
      execute: Effect.fn("orchestration.execute")(function* (input: {
        readonly threadId: ThreadId;
      }) {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return yield* new EnvironmentRpcUnavailableError({
            environmentId: supervisor.target.environmentId,
            message: "The source environment is not connected.",
          });
        }
        return yield* fetchEnvironmentThreadTranscript({
          prepared: prepared.value,
          threadId: input.threadId,
          signer: yield* Effect.serviceOption(ManagedRelayDpopSigner.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
        });
      }),
    }),
    v2: {
      dispatchCommand: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:orchestration-v2:dispatch-command",
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      }),
      shell: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:shell",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      }),
      thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:thread",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        idleTtlMs: 0,
      }),
      // One expanded command row's output. Mounted only while the row is open,
      // and released as soon as it closes, so hidden rows receive nothing.
      commandOutput: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
        label: "environment-data:orchestration-v2:command-output",
        tag: ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
        idleTtlMs: 0,
        // `scan` emits its seed first; skipping it keeps the row "loading" until the first frame.
        transform: (frames) =>
          frames.pipe(
            Stream.scan(() => EMPTY_COMMAND_OUTPUT, applyCommandOutputFrame),
            Stream.filter((view) => view !== EMPTY_COMMAND_OUTPUT),
          ),
      }),
    },
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
      ...onCheckpointDiffAnswer,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    // Mounted only while a subagent inspector is open; running children change between opens.
    nativeChildWork: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:native-child-work",
      tag: ORCHESTRATION_V2_WS_METHODS.getNativeChildWork,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    stopWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:stop-workflow",
      tag: ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
    }),
    forceStopThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:force-stop-thread",
      tag: ORCHESTRATION_V2_WS_METHODS.forceStopThread,
    }),
    turnItem: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-item",
      tag: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
      ...onCheckpointDiffAnswer,
    }),
    threadFind: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThread,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    threadFindProgressive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-find-progressive",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
      completeWhen: (result) => result.complete !== false,
      idleTtlMs: 0,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    }),
    // Read right before deleting a worktree, so never served from cache.
    worktreeThreadIds: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:worktree-thread-ids",
      tag: ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
  };
}
