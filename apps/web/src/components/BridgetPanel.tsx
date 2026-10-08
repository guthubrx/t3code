import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { BridgetReadInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { useRightPanelStore } from "~/rightPanelStore";
import type { BridgetHumanView, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ChevronDown, ChevronUp, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

type Listed = Extract<BridgetHumanView["result"], { status: "listed_recent" }>;
type History = Extract<BridgetHumanView["result"], { status: "history_recent" }>;
type Context = { environmentId: EnvironmentId; threadId: ThreadId; projectId: ProjectId };

// T3's timestamp tooltips contain English ordinals; this French panel keeps its labels local.
const shortDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const exactDate = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "full",
  timeStyle: "long",
});

function BridgetDate({ seconds }: { seconds: number }) {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return <span>Date indisponible</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={date.toISOString()} aria-label={exactDate.format(date)} />}
      >
        {shortDate.format(date)}
      </TooltipTrigger>
      <TooltipPopup>{exactDate.format(date)}</TooltipPopup>
    </Tooltip>
  );
}

type Shown = Extract<BridgetHumanView["result"], { status: "shown" }>;
type Model = {
  threads: Listed["threads"];
  nextAfter: string | null;
  detail: Shown | null;
  history: History | null;
  historySegments: number[];
  loadedEntries: Record<string, History["entries"]>;
};
const emptyModel = (): Model => ({
  threads: [],
  nextAfter: null,
  detail: null,
  history: null,
  historySegments: [],
  loadedEntries: {},
});
type ReadFailure = { code?: string | undefined; detail: string; sharedThreadId?: string };
type ReadRequest<I = BridgetReadInput> = I extends BridgetReadInput
  ? Omit<I, "threadId" | "projectId">
  : never;
type LoadKind = "all" | "detail" | "older" | "list";

function transportFailure(cause: unknown): ReadFailure {
  const code =
    cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
  const labels: Record<string, string> = {
    unavailable: "Bridget est indisponible.",
    timeout: "Bridget n’a pas répondu sous six secondes.",
    binding_unavailable: "La liaison Bridget est indisponible.",
    thread_unavailable: "L’accès au fil Bridget est refusé.",
    project_mismatch: "Cette conversation n’appartient pas au projet.",
    context_missing: "La conversation ou le projet est indisponible.",
    storage_unavailable: "Le stockage Bridget est indisponible.",
    unsupported_version: "Cette version de Bridget ne permet pas la consultation.",
    invalid_request: "La demande Bridget est invalide.",
    invalid_output: "La réponse Bridget est invalide.",
    output_limit: "La réponse Bridget dépasse la limite de lecture.",
    response_too_large: "La réponse Bridget dépasse la limite de lecture.",
    command_failed: "La consultation Bridget a échoué.",
  };
  return { code, detail: labels[code ?? ""] ?? "La consultation Bridget est indisponible." };
}

export function BridgetPanel(props: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
  visible: boolean;
}) {
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  if (!props.visible || !documentVisible) return null;
  if (!props.environmentId || !props.threadId || !props.projectId) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Sélectionnez une conversation T3 enregistrée dans un projet.
      </p>
    );
  }
  return (
    <BridgetSession
      key={JSON.stringify([props.environmentId, props.projectId, props.threadId])}
      environmentId={props.environmentId}
      threadId={props.threadId}
      projectId={props.projectId}
    />
  );
}

function BridgetSession(context: Context) {
  const contextKey = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
  const selectedId = useRightPanelStore(
    (state) => state.bridgetSelectionByContextKey[contextKey] ?? null,
  );
  const connection = useAtomValue(environmentCatalog.stateAtom(context.environmentId));
  const state = Option.getOrNull(AsyncResult.value(connection));
  const connectedGeneration = state?.phase === "connected" ? state.generation : null;
  const connected = connectedGeneration !== null;
  const [model, setModel] = useState<Model>(emptyModel);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const refreshRef = useRef<HTMLButtonElement>(null);
  const watchGenerations = useRef(new Set<string>());
  // This object belongs to one mounted visit, never to a cached context UUID.
  const visit = useRef({
    active: false,
    version: 0,
    running: false,
    dirty: false,
    controller: null as AbortController | null,
    selectedId,
    listPages: 1,
    historyPages: 1,
    kind: "all" as LoadKind,
    model: emptyModel(),
  });
  const [watchEnabled, setWatchEnabled] = useState(true);

  useLayoutEffect(() => {
    const current = visit.current;
    current.active = connectedGeneration !== null;
    current.version++;
    current.controller?.abort();
    current.model = emptyModel();
    setModel(current.model);
    setPending(connectedGeneration !== null);
    if (connectedGeneration === null)
      setError("Connexion Bridget indisponible. Le choix du fil est conservé.");
    else {
      setError(null);
      setWatchEnabled(true);
    }
    return () => {
      current.active = false;
      current.version++;
      current.controller?.abort();
    };
  }, [connectedGeneration]);

  const invalidate = useCallback(
    (kind: LoadKind = "all") => {
      const current = visit.current;
      if (!current.active) return;
      current.version++;
      current.kind = current.dirty && current.kind !== kind ? "all" : kind;
      current.dirty = true;
      if (current.running) return;
      const run = async () => {
        current.running = true;
        setPending(true);
        while (current.active && current.dirty) {
          current.dirty = false;
          const version = current.version;
          const kind = current.kind;
          const sharedThreadId = current.selectedId;
          const controller = new AbortController();
          current.controller = controller;
          const read = async (input: ReadRequest) => {
            const result = await executeAtomQuery(
              appAtomRegistry,
              orchestrationEnvironment.bridgetRead({
                environmentId: context.environmentId,
                input: {
                  ...input,
                  threadId: context.threadId,
                  projectId: context.projectId,
                } as BridgetReadInput,
              }),
              {
                refresh: true,
                signal: controller.signal,
                reportFailure: false,
                reportDefect: false,
              },
            );
            if (controller.signal.aborted || !current.active) throw { detail: "Lecture annulée." };
            if (result._tag === "Failure") {
              throw {
                ...transportFailure(Cause.squash(result.cause)),
                ...("sharedThreadId" in input ? { sharedThreadId: input.sharedThreadId } : {}),
              } satisfies ReadFailure;
            }
            if (result.value.result.status === "error")
              throw {
                ...result.value.result,
                ...("sharedThreadId" in input ? { sharedThreadId: input.sharedThreadId } : {}),
              } satisfies ReadFailure;
            if (
              input.action === "show" &&
              (result.value.result.status !== "shown" ||
                result.value.result.thread_id !== input.sharedThreadId)
            )
              throw {
                detail: "Réponse Bridget incompatible avec ce fil.",
                sharedThreadId: input.sharedThreadId,
              } satisfies ReadFailure;
            return result.value.result;
          };
          const list = async () => {
            if (kind === "detail" || kind === "older")
              return { threads: current.model.threads, nextAfter: current.model.nextAfter };
            let after: string | undefined =
              kind === "list" ? (current.model.nextAfter ?? undefined) : undefined;
            let nextAfter: string | null = null;
            const byId = new Map<string, Listed["threads"][number]>(
              kind === "list"
                ? current.model.threads.map((thread) => [thread.thread_id, thread])
                : [],
            );
            for (let page = 0; page < (kind === "list" ? 1 : current.listPages); page++) {
              const result = await read({
                action: "list_recent",
                limit: 20,
                ...(after ? { after } : {}),
              });
              if (result.status !== "listed_recent")
                throw { detail: "Réponse Bridget incompatible." };
              for (const thread of result.threads) byId.set(thread.thread_id, thread);
              nextAfter = result.next_after;
              if (nextAfter === null) break;
              after = nextAfter;
            }
            // O(n log n), n is the loaded list segment, not the whole database.
            const threads = [...byId.values()].sort(
              (a, b) =>
                b.last_activity_at - a.last_activity_at || a.thread_id.localeCompare(b.thread_id),
            );
            return { threads, nextAfter };
          };
          const detail = async () => {
            if (kind === "list")
              return {
                detail: current.model.detail,
                history: current.model.history,
                historySegments: current.model.historySegments,
              };
            if (!sharedThreadId) return { detail: null, history: null, historySegments: [] };
            const previousHistory = current.model.history;
            if (
              kind === "older" &&
              previousHistory?.has_more &&
              previousHistory.next_before_seq !== null
            ) {
              const result = await read({
                action: "history_recent",
                sharedThreadId,
                limit: 50,
                beforeSeq: previousHistory.next_before_seq,
                toSeq: previousHistory.snapshot_seq,
              });
              if (
                result.status !== "history_recent" ||
                result.thread_id !== sharedThreadId ||
                result.snapshot_seq !== previousHistory.snapshot_seq
              )
                throw {
                  detail: "Réponse Bridget incompatible avec cet instantané.",
                  sharedThreadId,
                };
              const sequences = new Set(previousHistory.entries.map((entry) => entry.seq));
              return {
                detail: current.model.detail,
                history: {
                  ...result,
                  entries: [
                    ...previousHistory.entries,
                    ...result.entries.filter((entry) => !sequences.has(entry.seq)),
                  ],
                },
                historySegments: [...current.model.historySegments, result.through_seq],
              };
            }
            const [shown, head] = await Promise.all([
              read({ action: "show", sharedThreadId }),
              // No old toSeq: acquire the current head before rebuilding old relations.
              read({ action: "history_recent", sharedThreadId, limit: 50 }),
            ]);
            if (
              shown.status !== "shown" ||
              shown.thread_id !== sharedThreadId ||
              head.status !== "history_recent" ||
              head.thread_id !== sharedThreadId
            ) {
              throw { detail: "Réponse Bridget incompatible avec ce fil.", sharedThreadId };
            }
            const snapshot = head.snapshot_seq;
            if (previousHistory && snapshot < previousHistory.snapshot_seq)
              throw { detail: "Réponse Bridget incompatible avec cet instantané.", sharedThreadId };
            let tail = head;
            const entries = new Map(head.entries.map((entry) => [entry.seq, entry]));
            const segments = current.model.historySegments.length
              ? [...current.model.historySegments]
              : [head.through_seq];
            // Fill only newly arrived messages between the latest page and the
            // consulted segment. A burst larger than 50 must not leave a hidden gap.
            while (
              tail.has_more &&
              tail.next_before_seq !== null &&
              tail.next_before_seq > segments[0]!
            ) {
              const page = await read({
                action: "history_recent",
                sharedThreadId,
                limit: 50,
                beforeSeq: tail.next_before_seq,
                toSeq: snapshot,
              });
              if (
                page.status !== "history_recent" ||
                page.thread_id !== sharedThreadId ||
                page.snapshot_seq !== snapshot ||
                (page.next_before_seq !== null && page.next_before_seq >= tail.next_before_seq)
              )
                throw {
                  detail: "Réponse Bridget incompatible avec cet instantané.",
                  sharedThreadId,
                };
              for (const entry of page.entries) entries.set(entry.seq, entry);
              tail = page;
            }
            // Revalidate only consulted segments at the new common snapshot. This also
            // updates superseded_by_seq hidden by the old snapshot on older pages.
            for (let page = 0; page < segments.length; page++) {
              if (segments[page] === head.through_seq) continue;
              const result = await read({
                action: "history_recent",
                sharedThreadId,
                limit: 50,
                beforeSeq: segments[page],
                toSeq: snapshot,
              });
              if (
                result.status !== "history_recent" ||
                result.thread_id !== sharedThreadId ||
                result.snapshot_seq !== snapshot
              ) {
                throw {
                  detail: "Réponse Bridget incompatible avec cet instantané.",
                  sharedThreadId,
                };
              }
              for (const entry of result.entries) entries.set(entry.seq, entry);
              tail = result;
            }
            while (
              segments.length < current.historyPages &&
              tail.has_more &&
              tail.next_before_seq !== null
            ) {
              const result = await read({
                action: "history_recent",
                sharedThreadId,
                limit: 50,
                beforeSeq: tail.next_before_seq,
                toSeq: snapshot,
              });
              if (
                result.status !== "history_recent" ||
                result.thread_id !== sharedThreadId ||
                result.snapshot_seq !== snapshot
              )
                throw {
                  detail: "Réponse Bridget incompatible avec cet instantané.",
                  sharedThreadId,
                };
              segments.push(result.through_seq);
              for (const entry of result.entries) entries.set(entry.seq, entry);
              tail = result;
            }
            const previous = new Map(
              current.model.history?.entries.map((entry) => [entry.seq, entry]),
            );
            // O(P + B), P = consulted entries, B = their total body bytes. Preserve immutable bodies and
            // references of unchanged lines so React leaves their text nodes in place.
            const stable = [...entries.values()].map((entry) => {
              const old = previous.get(entry.seq);
              return old?.message_id === entry.message_id &&
                JSON.stringify(old) === JSON.stringify(entry)
                ? old
                : entry;
            });
            return {
              detail: shown,
              history: { ...tail, entries: stable },
              historySegments: segments,
            };
          };
          try {
            const [listed, selected] = await Promise.all([list(), detail()]);
            if (
              !current.active ||
              controller.signal.aborted ||
              version !== current.version ||
              sharedThreadId !== current.selectedId
            )
              continue;
            current.model = {
              ...listed,
              ...selected,
              loadedEntries:
                sharedThreadId && selected.history
                  ? { ...current.model.loadedEntries, [sharedThreadId]: selected.history.entries }
                  : current.model.loadedEntries,
            };
            setModel(current.model);
            setError(null);
          } catch (failure) {
            controller.abort();
            const refused = failure as ReadFailure;
            const confirmed =
              refused.code === "thread_unavailable" &&
              refused.sharedThreadId === current.selectedId;
            if (!current.active || (version !== current.version && !confirmed)) continue;
            current.dirty = false;
            current.version++;
            const activeElement = typeof document === "undefined" ? null : document.activeElement;
            const hadFocus =
              activeElement !== null &&
              refreshRef.current?.parentElement?.parentElement?.contains(activeElement);
            current.model = emptyModel();
            setModel(current.model);
            setError(refused.detail);
            if (confirmed) {
              useRightPanelStore.getState().setBridgetSelection(contextKey, null);
              current.selectedId = null;
            }
            // Business refusal is terminal until the user retries; no retry timer.
            setWatchEnabled(false);
            if (hadFocus) refreshRef.current?.focus({ preventScroll: true });
          }
        }
        current.running = false;
        if (current.active) setPending(false);
      };
      void run();
    },
    [context.environmentId, context.projectId, context.threadId, contextKey],
  );

  useEffect(() => {
    const current = visit.current;
    if (current.selectedId === selectedId) return;
    current.selectedId = selectedId;
    current.controller?.abort();
    current.historyPages = 1;
    current.model = { ...current.model, detail: null, history: null, historySegments: [] };
    setModel(current.model);
    invalidate("detail");
  }, [selectedId, invalidate]);

  const mask = useCallback((detail: string) => {
    const current = visit.current;
    current.version++;
    current.dirty = false;
    current.controller?.abort();
    current.model = emptyModel();
    setModel(current.model);
    setError(detail);
  }, []);
  const stopWatch = useCallback(
    (detail: string) => {
      mask(detail);
      setWatchEnabled(false);
    },
    [mask],
  );

  const needle = search.trim().toLocaleLowerCase();
  const visibleThreads = needle
    ? model.threads.filter((thread) =>
        [
          thread.title,
          ...thread.members.flatMap((member) => [member.name ?? "", member.agent_id]),
          ...(model.loadedEntries[thread.thread_id] ?? []).flatMap((entry) => [
            entry.body,
            entry.author_name ?? "",
            entry.author_id,
          ]),
        ].some((value) => value.toLocaleLowerCase().includes(needle)),
      )
    : model.threads;
  // Keep the authorized selection identifiable even outside loaded pages or a
  // local search. The same keyed sibling list preserves its native details node.
  const selectedDetail = model.detail?.thread_id === selectedId ? model.detail : null;
  const selectedListed = model.threads.find((thread) => thread.thread_id === selectedId);
  // show does not expose an activity date. An exceptional row must label its
  // authorized creation date honestly rather than invent a last exchange.
  const selectedRow: Listed["threads"][number] | null = selectedDetail
    ? {
        ...selectedDetail,
        last_activity_at: selectedListed?.last_activity_at ?? selectedDetail.created_at,
      }
    : null;
  const displayedThreads =
    selectedRow && !visibleThreads.some((thread) => thread.thread_id === selectedId)
      ? [selectedRow, ...visibleThreads]
      : visibleThreads.map((thread) =>
          thread.thread_id === selectedId && selectedRow ? selectedRow : thread,
        );

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Fils Bridget">
      {connected && watchEnabled ? (
        <BridgetWatch
          context={context}
          generations={watchGenerations}
          onChange={invalidate}
          onFailure={stopWatch}
          onPending={mask}
        />
      ) : null}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <span className="text-sm font-medium">Fils partagés</span>
          <p className="text-xs text-muted-foreground">Plus récents d’abord</p>
        </div>
        <Button
          ref={refreshRef}
          variant="ghost"
          size="icon-sm"
          aria-label="Rafraîchir"
          onClick={() => {
            setError(null);
            if (watchEnabled) invalidate();
            else setWatchEnabled(true);
          }}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="flex flex-col gap-1 px-3 pt-2">
        <div className="flex items-center gap-1">
          <Input
            type="search"
            size="compact"
            aria-label="Rechercher dans les données chargées"
            placeholder="Rechercher…"
            aria-description="Recherche locale : titres, membres, auteurs et messages chargés."
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          {search ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Effacer la recherche"
              onClick={() => setSearch("")}
            >
              <X />
            </Button>
          ) : null}
        </div>
        <p className="sr-only">
          Recherche locale dans les données chargées : titres, membres, auteurs et messages.
        </p>
      </div>
      <ScrollArea className={cn("min-h-0", selectedId ? "max-h-44 shrink-0" : "flex-1")}>
        <div className="flex min-h-full flex-col gap-0.5 bg-sidebar px-2 py-2">
          {error ? (
            <p className="text-sm text-muted-foreground" role="alert">
              {error}
            </p>
          ) : (
            <>
              {pending && model.threads.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Chargement des fils…
                </p>
              ) : null}
              {!pending && model.threads.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Aucun fil Bridget pour cet agent.
                </p>
              ) : null}
              {!pending && needle && visibleThreads.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Aucun résultat dans les données chargées.
                </p>
              ) : null}
              {displayedThreads.map((thread) => (
                <div key={thread.thread_id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() =>
                      useRightPanelStore
                        .getState()
                        .setBridgetSelection(contextKey, thread.thread_id)
                    }
                    aria-pressed={selectedId === thread.thread_id}
                    aria-current={selectedId === thread.thread_id ? true : undefined}
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedId === thread.thread_id
                        ? "bg-sidebar-row-active text-sidebar-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                    )}
                    aria-label={"Ouvrir " + thread.title}
                  >
                    <span className="flex w-full min-w-0 items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium">{thread.title}</span>
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {thread.last_seq === 0 ||
                        (thread.thread_id === selectedId && !selectedListed)
                          ? "Créé · "
                          : null}
                        <BridgetDate seconds={thread.last_activity_at} />
                      </span>
                    </span>
                    <span className="w-full truncate text-xs text-muted-foreground">
                      {thread.members.map((member) => member.name ?? member.agent_id).join(" · ")}
                      {thread.state === "closed" ? " · Fermé" : ""}
                    </span>
                  </button>
                  {selectedId === thread.thread_id && selectedDetail ? (
                    <details className="px-2 py-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        Détails du fil
                      </summary>
                      <p className="pt-1 break-words">{selectedDetail.title}</p>
                      <p className="pt-1 break-words">
                        {selectedDetail.members
                          .map((member) => member.name ?? member.agent_id)
                          .join(" · ")}
                      </p>
                      <p className="pt-1">
                        {selectedDetail.state === "closed" ? "Fermé" : "Ouvert"} · Créé le{" "}
                        <BridgetDate seconds={selectedDetail.created_at} />
                        {selectedDetail.closed_at !== null ? (
                          <>
                            {" "}
                            · Fermé le <BridgetDate seconds={selectedDetail.closed_at} />
                          </>
                        ) : null}
                      </p>
                    </details>
                  ) : null}
                </div>
              ))}
              {model.nextAfter ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    visit.current.listPages++;
                    invalidate("list");
                  }}
                >
                  Autres fils
                </Button>
              ) : null}
            </>
          )}
        </div>
      </ScrollArea>
      {!error && selectedId ? (
        <BridgetThread
          key={selectedId}
          detail={model.detail}
          history={model.history}
          search={needle}
          pending={pending}
          onOlder={() => {
            visit.current.historyPages++;
            invalidate("older");
          }}
        />
      ) : null}
    </div>
  );
}

function BridgetWatch({
  context,
  generations,
  onChange,
  onFailure,
  onPending,
}: {
  context: Context;
  generations: { current: Set<string> };
  onChange: () => void;
  onFailure: (detail: string) => void;
  onPending: (detail: string) => void;
}) {
  const visitId = useId();
  const result = useAtomValue(
    orchestrationEnvironment.bridgetWatch({
      environmentId: context.environmentId,
      input: { threadId: context.threadId, projectId: context.projectId },
      visitId,
    }),
  );
  const accepted = useRef<{ generation: string; seq: number; subscriptionId: symbol } | null>(null);
  useEffect(() => {
    // A unique visit key prevents SWR from an older visit. The native snapshot
    // retains handshake proof even when React first observes a coalesced changed.
    if (result._tag === "Failure") {
      onFailure(transportFailure(Cause.squash(result.cause)).detail);
      return;
    }
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    if (!snapshot) return;
    if (snapshot.readyGeneration === null) {
      onPending("Reconnexion Bridget en cours. Le choix du fil est conservé.");
      return;
    }
    if (!snapshot.event || snapshot.readyGeneration !== snapshot.event.generation) return;
    const event = snapshot.event;
    const previous = accepted.current;
    if (previous?.generation === event.generation) {
      if (previous.subscriptionId !== snapshot.subscriptionId || event.seq <= previous.seq) return;
    } else if (generations.current.has(event.generation)) return;
    generations.current.add(event.generation);
    accepted.current = {
      generation: event.generation,
      seq: event.seq,
      subscriptionId: snapshot.subscriptionId,
    };
    onChange();
  }, [result, generations, onChange, onFailure, onPending]);
  return null;
}

function BridgetThread({
  detail,
  history,
  search,
  pending,
  onOlder,
}: {
  detail: Shown | null;
  history: History | null;
  search: string;
  pending: boolean;
  onOlder: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // O(M), M = authorized members of the shown thread (at most 16).
  const memberNames = new Map(detail?.members.map((member) => [member.agent_id, member.name]));
  const entries = history?.entries ?? [];
  const visibleEntries = search
    ? entries.filter((entry) =>
        [entry.body, entry.author_name ?? "", entry.author_id].some((value) =>
          value.toLocaleLowerCase().includes(search),
        ),
      )
    : entries;
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t" aria-label="Historique du fil Bridget">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-w-0 flex-col px-3 pb-4">
          {!detail ? (
            <p className="text-sm text-muted-foreground" role="status">
              Chargement du fil…
            </p>
          ) : null}
          {visibleEntries.map((entry) => (
            <BridgetMessage
              key={entry.seq}
              entry={entry}
              memberNames={memberNames}
              onCopyStatus={setCopyStatus}
            />
          ))}
          {pending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Chargement de l’historique…
            </p>
          ) : null}
          {history && entries.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              Ce fil ne contient aucun message.
            </p>
          ) : null}
          {search && entries.length > 0 && visibleEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              Aucun résultat dans les messages chargés.
            </p>
          ) : null}
          {history?.has_more && history.next_before_seq !== null ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onOlder}>
              Messages plus anciens
            </Button>
          ) : null}
          {copyStatus ? (
            <p className="text-xs text-muted-foreground" role="status">
              {copyStatus}
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function BridgetMessage({
  entry,
  memberNames,
  onCopyStatus,
}: {
  entry: History["entries"][number];
  memberNames: ReadonlyMap<string, string | null>;
  onCopyStatus: (status: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const author = entry.author_name ?? entry.author_id;
  // O(T), T <= 16. Use recorded effective targets, not today's whole membership.
  const recipients =
    entry.notify.mode === "none"
      ? []
      : entry.notify.targets
          .filter((id) => id !== entry.author_id)
          .map((id) => ({ id, name: memberNames.get(id) }));
  const recipientNames = recipients
    .map(({ id, name }) => name || `Nom indisponible (${id.slice(0, 8)}…${id.slice(-4)})`)
    .join(" · ");
  const exactRecipients = recipients
    .map(({ id, name }) => (name ? `${name} (${id})` : `Nom indisponible (${id})`))
    .join(" ; ");
  const authorRow = author + (recipients.length ? ` → ${recipientNames}` : " · Sans sollicitation");
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded || entry.body.length === 0) return;
    const measure = () => {
      const overflow = body.scrollHeight > body.clientHeight;
      if (
        !overflow &&
        toggleRef.current !== null &&
        body.ownerDocument?.activeElement === toggleRef.current
      ) {
        copyRef.current?.focus({ preventScroll: true });
      }
      setOverflows(overflow);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded, entry.body]);
  const kind = entry.kind
    ? { history: "Historique", action: "Action", blocker: "Blocage", decision: "Décision" }[
        entry.kind
      ]
    : "Message";
  return (
    <article
      aria-label={`Message ${entry.seq}`}
      className="flex min-w-0 flex-col gap-2 border-b border-border/60 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-x-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="min-w-0 flex-1 truncate text-xs text-foreground"
                  tabIndex={recipients.length ? 0 : undefined}
                  aria-label={
                    authorRow +
                    (recipients.length ? `. Destinataires sollicités : ${exactRecipients}` : "")
                  }
                />
              }
            >
              <span className="font-semibold">{author}</span>
              <span className="text-muted-foreground">
                {recipients.length ? ` → ${recipientNames}` : " · Sans sollicitation"}
              </span>
            </TooltipTrigger>
            <TooltipPopup>
              {recipients.length
                ? `Destinataires sollicités : ${exactRecipients}`
                : "Sans sollicitation"}
            </TooltipPopup>
          </Tooltip>
          <span className="shrink-0 text-2xs text-muted-foreground">
            <BridgetDate seconds={entry.created_at} />
          </span>
        </div>
        <Button
          ref={copyRef}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Copier le message ${entry.seq}`}
          onClick={() => {
            void writeTextToClipboard(entry.body, "message Bridget").then(
              (copied) =>
                onCopyStatus(copied ? `Message ${entry.seq} copié.` : "Ce message est vide."),
              () => onCopyStatus("Copie indisponible."),
            );
          }}
        >
          <Copy />
        </Button>
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        data-bridget-body
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]",
          !expanded && "line-clamp-4",
        )}
      >
        {entry.body}
      </div>
      {overflows || expanded ? (
        <div>
          <Button
            ref={toggleRef}
            variant="ghost-muted"
            size="micro"
            aria-label={`${expanded ? "Replier" : "Déplier"} le message ${entry.seq}`}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
            {expanded ? "Replier" : "Déplier"}
          </Button>
        </div>
      ) : null}
      <details className="min-w-0 text-2xs text-muted-foreground">
        <summary className="cursor-pointer">Détails</summary>
        <p className="pt-1">
          {kind} · Message #{entry.seq}
          {entry.supersedes_seq != null ? ` · Remplace #${entry.supersedes_seq}` : ""}
          {entry.superseded_by_seq != null ? ` · Remplacé par #${entry.superseded_by_seq}` : ""}
        </p>
      </details>
    </article>
  );
}
