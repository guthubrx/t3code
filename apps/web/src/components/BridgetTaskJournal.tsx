import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { BridgetJournalState } from "@t3tools/client-runtime/state/orchestration";
import {
  mergeJournalEvents,
  projectBridgetJournal,
  retainBridgetJournalGaps,
  type BridgetJournalBlock,
  type BridgetJournalConflict,
  type BridgetJournalContinuityCut,
  type BridgetJournalGap,
  type BridgetJournalProjection,
} from "@t3tools/client-runtime/bridget-journal-presentation";
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
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { BridgetTaskPlacement } from "./chat/SubagentTooltipContent";
import ChatMarkdown from "./ChatMarkdown";

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

function rawPreview(event: BridgetJournalEvent): string | null {
  return typeof event.payload === "string" ? event.payload : null;
}

const JournalDetails = memo(function JournalDetails({ block }: { block: BridgetJournalBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-2 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">
        Détails techniques · #{block.firstSeq}–#{block.lastSeq}
      </summary>
      {open ? (
        <div className="mt-2 space-y-2">
          {block.conflicts.map((conflict) => (
            <div key={`conflict:${conflict.seq}`} className="rounded border border-warning/40 p-2">
              <p className="font-medium text-foreground">
                Conflit de rejeu #{conflict.seq}
                {conflict.additionalConflicts > 0
                  ? ` · ${conflict.additionalConflicts + 1} occurrences conflictuelles`
                  : ""}
              </p>
              <pre className="mt-1 whitespace-pre-wrap break-words">
                {JSON.stringify(conflict.conflicting, null, 2)}
              </pre>
            </div>
          ))}
          {block.events.map((event) => (
            <pre key={event.seq} className="whitespace-pre-wrap break-words">
              {JSON.stringify(event, null, 2)}
            </pre>
          ))}
        </div>
      ) : null}
    </details>
  );
});

const JournalBlockView = memo(function JournalBlockView({ block }: { block: BridgetJournalBlock }) {
  return (
    <li className="border-b border-border/50 py-3" data-journal-seq={block.firstSeq}>
      {block.excerpt ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Extrait : le début de ce segment n’est pas chargé.
        </p>
      ) : null}
      {block.kind === "text" ? (
        <ChatMarkdown className="text-sm" cwd={undefined} inert text={block.content} />
      ) : block.kind === "activity" ? (
        <details className="rounded border bg-muted/30 px-3 py-2">
          <summary className="cursor-pointer select-none text-sm font-medium">
            {block.label}
            {block.text ? ` · ${block.text}` : ""}
          </summary>
          <div className="mt-2 space-y-2 text-sm">
            {block.detail ? <p>Détail : {block.detail}</p> : null}
            {block.toolCallId ? <p>Identifiant d’appel : {block.toolCallId}</p> : null}
            {block.exitCode !== null ? <p>Code de sortie : {block.exitCode}</p> : null}
            {block.status ? <p>Statut : {block.status}</p> : null}
            {block.state ? <p>État : {block.state}</p> : null}
            {block.outputTail !== null ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
                {block.outputTail}
              </pre>
            ) : null}
          </div>
        </details>
      ) : (
        <details className="rounded border border-dashed px-3 py-2">
          <summary className="cursor-pointer select-none text-sm">
            {block.label}
            {rawPreview(block.events[0]!) ? ` · ${rawPreview(block.events[0]!)} ` : ""}
          </summary>
        </details>
      )}
      <JournalDetails block={block} />
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
  const [journal, setJournal] = useState<{
    readonly events: ReadonlyArray<BridgetJournalEvent>;
    readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
    readonly headCut: boolean;
    readonly gaps: ReadonlyArray<BridgetJournalGap>;
    readonly continuityCut: BridgetJournalContinuityCut | null;
  }>({ events: [], conflicts: [], headCut: false, gaps: [], continuityCut: null });
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
  const [historyAfterSeq, setHistoryAfterSeq] = useState<number | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState(0);
  const lastSeq = useRef(0);
  const liveProjection = useRef<BridgetJournalProjection | null>(null);
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
    setJournal((previous) => {
      const merged = mergeJournalEvents(previous.events, state.events, [
        ...previous.conflicts,
        ...(state.conflicts ?? []),
      ]);
      const incomingGaps =
        state.gap === null ? (state.gaps ?? []) : [...(state.gaps ?? []), state.gap];
      const firstRetainedSeq = merged.events[0]?.seq ?? null;
      const prefixGap =
        firstRetainedSeq !== null &&
        (previous.gaps.some((knownGap) => knownGap.to_seq < firstRetainedSeq) ||
          incomingGaps.some((incomingGap) => incomingGap.to_seq < firstRetainedSeq));
      const continuity = retainBridgetJournalGaps(
        { gaps: previous.gaps, continuityCut: previous.continuityCut },
        incomingGaps,
        firstRetainedSeq,
        state.continuityCut ?? null,
      );
      return {
        events: merged.events,
        conflicts: merged.conflicts,
        headCut: previous.headCut || prefixGap || state.evicted > 0 || merged.evicted > 0,
        ...continuity,
      };
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
      if (value !== null && "events" in value) {
        setHistory(value);
        setHistoryAfterSeq(afterSeq);
      }
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
  const liveInput = useMemo(
    () => ({
      events: journal.events,
      conflicts: journal.conflicts,
      gaps: journal.gaps,
      continuityCut: journal.continuityCut,
      beginsWithExcerpt: journal.headCut,
    }),
    [journal],
  );
  const projectedLiveJournal = useMemo(
    () => projectBridgetJournal(liveInput, liveProjection.current ?? undefined),
    [liveInput],
  );
  useEffect(() => {
    liveProjection.current = projectedLiveJournal;
  }, [projectedLiveJournal]);
  const projectedHistory = useMemo(() => {
    if (history === null) return null;
    const merged = mergeJournalEvents([], history.events);
    return projectBridgetJournal({
      events: merged.events,
      conflicts: merged.conflicts,
      gaps: history.gap === null ? [] : [history.gap],
      beginsWithExcerpt: historyAfterSeq !== 0 || history.gap !== null,
    });
  }, [history, historyAfterSeq]);
  const projection = projectedHistory ?? projectedLiveJournal;
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
          {journal.continuityCut ? (
            <p role="status" className="mb-2 text-sm">
              Continuité du journal incertaine entre les séquences {journal.continuityCut.fromSeq}–
              {journal.continuityCut.toSeq} : les fragments ne sont pas regroupés à travers cette
              zone.
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
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setHistory(null);
                  setHistoryAfterSeq(null);
                }}
              >
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
                  <>
                    <span className="text-xs text-muted-foreground">
                      Résultat partiel : la suite n’est pas encore chargée.
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={reading}
                      onClick={() => void readResult(detail.result_next_offset!)}
                    >
                      Suite du résultat
                    </Button>
                  </>
                ) : null}
              </div>
              <ChatMarkdown cwd={undefined} inert text={result} />
            </div>
          ) : null}
          <ol className="list-none p-0">
            {projection.blocks.map((block) => (
              <JournalBlockView key={block.key} block={block} />
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
