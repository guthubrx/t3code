import type { BridgetHumanView, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ChevronDown, ChevronUp, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
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

export function BridgetPanel(props: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
  visible: boolean;
}) {
  if (!props.visible) return null;
  if (!props.environmentId || !props.threadId || !props.projectId) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Sélectionnez une conversation T3 enregistrée dans un projet.
      </p>
    );
  }
  return (
    <BridgetSession
      key={JSON.stringify([props.environmentId, props.threadId, props.projectId])}
      environmentId={props.environmentId}
      threadId={props.threadId}
      projectId={props.projectId}
    />
  );
}

function BridgetSession(context: Context) {
  const [after, setAfter] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [threads, setThreads] = useState<Listed["threads"]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loadedEntries, setLoadedEntries] = useState<Record<string, History["entries"]>>({});
  const query = useEnvironmentQuery(
    orchestrationEnvironment.bridgetRead({
      environmentId: context.environmentId,
      input: {
        threadId: context.threadId,
        projectId: context.projectId,
        action: "list_recent",
        limit: 20,
        ...(after ? { after } : {}),
      },
    }),
  );
  const [freshness, setFreshness] = useState({ after, revision, data: query.data });
  const sameRequest = freshness.after === after && freshness.revision === revision;
  if (!sameRequest) setFreshness({ after, revision, data: query.data });
  const discarded = sameRequest ? freshness.data : query.data;
  const refreshList = query.refresh;
  useEffect(() => {
    // Refresh on opening as well: the atom may retain an older pending request.
    refreshList();
  }, [refreshList, revision]);
  const result = !query.isPending && query.data !== discarded ? query.data?.result : null;
  const error =
    detailError ??
    (!query.isPending ? query.error : null) ??
    (result?.status === "error"
      ? result.detail
      : result && result.status !== "listed_recent"
        ? "Réponse Bridget incompatible."
        : null);
  const loading = query.isPending || (!error && result === null);
  const rememberHistory = useCallback((id: string, entries: History["entries"]) => {
    setLoadedEntries((current) => ({ ...current, [id]: entries }));
  }, []);
  useEffect(() => {
    if (error) {
      setThreads([]);
      setSelectedId(null);
      setLoadedEntries({});
      return;
    }
    if (result?.status !== "listed_recent") return;
    setThreads((current) => {
      const byId = new Map(current.map((thread) => [thread.thread_id, thread]));
      for (const thread of result.threads) byId.set(thread.thread_id, thread);
      return [...byId.values()].sort(
        (left, right) =>
          right.last_activity_at - left.last_activity_at ||
          (left.thread_id < right.thread_id ? -1 : left.thread_id > right.thread_id ? 1 : 0),
      );
    });
  }, [error, result]);
  const needle = search.trim().toLocaleLowerCase();
  // O(n + loaded text): search never creates a remote query.
  const visibleThreads = needle
    ? threads.filter((thread) =>
        [
          thread.title,
          ...thread.members.flatMap((member) => [member.name ?? "", member.agent_id]),
          ...(loadedEntries[thread.thread_id] ?? []).flatMap((entry) => [
            entry.body,
            entry.author_name ?? "",
            entry.author_id,
          ]),
        ].some((value) => value.toLocaleLowerCase().includes(needle)),
      )
    : threads;
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Fils Bridget">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <span className="text-sm font-medium">Fils partagés</span>
          <p className="text-xs text-muted-foreground">Plus récents d’abord</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Rafraîchir"
          onClick={() => {
            setThreads([]);
            setLoadedEntries({});
            setDetailError(null);
            setAfter(undefined);
            setRevision((value) => value + 1);
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
        <div className="flex flex-col gap-0.5 px-2 py-2">
          {error ? (
            <p className="text-sm text-muted-foreground" role="alert">
              {error}
            </p>
          ) : (
            <>
              {loading ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Chargement des fils…
                </p>
              ) : null}
              {!loading && threads.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Aucun fil Bridget pour cet agent.
                </p>
              ) : null}
              {!loading && needle && visibleThreads.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  Aucun résultat dans les données chargées.
                </p>
              ) : null}
              {visibleThreads.map((thread) => (
                <button
                  type="button"
                  key={thread.thread_id}
                  onClick={() => setSelectedId(thread.thread_id)}
                  aria-pressed={selectedId === thread.thread_id}
                  className={cn(
                    "flex min-w-0 cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedId === thread.thread_id && "bg-accent text-foreground",
                  )}
                  aria-label={`Ouvrir ${thread.title}`}
                >
                  <span className="flex w-full min-w-0 items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium">{thread.title}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {thread.last_seq === 0 ? "Créé · " : null}
                      <BridgetDate seconds={thread.last_activity_at} />
                    </span>
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {thread.members.map((member) => member.name ?? member.agent_id).join(" · ")}
                    {thread.state === "closed" ? " · Fermé" : ""}
                  </span>
                </button>
              ))}
              {result?.status === "listed_recent" && result.next_after ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={query.isPending}
                  onClick={() => setAfter(result.next_after!)}
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
          key={`${selectedId}:${revision}`}
          context={context}
          sharedThreadId={selectedId}
          search={needle}
          onLoaded={rememberHistory}
          onError={setDetailError}
        />
      ) : null}
    </div>
  );
}

function BridgetThread({
  context,
  sharedThreadId,
  search,
  onLoaded,
  onError,
}: {
  context: Context;
  sharedThreadId: string;
  search: string;
  onLoaded: (id: string, entries: History["entries"]) => void;
  onError: (detail: string) => void;
}) {
  const [range, setRange] = useState<{ beforeSeq?: number; toSeq?: number }>({});
  const [history, setHistory] = useState<History | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const shown = useEnvironmentQuery(
    orchestrationEnvironment.bridgetRead({
      environmentId: context.environmentId,
      input: {
        threadId: context.threadId,
        projectId: context.projectId,
        action: "show",
        sharedThreadId,
      },
    }),
  );
  const query = useEnvironmentQuery(
    orchestrationEnvironment.bridgetRead({
      environmentId: context.environmentId,
      input: {
        threadId: context.threadId,
        projectId: context.projectId,
        action: "history_recent",
        sharedThreadId,
        limit: 50,
        ...range,
      },
    }),
  );
  const [discardedShown] = useState<BridgetHumanView | null>(shown.data);
  const [freshness, setFreshness] = useState({ range, data: query.data });
  if (freshness.range !== range) setFreshness({ range, data: query.data });
  const discardedHistory = freshness.range === range ? freshness.data : query.data;
  const refreshDetail = shown.refresh;
  const refreshHistory = query.refresh;
  useEffect(() => {
    refreshDetail();
  }, [refreshDetail]);
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);
  const shownResult = shown.data !== discardedShown && !shown.isPending ? shown.data?.result : null;
  const page = !query.isPending && query.data !== discardedHistory ? query.data?.result : null;
  const incompatible =
    (shownResult &&
      shownResult.status !== "error" &&
      (shownResult.status !== "shown" || shownResult.thread_id !== sharedThreadId)) ||
    (page &&
      page.status !== "error" &&
      (page.status !== "history_recent" ||
        page.thread_id !== sharedThreadId ||
        (range.toSeq !== undefined && page.snapshot_seq !== range.toSeq)));
  const error =
    (!shown.isPending ? shown.error : null) ??
    (!query.isPending ? query.error : null) ??
    (shownResult?.status === "error"
      ? shownResult.detail
      : page?.status === "error"
        ? page.detail
        : incompatible
          ? "Réponse Bridget incompatible avec ce fil."
          : null);
  useEffect(() => {
    if (error) {
      onError(error);
    }
  }, [error, onError]);
  useEffect(() => {
    if (error || page?.status !== "history_recent") return;
    setHistory((current) => {
      const sequences = new Set(current?.entries.map((entry) => entry.seq));
      return {
        ...page,
        entries: [
          ...(current?.entries ?? []),
          ...page.entries.filter((entry) => !sequences.has(entry.seq)),
        ],
      };
    });
  }, [error, page]);
  useEffect(() => {
    if (history) onLoaded(sharedThreadId, history.entries);
  }, [history, onLoaded, sharedThreadId]);
  if (error) return null;
  const detail = shownResult?.status === "shown" ? shownResult : null;
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
      <div className="flex min-w-0 flex-col gap-1 border-b border-border/60 px-3 py-3">
        {detail ? (
          <>
            <h2 className="text-sm font-medium break-words">{detail.title}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {detail.members.map((member) => member.name ?? member.agent_id).join(" · ")}
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Détails du fil</summary>
              <p className="pt-1">
                {detail.state === "closed" ? "Fermé" : "Ouvert"} · Créé le{" "}
                <BridgetDate seconds={detail.created_at} />
                {detail.closed_at !== null ? (
                  <>
                    {" "}
                    · Fermé le <BridgetDate seconds={detail.closed_at} />
                  </>
                ) : null}
              </p>
            </details>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Chargement du fil…
          </p>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-w-0 flex-col px-3 pb-4">
          {visibleEntries.map((entry) => (
            <BridgetMessage key={entry.seq} entry={entry} onCopyStatus={setCopyStatus} />
          ))}
          {query.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Chargement de l’historique…
            </p>
          ) : null}
          {history && history.entries.length === 0 ? (
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
            <Button
              size="sm"
              variant="ghost"
              disabled={query.isPending}
              onClick={() =>
                setRange({ beforeSeq: history.next_before_seq!, toSeq: history.snapshot_seq })
              }
            >
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
  onCopyStatus,
}: {
  entry: History["entries"][number];
  onCopyStatus: (status: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
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
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 break-words text-xs font-semibold text-foreground">
            {entry.author_name ?? entry.author_id}
          </span>
          <span className="text-2xs text-muted-foreground">
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
