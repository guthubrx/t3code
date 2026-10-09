import type { BridgetHumanView, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";

type Listed = Extract<BridgetHumanView["result"], { status: "listed" }>;
type History = Extract<BridgetHumanView["result"], { status: "history" }>;
type Context = { environmentId: EnvironmentId; threadId: ThreadId; projectId: ProjectId };

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
        action: "list",
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
      : result && result.status !== "listed"
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
    if (result?.status !== "listed") return;
    setThreads((current) => {
      const ids = new Set(current.map((thread) => thread.thread_id));
      return [...current, ...result.threads.filter((thread) => !ids.has(thread.thread_id))];
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
        <span className="text-sm font-medium">Fils partagés</span>
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
      <div className="flex flex-col gap-1 px-3 pt-3">
        <div className="flex items-center gap-1">
          <Input
            type="search"
            size="compact"
            aria-label="Rechercher dans les données chargées"
            placeholder="Rechercher…"
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
        <p className="text-xs text-muted-foreground">
          Recherche locale dans les données chargées : titres, membres, auteurs et messages.
        </p>
      </div>
      <ScrollArea className={cn("min-h-0", selectedId ? "max-h-44 shrink-0" : "flex-1")}>
        <div className="flex flex-col gap-1 p-3">
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
                    "flex cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedId === thread.thread_id && "bg-accent text-foreground",
                  )}
                  aria-label={`Ouvrir ${thread.title}`}
                >
                  <span className="truncate text-sm">{thread.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {thread.members.map((member) => member.name ?? member.agent_id).join(" · ")}
                    {thread.state === "closed" ? " · Fermé" : ""}
                  </span>
                </button>
              ))}
              {result?.status === "listed" && result.next_after ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={query.isPending}
                  onClick={() => setAfter(result.next_after!)}
                >
                  Fils suivants
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
  const [range, setRange] = useState<{ fromSeq: number; toSeq?: number }>({ fromSeq: 1 });
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
        action: "history",
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
      (page.status !== "history" ||
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
    if (error || page?.status !== "history") return;
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
      <div className="flex flex-col gap-1 px-3 py-3">
        {detail ? (
          <>
            <h2 className="text-sm font-medium break-words">{detail.title}</h2>
            <p className="text-xs text-muted-foreground">
              {detail.members.map((member) => member.name ?? member.agent_id).join(" · ")}
            </p>
            <p className="text-xs text-muted-foreground">
              {detail.state === "closed" ? "Fermé" : "Ouvert"} ·{" "}
              {new Date(detail.created_at * 1000).toLocaleString()}
              {detail.closed_at !== null
                ? ` · Fermé le ${new Date(detail.closed_at * 1000).toLocaleString()}`
                : ""}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Chargement du fil…
          </p>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 pb-4">
          {visibleEntries.map((entry) => (
            <article
              key={entry.seq}
              aria-label={`Message ${entry.seq}`}
              className="flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-xs text-muted-foreground">
                  <span className="text-foreground">{entry.author_name ?? entry.author_id}</span> ·{" "}
                  {new Date(entry.created_at * 1000).toLocaleString()}
                  <span className="ml-2">
                    {entry.kind
                      ? {
                          history: "History",
                          action: "Action",
                          blocker: "Blocker",
                          decision: "Decision",
                        }[entry.kind]
                      : "Message"}{" "}
                    · #{entry.seq}
                  </span>
                  {entry.supersedes_seq != null ? (
                    <span> · Remplace #{entry.supersedes_seq}</span>
                  ) : null}
                  {entry.superseded_by_seq != null ? (
                    <span> · Remplacé par #{entry.superseded_by_seq}</span>
                  ) : null}
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Copier le message ${entry.seq}`}
                  onClick={() => {
                    void writeTextToClipboard(entry.body, "message Bridget").then(
                      (copied) =>
                        setCopyStatus(
                          copied ? `Message ${entry.seq} copié.` : "Ce message est vide.",
                        ),
                      () => setCopyStatus("Copie indisponible."),
                    );
                  }}
                >
                  <Copy />
                </Button>
              </div>
              <div data-bridget-body className="whitespace-pre-wrap break-words text-sm">
                {entry.body}
              </div>
            </article>
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
          {history?.has_more && history.next_from_seq !== null ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={query.isPending}
              onClick={() =>
                setRange({ fromSeq: history.next_from_seq!, toSeq: history.snapshot_seq })
              }
            >
              Page suivante
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
