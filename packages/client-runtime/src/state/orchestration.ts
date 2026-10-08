import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  BridgetReadError,
  type BridgetWatchEvent,
  type BridgetWatchInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";

export interface BridgetWatchState {
  readonly event: BridgetWatchEvent | null;
  readonly readyGeneration: string | null;
  readonly subscriptionId: symbol;
}

const isBridgetReadError = Schema.is(BridgetReadError);
const isTechnicalWatchFailure = (error: unknown): boolean =>
  isBridgetReadError(error) &&
  (error.code === "unavailable" || error.code === "timeout" || error.code === "command_failed");

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
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
            null,
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
  return {
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
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}
