import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { BridgetJournalState } from "@t3tools/client-runtime/state/orchestration";
import type {
  BridgetJournalEvent,
  BridgetLineageDetail,
  BridgetLineageJournal,
  BridgetLineageReadInput,
  EnvironmentId,
  OrchestrationV2AppThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { BridgetTaskPlacement } from "./chat/SubagentTooltipContent";

type Context = { environmentId: EnvironmentId; projectId: ProjectId; threadId: ThreadId };

function useVisiblePage() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unavailable";
  const subject =
    code === "journal_unavailable" ? "Journal de la tâche indisponible" : "Bridget indisponible";
  return `${subject} (${code}). Le contenu déjà lu est conservé.`;
}

/** Scoped invalidations reconcile in the server; no task body is polled. */
export function BridgetLineageSubscription({
  context,
  known = false,
}: {
  context: Context;
  known?: boolean;
}) {
  const visible = useVisiblePage();
  const [visit, setVisit] = useState(0);
  return visible ? (
    <NativeWatch
      key={`${context.environmentId}:${context.threadId}:${visit}`}
      context={context}
      known={known}
      onReconnect={() => setVisit((previous) => previous + 1)}
    />
  ) : null;
}
function NativeWatch({
  context,
  known,
  onReconnect,
}: {
  context: Context;
  known: boolean;
  onReconnect: () => void;
}) {
  const visitId = useId();
  const result = useAtomValue(
    orchestrationEnvironment.bridgetLineageWatch({
      environmentId: context.environmentId,
      input: { context: { projectId: context.projectId, threadId: context.threadId }, visitId },
    }),
  );
  return known && result._tag === "Failure" ? (
    <div
      className="absolute left-3 top-12 z-20 rounded border bg-background p-2 text-xs"
      role="status"
    >
      Lineage Bridget indisponible.{" "}
      <Button size="xs" variant="ghost" onClick={onReconnect}>
        Reconnecter Bridget
      </Button>
    </div>
  ) : null;
}

const statusLabels = {
  queued: "En attente",
  starting: "Démarrage",
  mission_pending: "Mission en attente",
  working: "En cours",
  waiting_for_children: "Attend ses enfants",
  cancelling: "Annulation en cours",
  result_available: "Résultat disponible",
  failed: "Échec",
  cancelled: "Annulé",
} as const;

const JournalRow = memo(function JournalRow({ event }: { event: BridgetJournalEvent }) {
  return (
    <li className="border-b border-border/50 py-2" data-journal-seq={event.seq}>
      <div className="flex gap-2 text-xs text-muted-foreground">
        <time>{event.ts}</time>
        <span>{event.event}</span>
        <span>#{event.seq}</span>
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-xs">
        {typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2)}
      </pre>
    </li>
  );
});

function JournalFollow({
  context,
  taskId,
  afterSeq,
  visit,
  onState,
  onFailure,
}: {
  context: Context;
  taskId: string;
  afterSeq: number;
  visit: number;
  onState: (state: BridgetJournalState) => void;
  onFailure: (message: string) => void;
}) {
  const visitId = useId();
  const result = useAtomValue(
    orchestrationEnvironment.bridgetLineageJournal({
      environmentId: context.environmentId,
      input: {
        context: { projectId: context.projectId, threadId: context.threadId, taskId, afterSeq },
        visitId: `${visitId}:${visit}`,
      },
    }),
  );
  useEffect(() => {
    if (result._tag === "Failure") onFailure(failureMessage(result.cause));
    const state = Option.getOrNull(AsyncResult.value(result));
    if (state !== null) onState(state);
  }, [onFailure, onState, result]);
  return null;
}

/** Native transcript and result remain owned by Bridget after Fleet cleanup. */
export function BridgetTaskJournal({
  environmentId,
  thread,
  onOpenParent,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationV2AppThread;
  onOpenParent: (() => void) | null;
}) {
  const ref = thread.bridgetTaskRef!;
  const task = thread.bridgetTask;
  const context: Context = {
    environmentId,
    projectId: thread.projectId,
    threadId: ref.rootThreadId,
  };
  const visible = useVisiblePage();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cancel = useAtomCommand(orchestrationEnvironment.bridgetLineageCancel, {
    reportFailure: false,
  });
  const [events, setEvents] = useState<ReadonlyArray<BridgetJournalEvent>>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);
  const [gap, setGap] = useState<BridgetLineageJournal["gap"]>(null);
  const [evicted, setEvicted] = useState(false);
  const [connection, setConnection] = useState({ afterSeq: 0, visit: 0 });
  const [stopping, setStopping] = useState(false);
  const [detail, setDetail] = useState<BridgetLineageDetail | null>(null);
  const [result, setResult] = useState("");
  const [reading, setReading] = useState(false);
  const [history, setHistory] = useState<BridgetLineageJournal | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState(0);
  const lastSeq = useRef(0);
  const requests = useRef(new Set<AbortController>());
  useLayoutEffect(() => {
    const overlay = scrollElement
      ?.closest("[data-chat-canvas]")
      ?.querySelector<HTMLElement>("[data-chat-composer-overlay]");
    if (!overlay) return;
    // The parent's read-only bar overlays this viewport, just like a composer.
    // Reserve its measured height once, while keeping the normal journal gap.
    const measure = () => setBottomInset(Math.max(0, overlay.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [scrollElement]);
  useEffect(
    () => () => {
      for (const request of requests.current) request.abort();
    },
    [],
  );
  useEffect(() => {
    if (!visible) {
      for (const request of requests.current) request.abort();
      setConnection((previous) => ({ afterSeq: lastSeq.current, visit: previous.visit + 1 }));
    }
  }, [visible]);
  const onState = useCallback((state: BridgetJournalState) => {
    lastSeq.current = Math.max(lastSeq.current, state.nextSeq);
    setCaughtUp(state.caughtUp);
    if (state.gap !== null) setGap(state.gap);
    if (state.evicted > 0) setEvicted(true);
    setEvents((previous) => {
      const merged = new Map(previous.map((event) => [event.seq, event]));
      for (const event of state.events) if (!merged.has(event.seq)) merged.set(event.seq, event);
      const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
      return ordered.slice(-4096);
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
        setFailure(failureMessage(response.cause));
        return null;
      }
      return response.value;
    } finally {
      requests.current.delete(controller);
    }
  };
  const readResult = async (offset: number) => {
    if (reading) return;
    setReading(true);
    try {
      const value = await read({
        projectId: context.projectId,
        threadId: context.threadId,
        action: "show",
        taskId: ref.taskId,
        offset,
        limit: 16384,
      });
      if (value !== null && "task" in value) {
        setDetail(value);
        setResult((previous) =>
          offset === 0 ? (value.result ?? "") : previous + (value.result ?? ""),
        );
      }
    } finally {
      setReading(false);
    }
  };
  const readHistory = async (afterSeq: number) => {
    if (reading) return;
    setReading(true);
    try {
      const value = await read({
        projectId: context.projectId,
        threadId: context.threadId,
        action: "journal",
        taskId: ref.taskId,
        afterSeq,
        limit: 100,
      });
      if (value !== null && "events" in value) setHistory(value);
    } finally {
      setReading(false);
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      const response = await cancel({
        environmentId,
        input: {
          projectId: context.projectId,
          threadId: context.threadId,
          taskId: ref.taskId,
          requestId: randomUUID(),
        },
      });
      if (response._tag === "Failure") setFailure(failureMessage(response.cause));
    } finally {
      setStopping(false);
    }
  };
  const nativeStatus = task?.status ?? ref.status;
  const terminal = ["result_available", "failed", "cancelled"].includes(nativeStatus);
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Journal de la tâche Bridget"
    >
      {visible ? (
        <JournalFollow
          key={`${ref.taskId}:${connection.visit}`}
          context={context}
          taskId={ref.taskId}
          afterSeq={connection.afterSeq}
          visit={connection.visit}
          onState={onState}
          onFailure={setFailure}
        />
      ) : null}
      <div className="chat-composer-lane min-w-0 border-b py-3 text-sm">
        <div className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="min-w-0 break-words">{task?.title ?? thread.title}</strong>
            <span className="min-w-0 break-words">
              {task ? `${task.agent_type} · ` : null}
              {task?.model ?? thread.modelSelection.model}
              {task?.effort ? ` · ${task.effort}` : ""}
            </span>
            <span>
              {thread.bridgetLineage?.available === false
                ? "Dernier état connu"
                : statusLabels[nativeStatus]}
            </span>
          </div>
          <BridgetTaskPlacement task={task} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {onOpenParent ? (
              <Button size="xs" variant="ghost" onClick={onOpenParent}>
                Ouvrir le parent
              </Button>
            ) : null}
            {!terminal && canOperate ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={stopping || thread.bridgetLineage?.available === false}
                onClick={() => void stop()}
              >
                Arrêter
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setFailure(null);
                setConnection((previous) => ({
                  afterSeq: lastSeq.current,
                  visit: previous.visit + 1,
                }));
              }}
            >
              Reconnecter
            </Button>
          </div>
        </div>
      </div>
      <div
        ref={setScrollElement}
        className="chat-composer-lane scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-auto py-3"
        style={{ paddingBottom: `calc(0.75rem + ${bottomInset}px)` }}
      >
        <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
          {task?.cwd ? (
            <p className="mb-2 break-all text-xs text-muted-foreground">{task.cwd}</p>
          ) : null}
          {task?.error ? <p role="alert">{task.error}</p> : null}
          {failure ? (
            <p role="status" className="mb-2 text-sm">
              {failure}
            </p>
          ) : null}
          {gap ? (
            <p role="status" className="mb-2 text-sm">
              Journal incomplet : séquences {gap.from_seq}–{gap.to_seq} ({gap.reason}).
            </p>
          ) : null}
          {evicted ? (
            <p className="mb-2 text-sm">
              Les 4 096 dernières lignes sont affichées. Le début reste disponible dans
              l’historique.
            </p>
          ) : null}
          <div className="mb-2 flex gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={reading}
              onClick={() => void readHistory(0)}
            >
              Lire le début
            </Button>
            {history ? (
              <Button size="xs" variant="ghost" onClick={() => setHistory(null)}>
                Retour au suivi
              </Button>
            ) : null}
            {task?.result_available ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={reading}
                onClick={() => void readResult(0)}
              >
                Lire le résultat
              </Button>
            ) : null}
          </div>
          {detail ? (
            <div className="mb-4 rounded border p-3">
              <div className="mb-2 flex gap-2">
                <strong>Résultat</strong>
                <Button size="xs" variant="ghost" onClick={() => void writeTextToClipboard(result)}>
                  Copier le résultat chargé
                </Button>
                {detail.result_next_offset !== null ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={reading}
                    onClick={() => void readResult(detail.result_next_offset!)}
                  >
                    Suite du résultat
                  </Button>
                ) : null}
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm">{result}</pre>
            </div>
          ) : null}
          <ol className="list-none p-0">
            {(history?.events ?? events).map((event) => (
              <JournalRow key={event.seq} event={event} />
            ))}
          </ol>
          {history ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={reading || history.caught_up}
              onClick={() => void readHistory(history.next_seq)}
            >
              Page suivante
            </Button>
          ) : !caughtUp && !failure ? (
            <p className="text-xs text-muted-foreground">Chargement du journal…</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
