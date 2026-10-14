import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
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
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import { AppState, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { orchestrationEnvironment } from "../../state/orchestration";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useFontFamily } from "../../lib/useFontFamily";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { RequestActionButton } from "./RequestActionButton";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";

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

const contactLabels = {
  connected: "Contact observé",
  stale: "Contact perdu",
  unknown: "Contact inconnu",
} as const;

const JOURNAL_MARKDOWN_RENDERERS: CustomRenderers = {
  link: ({ children }) => (
    <Text selectable className="text-foreground underline">
      {children}
    </Text>
  ),
  image: ({ node }) => (
    <Text selectable className="text-foreground-secondary">
      {node.alt ? `[image: ${node.alt}]` : "[image]"}
    </Text>
  ),
};

const ignoreJournalLink = (_href: string) => undefined;

const renderInertJournalImage: MarkdownImageRenderer = ({ alt }) => (
  <Text selectable className="text-foreground-secondary">
    {alt ? `[image: ${alt}]` : "[image]"}
  </Text>
);

interface JournalMarkdownPresentation {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
}

function useJournalMarkdownPresentation(): JournalMarkdownPresentation {
  const { appearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  const body = theme["--color-md-body"];
  const strong = theme["--color-md-strong"];
  const link = theme["--color-md-link"];
  const blockquoteBorder = theme["--color-md-blockquote-border"];
  const blockquoteBackground = theme["--color-md-blockquote-bg"];
  const codeBackground = theme["--color-md-code-bg"];
  const codeText = theme["--color-md-code-text"];
  const horizontalRule = theme["--color-md-hr"];
  const regularFontFamily = useFontFamily("regular");
  const mediumFontFamily = useFontFamily("medium");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(
    () => ({
      nativeTextStyle: {
        color: body,
        strongColor: strong,
        mutedColor: body,
        linkColor: link,
        inlineCodeColor: codeText,
        codeColor: codeText,
        codeBackgroundColor: codeBackground,
        codeBlockBackgroundColor: codeBackground,
        fileTextColor: codeText,
        skillTextColor: codeText,
        quoteMarkerColor: blockquoteBorder,
        dividerColor: horizontalRule,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
      theme: {
        colors: {
          text: body,
          heading: strong,
          link,
          blockquote: blockquoteBorder,
          border: horizontalRule,
          surface: "transparent",
          surfaceLight: blockquoteBackground,
          accent: link,
          tableBorder: horizontalRule,
          tableHeader: blockquoteBackground,
          tableHeaderText: strong,
          tableRowOdd: blockquoteBackground,
          tableRowEven: "transparent",
          code: codeText,
          codeBackground,
        },
        fontSizes: {
          s: markdownFontSizes.s,
          m: markdownFontSizes.m,
          h1: markdownFontSizes.h1,
          h2: markdownFontSizes.h2,
          h3: markdownFontSizes.h3,
          h4: markdownFontSizes.h4,
          h5: markdownFontSizes.h5,
          h6: markdownFontSizes.h6,
        },
        fontFamilies: {
          regular: regularFontFamily,
          heading: boldFontFamily,
          mono: "ui-monospace",
        },
      },
      styles: {
        document: { flexShrink: 1 },
        paragraph: { marginTop: 0, marginBottom: 10 },
        text: {
          color: body,
          fontFamily: regularFontFamily,
          fontSize: markdownFontSizes.m,
          lineHeight: markdownFontSizes.bodyLineHeight,
        },
        heading: { color: strong, fontFamily: boldFontFamily },
        bold: { color: strong, fontFamily: boldFontFamily },
        link: { color: link, fontFamily: mediumFontFamily },
        blockquote: {
          backgroundColor: blockquoteBackground,
          borderLeftColor: blockquoteBorder,
          borderLeftWidth: 3,
          paddingLeft: 12,
        },
        code_inline: {
          backgroundColor: codeBackground,
          color: codeText,
          fontFamily: "ui-monospace",
        },
        code_block: { backgroundColor: codeBackground, borderRadius: 12, padding: 12 },
        horizontal_rule: { backgroundColor: horizontalRule },
      },
    }),
    [
      blockquoteBackground,
      blockquoteBorder,
      body,
      boldFontFamily,
      codeBackground,
      codeText,
      horizontalRule,
      link,
      markdownFontSizes,
      mediumFontFamily,
      nativeMarkdownTypography,
      regularFontFamily,
      strong,
    ],
  );
}

const JournalMarkdown = memo(function JournalMarkdown({ markdown }: { readonly markdown: string }) {
  const presentation = useJournalMarkdownPresentation();
  if (hasNativeSelectableMarkdownText()) {
    return (
      <SelectableMarkdownText
        markdown={markdown}
        textStyle={presentation.nativeTextStyle}
        onLinkPress={ignoreJournalLink}
        renderImage={renderInertJournalImage}
      />
    );
  }
  return (
    <Markdown
      options={{ gfm: true }}
      renderers={JOURNAL_MARKDOWN_RENDERERS}
      styles={presentation.styles}
      theme={presentation.theme}
    >
      {markdown}
    </Markdown>
  );
});

const JournalBlockView = memo(function JournalBlockView({
  block,
}: {
  readonly block: BridgetJournalBlock;
}) {
  const [open, setOpen] = useState(false);
  const preview = typeof block.events[0]?.payload === "string" ? block.events[0].payload : null;
  return (
    <View className="border-b border-border-subtle py-3">
      {block.excerpt ? (
        <Text className="mb-2 text-xs text-foreground-secondary">
          Extrait : le début de ce segment n’est pas chargé.
        </Text>
      ) : null}
      {block.kind === "text" ? (
        <JournalMarkdown markdown={block.content} />
      ) : (
        <View className="rounded-xl border border-border bg-subtle px-3 py-2">
          <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)}>
            <Text className="font-t3-bold text-foreground">
              {block.label}
              {block.kind === "activity" && block.text ? ` · ${block.text}` : ""}
              {block.kind === "technical" && preview ? ` · ${preview}` : ""}
            </Text>
          </Pressable>
          {open && block.kind === "activity" ? (
            <View className="mt-2 gap-1">
              {block.detail ? (
                <Text className="text-foreground">Détail : {block.detail}</Text>
              ) : null}
              {block.toolCallId ? (
                <Text className="text-foreground">Identifiant d’appel : {block.toolCallId}</Text>
              ) : null}
              {block.exitCode !== null ? (
                <Text className="text-foreground">Code de sortie : {block.exitCode}</Text>
              ) : null}
              {block.status ? (
                <Text className="text-foreground">Statut : {block.status}</Text>
              ) : null}
              {block.state ? <Text className="text-foreground">État : {block.state}</Text> : null}
              {block.outputTail !== null ? (
                <Text selectable className="font-mono text-xs text-foreground">
                  {block.outputTail}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        className="mt-2"
        onPress={() => setOpen((value) => !value)}
      >
        <Text className="text-xs text-foreground-secondary">
          {open ? "Masquer les détails techniques" : "Détails techniques"} · #{block.firstSeq}– #
          {block.lastSeq}
        </Text>
      </Pressable>
      {open ? (
        <View className="mt-2 gap-2">
          {block.conflicts.map((conflict) => (
            <View
              key={`conflict:${conflict.seq}`}
              className="rounded border border-border px-2 py-1"
            >
              <Text className="font-t3-bold text-xs text-foreground">
                Conflit de rejeu #{conflict.seq}
              </Text>
              <Text selectable className="font-mono text-xs text-foreground">
                {JSON.stringify(conflict.conflicting, null, 2)}
              </Text>
            </View>
          ))}
          {block.events.map((event) => (
            <Text
              key={event.seq}
              selectable
              className="font-mono text-xs text-foreground-secondary"
            >
              {JSON.stringify(event, null, 2)}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
});

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
  const [journal, setJournal] = useState<{
    readonly events: ReadonlyArray<BridgetJournalEvent>;
    readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
    readonly headCut: boolean;
    readonly gaps: ReadonlyArray<BridgetJournalGap>;
    readonly continuityCut: BridgetJournalContinuityCut | null;
  }>({ events: [], conflicts: [], headCut: false, gaps: [], continuityCut: null });
  const [gap, setGap] = useState<BridgetLineageJournal["gap"]>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);
  const [evicted, setEvicted] = useState(false);
  const [history, setHistory] = useState<BridgetLineageJournal | null>(null);
  const [historyAfterSeq, setHistoryAfterSeq] = useState<number | null>(null);
  const [detail, setDetail] = useState<BridgetLineageDetail | null>(null);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const lastSeq = useRef(0);
  const liveProjection = useRef<BridgetJournalProjection | null>(null);
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
      } else if (value !== null && "events" in value) {
        setHistory(value);
        setHistoryAfterSeq(offset);
      }
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
  const nativeStatus = task?.status ?? ref.status;
  const placement = task?.placement;
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
        <Text className="mt-1 text-foreground-secondary">{statusLabels[nativeStatus]}</Text>
        {placement === undefined ? (
          <Text className="mt-1 text-foreground-secondary">
            Métadonnées distantes indisponibles
          </Text>
        ) : placement === null ? (
          <Text className="mt-1 text-foreground-secondary">Aucun placement distant</Text>
        ) : (
          <>
            <Text className="mt-1 text-foreground-secondary">
              {placement.display_name ?? placement.machine_id} ({placement.machine_id})
            </Text>
            <Text className="mt-1 text-foreground-secondary">
              {contactLabels[placement.contact_state]}
              {typeof placement.last_contact_at !== "number"
                ? " · date inconnue"
                : ` · ${new Date(placement.last_contact_at * 1_000).toLocaleString("fr-FR")}`}
            </Text>
          </>
        )}
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
        {journal.continuityCut ? (
          <Text className="mt-2 text-foreground-secondary">
            Continuité incertaine : les fragments ne sont pas regroupés entre{" "}
            {journal.continuityCut.fromSeq}–{journal.continuityCut.toSeq}.
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
              onPress={() => {
                setHistory(null);
                setHistoryAfterSeq(null);
              }}
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
            <JournalMarkdown markdown={result} />
            <RequestActionButton
              label="Copier le résultat chargé"
              tone="secondary"
              onPress={() => copyTextWithHaptic(result, { target: "résultat Bridget" })}
            />
            {detail.result_next_offset !== null ? (
              <>
                <Text className="text-xs text-foreground-secondary">
                  Résultat partiel : la suite n’est pas encore chargée.
                </Text>
                <RequestActionButton
                  label="Suite du résultat"
                  tone="secondary"
                  disabled={busy}
                  onPress={() => void inspect("show", detail.result_next_offset!)}
                />
              </>
            ) : null}
          </View>
        ) : null}
        {projection.blocks.map((block) => (
          <JournalBlockView key={block.key} block={block} />
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
