import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { useStableCallback } from "../hooks/useStableCallback";
import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { BridgetJournalState } from "@t3tools/client-runtime/state/orchestration";
import {
  mergeJournalEvents,
  projectBridgetJournal,
  retainBridgetJournalGaps,
  type BridgetJournalProjection,
  type BridgetJournalConflict,
  type BridgetJournalContinuityCut,
  type BridgetJournalGap,
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
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentScope } from "~/state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FileTextIcon,
  HistoryIcon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import { randomUUID } from "~/lib/utils";
import { BridgetTaskIcon, BridgetTaskPlacement } from "./chat/SubagentTooltipContent";

type Context = { environmentId: EnvironmentId; projectId: ProjectId; threadId: ThreadId };

// Keep async cleanup outside render functions so the conversation can be compiled.
async function withJournalCleanup<T>(operation: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await operation();
  } finally {
    cleanup();
  }
}

function useVisiblePage() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the browser page visibility listener for live journal subscriptions
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards receipts from the native journal subscription to the mounted view
  useEffect(() => {
    if (result._tag === "Failure") onFailure(failureMessage(result.cause));
    const state = Option.getOrNull(AsyncResult.value(result));
    if (state !== null) onState(state);
  }, [onFailure, onState, result]);
  return null;
}

/** Native transcript and result remain owned by Bridget after Fleet cleanup. */
type BridgetJournalThread = Pick<
  OrchestrationV2AppThread,
  | "id"
  | "bridgetTaskRef"
  | "bridgetTask"
  | "projectId"
  | "title"
  | "modelSelection"
  | "bridgetLineage"
>;

export function BridgetTaskJournal({
  environmentId,
  thread,
  renderTimeline,
  onProjection,
}: {
  environmentId: EnvironmentId;
  thread: BridgetJournalThread;
  renderTimeline: (
    projection: BridgetJournalProjection,
    thread: BridgetJournalThread,
    result: string | null,
  ) => ReactNode;
  onProjection?: (
    projection: BridgetJournalProjection,
    thread: BridgetJournalThread,
    result: string | null,
  ) => void;
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
  const lastSeq = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const [showDetails, setShowDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts native journal reads when the component unmounts
  useEffect(
    () => () => {
      for (const request of requests.current) request.abort();
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- suspends native journal reads while the browser page is hidden
  useEffect(() => {
    if (!visible) {
      for (const request of requests.current) request.abort();
      setConnection((previous) => ({ afterSeq: lastSeq.current, visit: previous.visit + 1 }));
    }
  }, [visible]);
  const onState = useStableCallback((state: BridgetJournalState) => {
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
  });
  const read = async (input: BridgetLineageReadInput) => {
    const controller = new AbortController();
    requests.current.add(controller);
    return withJournalCleanup(
      async () => {
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
      },
      () => {
        requests.current.delete(controller);
      },
    );
  };
  const readResult = async (offset: number) => {
    if (reading) return;
    setReading(true);
    return withJournalCleanup(
      async () => {
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
      },
      () => setReading(false),
    );
  };
  const readHistory = async (afterSeq: number) => {
    if (reading) return;
    setReading(true);
    return withJournalCleanup(
      async () => {
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
      },
      () => setReading(false),
    );
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    return withJournalCleanup(
      async () => {
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
      },
      () => setStopping(false),
    );
  };
  const nativeStatus = task?.status ?? ref.status;
  const terminal = ["result_available", "failed", "cancelled"].includes(nativeStatus);
  const liveInput = (() => ({
    events: journal.events,
    conflicts: journal.conflicts,
    gaps: journal.gaps,
    continuityCut: journal.continuityCut,
    beginsWithExcerpt: journal.headCut,
  }))();
  const [previousProjection, setPreviousProjection] = useState(() => ({
    journal,
    projection: projectBridgetJournal(liveInput),
  }));
  let projectedLiveJournal = previousProjection.projection;
  if (previousProjection.journal !== journal) {
    projectedLiveJournal = projectBridgetJournal(liveInput, previousProjection.projection);
    setPreviousProjection({ journal, projection: projectedLiveJournal });
  }
  const projectedHistory = (() => {
    if (history === null) return null;
    const merged = mergeJournalEvents([], history.events);
    return projectBridgetJournal({
      events: merged.events,
      conflicts: merged.conflicts,
      gaps: history.gap === null ? [] : [history.gap],
      beginsWithExcerpt: historyAfterSeq !== 0 || history.gap !== null,
    });
  })();
  const projection = projectedHistory ?? projectedLiveJournal;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards the external journal to the shared viewport and composer prompt-history controller
  useEffect(() => {
    onProjection?.(projection, thread, result || null);
  }, [onProjection, projection, thread, result]);
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
      <div className="chat-composer-lane min-w-0 shrink-0 py-1 text-xs">
        <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
          <div className="flex min-w-0 items-center gap-2" aria-label="Barre de la tâche Bridget">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={expanded ? "Replier les détails" : "Déplier les détails"}
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    onClick={() => setExpanded((previous) => !previous)}
                  />
                }
              >
                {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </TooltipTrigger>
              <TooltipPopup>
                {expanded ? "Replier les détails" : "Déplier les détails"}
              </TooltipPopup>
            </Tooltip>
            <BridgetTaskIcon task={task} />
            <strong className="min-w-0 flex-1 truncate">
              {formatSubagentDisplayTitle(task?.title ?? thread.title)}
            </strong>
            <span className="hidden max-w-36 truncate text-muted-foreground md:block">
              {task?.model ?? thread.modelSelection.model}
            </span>
            {task?.placement ? (
              <span className="hidden max-w-28 truncate text-muted-foreground sm:block">
                {task.placement.display_name || task.placement.machine_id}
              </span>
            ) : null}
            <span className="shrink-0 text-muted-foreground">
              {thread.bridgetLineage?.available === false
                ? "Dernier état connu"
                : statusLabels[nativeStatus]}
            </span>
            {!terminal && canOperate ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label="Arrêter"
                      disabled={stopping || thread.bridgetLineage?.available === false}
                      onClick={() => void stop()}
                    />
                  }
                >
                  <SquareIcon />
                </TooltipTrigger>
                <TooltipPopup>Arrêter la mission</TooltipPopup>
              </Tooltip>
            ) : null}
            {failure || thread.bridgetLineage?.available === false ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Reconnecter"
                      onClick={() => {
                        setFailure(null);
                        setConnection((previous) => ({
                          afterSeq: lastSeq.current,
                          visit: previous.visit + 1,
                        }));
                      }}
                    />
                  }
                >
                  <RotateCwIcon />
                </TooltipTrigger>
                <TooltipPopup>Reconnecter le suivi du journal</TooltipPopup>
              </Tooltip>
            ) : null}
            <Menu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <Button size="icon-xs" variant="ghost" aria-label="Actions du journal" />
                      }
                    />
                  }
                >
                  <EllipsisIcon />
                </TooltipTrigger>
                <TooltipPopup>Actions du journal</TooltipPopup>
              </Tooltip>
              <MenuPopup align="end">
                <MenuItem disabled={reading} onClick={() => void readHistory(0)}>
                  <HistoryIcon />
                  Consulter l’historique
                </MenuItem>
                {task?.result_available ? (
                  <MenuItem disabled={reading} onClick={() => void readResult(0)}>
                    <FileTextIcon />
                    Lire le résultat
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
          <div
            id={detailsId}
            hidden={!expanded}
            className="space-y-1 px-8 py-2 text-muted-foreground"
          >
            <p>
              {task ? `${task.agent_type} · ` : null}
              {task?.model ?? thread.modelSelection.model}
              {task?.effort ? ` · ${task.effort}` : ""}
            </p>
            <BridgetTaskPlacement task={task} />
          </div>
        </div>
      </div>
      <div className="chat-composer-lane min-w-0 shrink-0">
        <div className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">
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
          {history ? (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <HistoryIcon className="size-3.5" aria-hidden />
              <span>Historique</span>
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
            </div>
          ) : null}
          {detail ? (
            <div className="mb-4 px-1">
              <div className="mb-2 flex gap-2">
                <strong>Résultat</strong>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setDetail(null);
                    setResult("");
                  }}
                >
                  Revenir au journal
                </Button>
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
            </div>
          ) : null}
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
      {renderTimeline(projection, thread, detail === null ? null : result)}
      <div className="chat-composer-lane shrink-0 py-1 text-xs text-muted-foreground">
        <details open={showDetails} onToggle={(event) => setShowDetails(event.currentTarget.open)}>
          <summary className="cursor-pointer">
            Détails techniques du journal · {projection.sourceEvents.length} événements
          </summary>
          {showDetails ? (
            <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
              {projection.blocks.map((block) => (
                <div key={block.key}>
                  {block.conflicts.map((conflict) => (
                    <p key={conflict.seq}>Conflit de rejeu #{conflict.seq}</p>
                  ))}
                  <pre>
                    {JSON.stringify({ events: block.events, conflicts: block.conflicts }, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}
        </details>
      </div>
    </section>
  );
}
