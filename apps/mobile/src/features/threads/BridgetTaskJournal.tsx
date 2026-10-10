import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { BridgetJournalState } from "@t3tools/client-runtime/state/orchestration";
import {
  AuthOrchestrationOperateScope,
  type BridgetJournalEvent,
  type BridgetLineageDetail,
  type BridgetLineageJournal,
  type BridgetLineageReadInput,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppState, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { RequestActionButton } from "./RequestActionButton";
import { uuidv4 } from "../../lib/uuid";

function NativeSubscription({
  environmentId,
  thread,
  afterSeq,
  visit,
  onState,
  onFailure,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationV2ThreadShell;
  afterSeq: number;
  visit: number;
  onState: (state: BridgetJournalState) => void;
  onFailure: (message: string) => void;
}) {
  const visitId = useId();
  const ref = thread.bridgetTaskRef!;
  useAtomValue(
    orchestrationEnvironment.bridgetLineageWatch({
      environmentId,
      input: {
        context: { projectId: thread.projectId, threadId: ref.rootThreadId },
        visitId: `${visitId}:${visit}`,
      },
    }),
  );
  const journal = useAtomValue(
    orchestrationEnvironment.bridgetLineageJournal({
      environmentId,
      input: {
        context: {
          projectId: thread.projectId,
          threadId: ref.rootThreadId,
          taskId: ref.taskId,
          afterSeq,
        },
        visitId: `${visitId}:${visit}`,
      },
    }),
  );
  useEffect(() => {
    if (journal._tag === "Failure")
      onFailure("Bridget indisponible. Les lignes déjà lues sont conservées.");
    const state = Option.getOrNull(AsyncResult.value(journal));
    if (state !== null) onState(state);
  }, [journal, onFailure, onState]);
  return null;
}

/** Same native RPCs as desktop, scoped to the focused foreground screen. */
export function BridgetTaskJournal({
  environmentId,
  thread,
  bottomInset,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationV2ThreadShell;
  bottomInset: number;
}) {
  const ref = thread.bridgetTaskRef!;
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const active = focused && foreground;
  const [connection, setConnection] = useState({ afterSeq: 0, visit: 0 });
  const [events, setEvents] = useState<ReadonlyArray<BridgetJournalEvent>>([]);
  const [gap, setGap] = useState<BridgetLineageJournal["gap"]>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);
  const [evicted, setEvicted] = useState(false);
  const [history, setHistory] = useState<BridgetLineageJournal | null>(null);
  const [detail, setDetail] = useState<BridgetLineageDetail | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const lastSeq = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const cancel = useAtomCommand(orchestrationEnvironment.bridgetLineageCancel, {
    reportFailure: false,
  });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(
    () => () => {
      for (const request of requests.current) request.abort();
    },
    [],
  );
  useEffect(() => {
    if (!active) {
      for (const request of requests.current) request.abort();
      setConnection((previous) => ({ afterSeq: lastSeq.current, visit: previous.visit + 1 }));
    }
  }, [active]);
  const onState = useCallback((state: BridgetJournalState) => {
    lastSeq.current = Math.max(lastSeq.current, state.nextSeq);
    setCaughtUp(state.caughtUp);
    if (state.gap !== null) setGap(state.gap);
    if (state.evicted > 0) setEvicted(true);
    setEvents((previous) => {
      const merged = new Map(previous.map((event) => [event.seq, event]));
      for (const event of state.events) if (!merged.has(event.seq)) merged.set(event.seq, event);
      return [...merged.values()].sort((left, right) => left.seq - right.seq).slice(-4096);
    });
  }, []);
  const read = async (input: BridgetLineageReadInput) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const response = await executeAtomQuery(
        appAtomRegistry,
        orchestrationEnvironment.bridgetLineageRead({ environmentId, input }),
        { refresh: true, signal: controller.signal, reportFailure: false, reportDefect: false },
      );
      if (controller.signal.aborted) return null;
      if (response._tag === "Failure") {
        setFailure(String(Cause.squash(response.cause)));
        return null;
      }
      return response.value;
    } finally {
      requests.current.delete(controller);
    }
  };
  const inspect = async (action: "journal" | "show", offset: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const context = {
        projectId: thread.projectId,
        threadId: ref.rootThreadId,
        taskId: ref.taskId,
      };
      const value = await read(
        action === "show"
          ? { ...context, action, offset, limit: 16384 }
          : { ...context, action, afterSeq: offset, limit: 100 },
      );
      if (value !== null && "task" in value) {
        setDetail(value);
        setResult((previous) =>
          offset === 0 ? (value.result ?? "") : previous + (value.result ?? ""),
        );
      } else if (value !== null && "events" in value) setHistory(value);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // UUID is local action idempotence, never a permission credential.
      const requestId = uuidv4();
      const response = await cancel({
        environmentId,
        input: {
          projectId: thread.projectId,
          threadId: ref.rootThreadId,
          taskId: ref.taskId,
          requestId,
        },
      });
      if (response._tag === "Failure")
        setFailure("L’annulation Bridget a été refusée ou interrompue.");
    } finally {
      setBusy(false);
    }
  };
  const task = thread.bridgetTask;
  const terminal = ["result_available", "failed", "cancelled"].includes(task?.status ?? ref.status);
  return (
    <View className="flex-1">
      {active ? (
        <NativeSubscription
          key={`${ref.taskId}:${connection.visit}`}
          environmentId={environmentId}
          thread={thread}
          afterSeq={connection.afterSeq}
          visit={connection.visit}
          onState={onState}
          onFailure={setFailure}
        />
      ) : null}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + 16 }}>
        <Text className="font-t3-bold text-foreground">Journal Bridget · lecture seule</Text>
        <Text className="mt-1 text-foreground-secondary">
          {task?.model ?? thread.modelSelection.model}
          {task?.effort ? ` · ${task.effort}` : ""}
        </Text>
        {thread.bridgetLineage?.available === false ? (
          <Text className="mt-2 text-foreground-secondary">Dernier état connu</Text>
        ) : null}
        {task?.cwd ? (
          <Text selectable className="mt-2 text-xs text-foreground-secondary">
            {task.cwd}
          </Text>
        ) : null}
        {task?.error ? (
          <Text selectable className="mt-2 text-foreground">
            {task.error}
          </Text>
        ) : null}
        {failure ? <Text className="mt-2 text-foreground">{failure}</Text> : null}
        {gap ? (
          <Text className="mt-2 text-foreground">
            Journal incomplet : {gap.from_seq}–{gap.to_seq} ({gap.reason}).
          </Text>
        ) : null}
        {evicted ? (
          <Text className="mt-2 text-foreground-secondary">
            Dernières 4 096 lignes. Le début reste disponible dans l’historique.
          </Text>
        ) : null}
        <View className="my-3 flex-row flex-wrap gap-2">
          <RequestActionButton
            label="Reconnecter"
            tone="secondary"
            onPress={() => {
              setFailure(null);
              setConnection((previous) => ({
                afterSeq: lastSeq.current,
                visit: previous.visit + 1,
              }));
            }}
          />
          <RequestActionButton
            label="Lire le début"
            tone="secondary"
            disabled={busy}
            onPress={() => void inspect("journal", 0)}
          />
          {history ? (
            <RequestActionButton
              label="Retour au suivi"
              tone="secondary"
              onPress={() => setHistory(null)}
            />
          ) : null}
          {task?.result_available ? (
            <RequestActionButton
              label="Lire le résultat"
              tone="secondary"
              disabled={busy}
              onPress={() => void inspect("show", 0)}
            />
          ) : null}
          {!terminal && canOperate ? (
            <RequestActionButton
              label="Arrêter"
              tone="danger"
              disabled={busy || thread.bridgetLineage?.available === false}
              onPress={() => void stop()}
            />
          ) : null}
        </View>
        {detail ? (
          <View className="mb-3 gap-2">
            <Text className="font-t3-bold text-foreground">Résultat</Text>
            <Text selectable className="text-foreground">
              {result}
            </Text>
            {detail.result_next_offset !== null ? (
              <RequestActionButton
                label="Suite du résultat"
                tone="secondary"
                disabled={busy}
                onPress={() => void inspect("show", detail.result_next_offset!)}
              />
            ) : null}
          </View>
        ) : null}
        {(history?.events ?? events).map((event) => (
          <View key={event.seq} className="border-b border-border-subtle py-2">
            <Text className="text-xs text-foreground-secondary">
              {event.ts} · {event.event} · #{event.seq}
            </Text>
            <Text selectable className="mt-1 text-xs text-foreground">
              {typeof event.payload === "string"
                ? event.payload
                : JSON.stringify(event.payload, null, 2)}
            </Text>
          </View>
        ))}
        {history ? (
          <RequestActionButton
            label="Page suivante"
            tone="secondary"
            disabled={busy || history.caught_up}
            onPress={() => void inspect("journal", history.next_seq)}
          />
        ) : !caughtUp && !failure ? (
          <Text className="mt-2 text-foreground-secondary">Chargement du journal…</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
