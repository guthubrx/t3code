import {
  AuthOrchestrationOperateScope,
  type BridgetComposerOperation,
  type BridgetComposerState,
  type BridgetLineageComposeInput,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type ProviderOptionSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useStableCallback } from "~/hooks/useStableCallback";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { randomUUID } from "~/lib/utils";
import { bridgetComposerProvider, bridgetComposerSelection } from "./BridgetComposer.logic";

/** Native command lifetime; neither the renderer nor this hook can create a T3 run. */
export function useBridgetComposer(input: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  thread: Pick<
    OrchestrationV2AppThread,
    "projectId" | "bridgetTaskRef" | "bridgetTask" | "runtimeMode"
  > | null;
}) {
  const { environmentId, threadRef, thread } = input;
  const ref = thread?.bridgetTaskRef;
  const task = thread?.bridgetTask;
  const allowed = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const pending = useComposerDraftStore((store) =>
    ref ? store.draftsByThreadKey[scopedThreadKey(threadRef)]?.nativeCommand : undefined,
  );
  const compose = useAtomCommand(orchestrationEnvironment.bridgetLineageCompose, {
    reportFailure: false,
  });
  const [snapshot, setSnapshot] = useState<{ key: string; value: BridgetComposerState } | null>(
    null,
  );
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const key = ref ? `${environmentId}:${ref.taskId}` : "";
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const currentKey = useStableCallback(() => key);
  const currentBinding = useStableCallback(
    () => `${key}:${ref?.generation ?? ""}:${ref?.seq ?? 0}:${task?.status ?? ref?.status ?? ""}`,
  );
  const state = snapshot?.key === key ? snapshot.value : null;
  const context =
    ref && thread
      ? {
          projectId: thread.projectId,
          threadId: ref.rootThreadId,
          taskId: ref.taskId,
          expectedRound: state?.round ?? 0,
        }
      : null;
  const issue = async (request: BridgetLineageComposeInput, mutation: boolean): Promise<void> => {
    const captured = key;
    const binding = currentBinding();
    if (!mounted.current || !captured || !allowed || inFlight.current.has(captured)) return;
    inFlight.current.add(captured);
    setBusyKey(captured);
    if (mutation) useComposerDraftStore.getState().setNativeCommand(threadRef, request);
    try {
      const response = await compose({ environmentId, input: request });
      if (response._tag === "Failure") {
        if (mounted.current && currentKey() === captured && currentBinding() === binding) {
          setError({
            key: captured,
            text: mutation
              ? "Issue de la commande inconnue. Le brouillon et sa clé sont conservés ; relire la même commande."
              : "Commandes Bridget indisponibles. Le journal et le brouillon sont conservés.",
          });
        }
        return;
      }
      const value = response.value;
      if (mounted.current && currentKey() === captured && currentBinding() === binding) {
        setSnapshot({ key: captured, value });
        setError(
          value.outcome === "refused" || value.outcome === "outcome_unknown"
            ? {
                key: captured,
                text: value.message || value.code || "Issue de la commande inconnue.",
              }
            : null,
        );
      }
      if (mutation && value.outcome !== "outcome_unknown") {
        const store = useComposerDraftStore.getState();
        if (store.getComposerDraft(threadRef)?.nativeCommand?.requestId === request.requestId) {
          store.setNativeCommand(threadRef, null);
          if (
            value.outcome === "accepted" &&
            request.operation.kind === "send" &&
            store.getComposerDraft(threadRef)?.prompt === request.operation.body
          )
            store.setPrompt(threadRef, "");
        }
      }
    } catch {
      if (mounted.current && currentKey() === captured && currentBinding() === binding)
        setError({
          key: captured,
          text: mutation
            ? "Issue de la commande inconnue. Le brouillon et sa clé sont conservés ; relire la même commande."
            : "Commandes Bridget indisponibles. Le journal et le brouillon sont conservés.",
        });
    } finally {
      inFlight.current.delete(captured);
      setBusyKey((previous) => (previous === captured ? null : previous));
      if (mounted.current && currentKey() === captured && currentBinding() !== binding) refresh();
    }
  };
  const issueStable = useStableCallback(issue);
  const refresh = useStableCallback((): void => {
    if (context)
      void issueStable(
        { ...context, expectedRound: 0, requestId: randomUUID(), operation: { kind: "read" } },
        false,
      );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the selected native session's capabilities with its external binding and lifecycle
  useEffect(() => {
    mounted.current = true;
    if (key && allowed) refresh();
    return () => {
      mounted.current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- seq and status invalidate the external native capabilities; the stable callback reads their current binding
  }, [key, ref?.generation, ref?.seq, task?.status, allowed, refresh]);
  const run = useStableCallback((operation: BridgetComposerOperation) => {
    if (
      !context ||
      !state ||
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nativeCommand ||
      inFlight.current.has(key)
    )
      return;
    const permitted =
      operation.kind === "send"
        ? state.capabilities.send && (operation.intent === "queue" || state.capabilities.steer)
        : operation.kind === "interrupt"
          ? state.capabilities.interrupt
          : operation.kind === "select_runtime"
            ? state.capabilities.select_runtime
            : false;
    if (!permitted) return;
    void issueStable({ ...context, requestId: randomUUID(), operation }, true);
  });
  const provider = task && state ? bridgetComposerProvider(task, state, thread?.runtimeMode) : null;
  const selection = provider && state ? bridgetComposerSelection(provider, state) : null;
  const selectOptions = useStableCallback(
    (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      const effort = options?.find(
        (option) => option.id === "reasoningEffort" || option.id === "effort",
      )?.value;
      if (selection && typeof effort === "string")
        run({ kind: "select_runtime", model: selection.model, effort });
    },
  );
  const selectModel = useStableCallback((model: string) => {
    const found = state?.models.find((entry) => entry.id === model);
    const effort = selection?.options?.find((option) => option.id === "reasoningEffort")?.value;
    if (!found) return;
    // Null asks the target to resolve its own default; catalogue order is never a default.
    const nextEffort = typeof effort === "string" && found.efforts.includes(effort) ? effort : null;
    run({ kind: "select_runtime", model, effort: nextEffort });
  });
  return {
    state,
    provider,
    selection,
    busy: busyKey === key,
    error: error?.key === key ? error.text : null,
    pending,
    providers: provider ? [provider] : [],
    refresh,
    retry: useStableCallback(() => {
      const pending = useComposerDraftStore.getState().getComposerDraft(threadRef)?.nativeCommand;
      if (pending && context && pending.taskId === context.taskId) void issueStable(pending, true);
    }),
    send: useStableCallback((body: string, steer = false) =>
      run({ kind: "send", body, intent: steer ? "steer" : "queue" }),
    ),
    interrupt: useStableCallback(() => run({ kind: "interrupt" })),
    selectModel,
    selectOptions,
  };
}
