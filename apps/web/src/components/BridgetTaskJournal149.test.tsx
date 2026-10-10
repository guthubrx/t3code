import {
  BridgetLineageError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BridgetLineageDetail,
  type BridgetLineageJournal,
  type BridgetJournalEvent,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BridgetLineageSubscription, BridgetTaskJournal } from "./BridgetTaskJournal";

// Session 149 — journal de tâche Bridget côté web
// (contracts/lineage.md §Journal, §Résultat, §Panne ; test-strategy.md S149-16).

const TASK_ID = "25000000-0000-4000-8000-000000000001";
const ROOT_THREAD_ID = "40000000-0000-4000-8000-000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestIdOf = (call: { input: unknown }) =>
  (call.input as { input: { requestId: string } }).input.requestId;

const listeners = new Set<() => void>();
const pendingReads: {
  input: Record<string, unknown>;
  resolve: (value: unknown) => void;
  signal: AbortSignal | undefined;
  settled: boolean;
}[] = [];
const cancelCalls: { command: unknown; input: unknown }[] = [];
let journalValue: unknown = AsyncResult.success({
  events: [],
  nextSeq: 0,
  caughtUp: false,
  gap: null,
  evicted: 0,
});
let watchValue: unknown = AsyncResult.success({ version: 1, seq: 0 });
let activeJournals = 0;
let activeLineageWatches = 0;
let lastJournalTarget: { environmentId: string; input: Record<string, unknown> } | null = null;
let lastWatchTarget: { environmentId: string; input: Record<string, unknown> } | null = null;
let canOperate = true;
let cancelResult: unknown = {
  _tag: "Success",
  value: { version: 1, task_id: TASK_ID, status: "cancelling" },
};
let visibilityState = "visible";
const visibilityListeners = new Set<() => void>();
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("document", {
  get visibilityState() {
    return visibilityState;
  },
  addEventListener: (_type: string, listener: () => void) => {
    visibilityListeners.add(listener);
  },
  removeEventListener: (_type: string, listener: () => void) => {
    visibilityListeners.delete(listener);
  },
});

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    bridgetLineageRead: (target: { environmentId: string; input: Record<string, unknown> }) =>
      target,
    bridgetLineageWatch: (target: { environmentId: string; input: Record<string, unknown> }) => ({
      kind: "lineage-watch",
      target,
    }),
    bridgetLineageJournal: (target: { environmentId: string; input: Record<string, unknown> }) => ({
      kind: "lineage-journal",
      target,
    }),
    bridgetLineageCancel: { label: "environment-data:orchestration:bridget-lineage-cancel" },
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { kind?: string; target?: Record<string, unknown> }) =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        if (atom.kind === "lineage-journal") activeJournals += 1;
        if (atom.kind === "lineage-watch") activeLineageWatches += 1;
        return () => {
          listeners.delete(listener);
          if (atom.kind === "lineage-journal") activeJournals -= 1;
          if (atom.kind === "lineage-watch") activeLineageWatches -= 1;
        };
      },
      () => {
        if (atom.kind === "lineage-journal") {
          lastJournalTarget = atom.target as {
            environmentId: string;
            input: Record<string, unknown>;
          };
          return journalValue;
        }
        if (atom.kind === "lineage-watch") {
          lastWatchTarget = atom.target as {
            environmentId: string;
            input: Record<string, unknown>;
          };
          return watchValue;
        }
        return { _tag: "Success", value: null };
      },
    ),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (
    _registry: unknown,
    target: { input: Record<string, unknown> },
    options: { signal?: AbortSignal },
  ) => {
    return new Promise((resolve) => {
      const pending = { input: target.input, resolve, signal: options.signal, settled: false };
      pendingReads.push(pending);
      options.signal?.addEventListener(
        "abort",
        () => {
          pending.settled = true;
          resolve({ _tag: "Failure", cause: Cause.fail(new Error("aborted")) });
        },
        { once: true },
      );
    });
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (input: unknown) => {
    cancelCalls.push({ command, input });
    return cancelResult;
  },
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => canOperate,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn(async () => true) }));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));

const journalEvent = (seq: number): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts: `2026-10-10T10:05:${String(seq % 60).padStart(2, "0")}Z`,
  session_id: "session-journal",
  event: "tool",
  payload: `ligne ${seq}`,
});

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  task_id: TASK_ID,
  parent_task_id: null,
  parent_agent_id: "25000000-0000-4000-8000-000000000002",
  child_agent_id: "25000000-0000-4000-8000-000000000003",
  child_instance_id: null,
  created_at: 1700000000,
  updated_at: 1700000000,
  started_at: 1700000000,
  completed_at: null,
  agent_type: "general",
  execution_protocol: "codex_app_server" as const,
  model: "test-model",
  effort: "high",
  cwd: "/tmp/bridget",
  posture: "development" as const,
  title: "Mission Bridget",
  status: "working" as const,
  error: null,
  result_available: false,
  journal_available: true,
  ...overrides,
});

const makeThread = (
  overrides: {
    task?: Record<string, unknown>;
    lineage?: Record<string, unknown> | null;
  } = {},
) =>
  ({
    id: ThreadId.make("30000000-0000-4000-8000-000000000009"),
    projectId: ProjectId.make("p-A"),
    title: "Fil parent",
    modelSelection: { instanceId: "codex", model: "fallback-model", options: [] },
    bridgetTaskRef: {
      version: 1,
      taskId: TASK_ID,
      rootThreadId: ThreadId.make(ROOT_THREAD_ID),
      parentTaskId: null,
      generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce",
      seq: 1,
      status: "working",
    },
    bridgetTask: makeTask(overrides.task),
    bridgetLineage:
      overrides.lineage === undefined
        ? { generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce", seq: 3, available: true }
        : overrides.lineage,
  }) as unknown as OrchestrationV2AppThread;

const environmentId = EnvironmentId.make("env-A");

let renderer: ReactTestRenderer | null = null;
// Aplatit l'arbre rendu en texte continu (les tableaux d'enfants coupent les phrases).
function flatten(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  const element = node as { children?: unknown };
  return flatten(element.children);
}
function text(): string {
  return flatten(renderer?.toJSON());
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.includes(label));
}
async function mount(thread: OrchestrationV2AppThread, onOpenParent?: () => void) {
  await act(async () => {
    renderer = create(
      <BridgetTaskJournal
        environmentId={environmentId}
        thread={thread}
        onOpenParent={onOpenParent ?? null}
      />,
    );
  });
}
async function deliverJournal(state: Record<string, unknown>) {
  await act(async () => {
    journalValue = AsyncResult.success(state);
    for (const listener of listeners) listener();
  });
}
async function deliverJournalFailure(code: string) {
  await act(async () => {
    journalValue = AsyncResult.failure(
      Cause.fail(new BridgetLineageError({ code: code as never })),
    );
    for (const listener of listeners) listener();
  });
}
async function respond(match: (input: Record<string, unknown>) => boolean, value: unknown) {
  const pending = pendingReads.findLast((read) => match(read.input));
  if (!pending) throw new Error("Aucune lecture pending dans le fixture.");
  // executeAtomQuery résout un AsyncResult : envelopper la valeur de succès.
  const resolved =
    value !== null && typeof value === "object" && "_tag" in (value as object)
      ? value
      : AsyncResult.success(value);
  await act(async () => {
    pending.settled = true;
    pending.resolve(resolved);
  });
}
const isShow = (input: Record<string, unknown>) => input.action === "show";
const isJournalRead = (input: Record<string, unknown>) => input.action === "journal";

beforeEach(() => {
  listeners.clear();
  pendingReads.length = 0;
  cancelCalls.length = 0;
  journalValue = AsyncResult.success({
    events: [],
    nextSeq: 0,
    caughtUp: false,
    gap: null,
    evicted: 0,
  });
  watchValue = AsyncResult.success({ version: 1, seq: 0 });
  activeJournals = 0;
  activeLineageWatches = 0;
  lastJournalTarget = null;
  lastWatchTarget = null;
  canOperate = true;
  cancelResult = { _tag: "Success", value: { version: 1, task_id: TASK_ID, status: "cancelling" } };
  visibilityState = "visible";
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("BridgetTaskJournal (web, session 149)", () => {
  it("montre le chargement, déduplique par seq, trie, puis affiche gap et éviction", async () => {
    await mount(makeThread());
    expect(text()).toContain("Chargement du journal…");
    await deliverJournal({
      events: [journalEvent(47), journalEvent(43), journalEvent(43), journalEvent(42)],
      nextSeq: 47,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    expect(text()).not.toContain("Chargement du journal…");
    const seqs = renderer!.root
      .findAll((node) => node.props["data-journal-seq"] !== undefined)
      .map((node) => node.props["data-journal-seq"]);
    expect(seqs).toEqual([42, 43, 47]);
    await deliverJournal({
      events: [],
      nextSeq: 48,
      caughtUp: true,
      gap: { from_seq: 44, to_seq: 45, reason: "transport" },
      evicted: 0,
    });
    expect(text()).toContain("Journal incomplet : séquences 44–45 (transport).");
    await deliverJournal({
      events: [],
      nextSeq: 48,
      caughtUp: true,
      gap: null,
      evicted: 904,
    });
    expect(text()).toContain("Les 4 096 dernières lignes");
  });

  it("lit le résultat par fenêtres de 16 Kio UTF-8 et conserve le contenu sur refus", async () => {
    await mount(makeThread({ task: { result_available: true } }));
    expect(button("Lire le résultat")).toBeTruthy();
    await act(async () => button("Lire le résultat")!.props.onClick());
    expect(pendingReads.length).toBe(1);
    expect(pendingReads[0]!.input).toMatchObject({
      projectId: "p-A",
      threadId: ROOT_THREAD_ID,
      action: "show",
      taskId: TASK_ID,
      offset: 0,
      limit: 16384,
    });
    const detail = (partial: string, nextOffset: number | null): BridgetLineageDetail =>
      ({
        version: 1,
        status: "ok",
        generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce",
        seq: 5,
        root_owner_agent_id: "25000000-0000-4000-8000-000000000002",
        task: makeTask({ result_available: true }),
        result: partial,
        result_offset: nextOffset === null ? 16384 : 0,
        result_next_offset: nextOffset,
        result_total_bytes: 40000,
      }) as unknown as BridgetLineageDetail;
    await respond(isShow, detail("Partie une — 你好 🎉 é", 16384));
    expect(text()).toContain("Partie une — 你好 🎉 é");
    expect(button("Suite du résultat")).toBeTruthy();
    await act(async () => button("Suite du résultat")!.props.onClick());
    expect(pendingReads[1]!.input).toMatchObject({ action: "show", offset: 16384, limit: 16384 });
    await respond(isShow, detail("partie-deux", null));
    expect(text()).toContain("Partie une — 你好 🎉 é");
    expect(text()).toContain("partie-deux");
    expect(button("Suite du résultat")).toBeUndefined();
    // Refus fermé : message avec code, contenu déjà lu conservé.
    pendingReads.length = 0;
    await act(async () => button("Lire le début")!.props.onClick());
    await respond(isJournalRead, {
      _tag: "Failure",
      cause: Cause.fail(new BridgetLineageError({ code: "snapshot_changed" })),
    });
    expect(text()).toContain("Bridget indisponible (snapshot_changed)");
    expect(text()).toContain("partie-deux");
  });

  it("interrompt la souscription page masquée, avorte les lectures et reprend au dernier seq", async () => {
    await mount(makeThread());
    expect(activeJournals).toBe(1);
    expect(lastJournalTarget?.input.context).toMatchObject({
      projectId: "p-A",
      threadId: ROOT_THREAD_ID,
      taskId: TASK_ID,
      afterSeq: 0,
    });
    await deliverJournal({
      events: [journalEvent(7), journalEvent(8)],
      nextSeq: 8,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    // Lecture en vol, puis masquage : abort immédiat de toutes les requêtes.
    await act(async () => button("Lire le début")!.props.onClick());
    expect(pendingReads.length).toBe(1);
    await act(async () => {
      visibilityState = "hidden";
      for (const listener of visibilityListeners) listener();
    });
    expect(activeJournals).toBe(0);
    expect(pendingReads[0]!.settled).toBe(true);
    // Retour au premier plan : une nouvelle souscription repart du dernier seq.
    await act(async () => {
      visibilityState = "visible";
      for (const listener of visibilityListeners) listener();
    });
    expect(activeJournals).toBe(1);
    expect(lastJournalTarget?.input.context).toMatchObject({ afterSeq: 8 });
  });

  it("garde le statut historique sans disponibilité feinte et conserve le journal en cas de panne", async () => {
    await mount(
      makeThread({
        lineage: { generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce", seq: 3, available: false },
      }),
    );
    expect(text()).toContain("Dernier état connu");
    expect(text()).not.toContain("En cours");
    // Non terminal + droit d'opérer, mais Bridget indisponible : arrêt fermé.
    expect(button("Arrêter")).toBeTruthy();
    expect(button("Arrêter")!.props.disabled).toBe(true);
    await deliverJournal({
      events: [journalEvent(7)],
      nextSeq: 7,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await deliverJournalFailure("store_unavailable");
    expect(text()).toContain("Bridget indisponible (store_unavailable)");
    expect(text()).toContain("Le contenu déjà lu est conservé.");
    // Les lignes déjà reçues restent rendues après la panne.
    expect(text()).toContain("ligne 7");
  });

  it("tâche annulée : journal indisponible lu sans annoncer Bridget indisponible, historique conservé", async () => {
    await mount(makeThread({ task: { status: "cancelled" } }));
    await deliverJournal({
      events: [journalEvent(7)],
      nextSeq: 7,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await act(async () => button("Lire le début")!.props.onClick());
    expect(pendingReads[0]!.input).toMatchObject({ action: "journal", afterSeq: 0 });
    // Lecture réelle refusée : seul le journal est en panne, pas le service Bridget.
    await respond(isJournalRead, {
      _tag: "Failure",
      cause: Cause.fail(new BridgetLineageError({ code: "journal_unavailable" })),
    });
    const statuses = renderer!.root
      .findAll((node) => node.props.role === "status")
      .map((node) => flatten(node.props.children));
    expect(statuses).toContain(
      "Journal de la tâche indisponible (journal_unavailable). Le contenu déjà lu est conservé.",
    );
    expect(text()).not.toContain("Bridget indisponible");
    expect(text()).not.toContain("Lineage Bridget indisponible");
    // Historique déjà reçu conservé, contrôles de suivi toujours présents.
    expect(text()).toContain("ligne 7");
    expect(text()).toContain("Annulé");
    expect(button("Reconnecter")).toBeTruthy();
    expect(button("Lire le début")).toBeTruthy();
    // Tâche terminale : pas de bouton d'arrêt, alors que le droit d'opérer est accordé.
    expect(canOperate).toBe(true);
    expect(button("Arrêter")).toBeUndefined();
  });

  it("arrête la tâche via l'annulation native Bridget, jamais un tour T3", async () => {
    const onOpenParent = vi.fn();
    await mount(makeThread(), onOpenParent);
    expect(renderer!.root.findByType("section").props["aria-label"]).toBe(
      "Journal de la tâche Bridget",
    );
    expect(button("Ouvrir le parent")).toBeTruthy();
    await act(async () => button("Ouvrir le parent")!.props.onClick());
    expect(onOpenParent).toHaveBeenCalled();
    expect(renderer!.root.findByType("section").props["aria-label"]).toBe(
      "Journal de la tâche Bridget",
    );
    await act(async () => button("Arrêter")!.props.onClick());
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]!.command).toMatchObject({
      label: "environment-data:orchestration:bridget-lineage-cancel",
    });
    expect(cancelCalls[0]!.input).toMatchObject({
      environmentId,
      input: { projectId: "p-A", threadId: ROOT_THREAD_ID, taskId: TASK_ID },
    });
    expect(UUID_RE.test(requestIdOf(cancelCalls[0]!))).toBe(true);
    // Refus d'annulation : message avec code, pas de crash.
    cancelResult = {
      _tag: "Failure",
      cause: Cause.fail(new BridgetLineageError({ code: "command_failed" })),
    };
    await act(async () => button("Reconnecter")!.props.onClick());
    await act(async () => button("Arrêter")!.props.onClick());
    expect(text()).toContain("Bridget indisponible (command_failed)");
    // Chaque action d'arrêt génère un UUID frais (helper repo, jamais un identifiant figé).
    expect(cancelCalls.length).toBe(2);
    expect(UUID_RE.test(requestIdOf(cancelCalls[1]!))).toBe(true);
    expect(requestIdOf(cancelCalls[1]!)).not.toBe(requestIdOf(cancelCalls[0]!));
    // Tâche terminale : plus aucun bouton d'arrêt.
    await act(async () => renderer?.unmount());
    await mount(makeThread({ task: { status: "failed", error: "processus mort" } }));
    expect(text()).toContain("processus mort");
    expect(button("Arrêter")).toBeUndefined();
    // Sans droit d'opérer : pas d'arrêt non plus.
    await act(async () => renderer?.unmount());
    canOperate = false;
    await mount(makeThread());
    expect(button("Arrêter")).toBeUndefined();
  });

  it("pagine l'historique du journal par 100 et revient au suivi live", async () => {
    await mount(makeThread());
    await deliverJournal({
      events: [journalEvent(7), journalEvent(8)],
      nextSeq: 8,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await act(async () => button("Lire le début")!.props.onClick());
    expect(pendingReads[0]!.input).toMatchObject({
      action: "journal",
      taskId: TASK_ID,
      afterSeq: 0,
      limit: 100,
    });
    const history = (
      events: BridgetJournalEvent[],
      nextSeq: number,
      caughtUp: boolean,
    ): BridgetLineageJournal => ({
      version: 1,
      status: "ok",
      task_id: TASK_ID,
      events,
      next_seq: nextSeq,
      caught_up: caughtUp,
      gap: null,
    });
    await respond(isJournalRead, history([journalEvent(1), journalEvent(2)], 100, false));
    expect(text()).toContain("ligne 1");
    expect(button("Page suivante")).toBeTruthy();
    expect(button("Page suivante")!.props.disabled).toBe(false);
    await act(async () => button("Page suivante")!.props.onClick());
    expect(pendingReads[1]!.input).toMatchObject({ action: "journal", afterSeq: 100, limit: 100 });
    await respond(isJournalRead, history([], 150, true));
    expect(button("Page suivante")!.props.disabled).toBe(true);
    await act(async () => button("Retour au suivi")!.props.onClick());
    expect(text()).toContain("ligne 7");
  });
});

describe("BridgetLineageSubscription (web, session 149)", () => {
  const context = {
    environmentId,
    projectId: ProjectId.make("p-A"),
    threadId: ThreadId.make(ROOT_THREAD_ID),
  };

  it("propose la reconnexion sur échec connu et recrée le watch lineage", async () => {
    const { create: createRenderer } = await import("react-test-renderer");
    await act(async () => {
      renderer = createRenderer(<BridgetLineageSubscription context={context} known={true} />);
    });
    expect(activeLineageWatches).toBe(1);
    expect(lastWatchTarget?.input.context).toMatchObject({
      projectId: "p-A",
      threadId: ROOT_THREAD_ID,
    });
    // Succès : pas de bannière.
    expect(text()).not.toContain("Lineage Bridget indisponible");
    await act(async () => {
      watchValue = AsyncResult.failure(
        Cause.fail(new BridgetLineageError({ code: "unavailable" })),
      );
      for (const listener of listeners) listener();
    });
    expect(text()).toContain("Lineage Bridget indisponible");
    const previousWatchTarget = lastWatchTarget;
    await act(async () => button("Reconnecter Bridget")!.props.onClick());
    // Le watch est recréé avec un nouveau visitId (nouvelle visite).
    expect(lastWatchTarget).not.toBe(previousWatchTarget);
    await act(async () => {
      watchValue = AsyncResult.success({ version: 1, seq: 1 });
      for (const listener of listeners) listener();
    });
    expect(text()).not.toContain("Lineage Bridget indisponible");
  });
});

// Session 149 r4 — F2 : la barre « lecture seule » du parent flotte au-dessus du conteneur
// défilant du journal. Sa hauteur mesurée doit devenir la marge basse (une seule fois).
describe("BridgetTaskJournal (web, session 149) — marge basse sous la barre flottante", () => {
  const scrollStyle = () =>
    renderer!.root.findAll(
      (node) => node.type === "div" && String(node.props.className ?? "").includes("overflow-auto"),
    )[0]?.props.style as { paddingBottom?: string } | undefined;

  it("réserve la hauteur mesurée de [data-chat-composer-overlay], suit le redimensionnement et se détache", async () => {
    let height = 40;
    let resize: (() => void) | undefined;
    let disconnected = 0;
    const overlay = { getBoundingClientRect: () => ({ height }) };
    const canvas = {
      querySelector: (selector: string) =>
        selector === "[data-chat-composer-overlay]" ? overlay : null,
    };
    const scrollNode = {
      closest: (selector: string) => (selector === "[data-chat-canvas]" ? canvas : null),
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          disconnected += 1;
        }
      },
    );
    try {
      await act(async () => {
        renderer = create(
          <BridgetTaskJournal
            environmentId={environmentId}
            thread={makeThread()}
            onOpenParent={null}
          />,
          { createNodeMock: (element) => (element.type === "div" ? scrollNode : null) },
        );
      });
      // Marge normale 0.75rem + hauteur de la barre : pas de py-3 doublé.
      expect(scrollStyle()?.paddingBottom).toBe("calc(0.75rem + 40px)");
      height = 72;
      await act(async () => resize?.());
      expect(scrollStyle()?.paddingBottom).toBe("calc(0.75rem + 72px)");
      await act(async () => renderer?.unmount());
      renderer = null;
      expect(disconnected).toBe(1);
    } finally {
      vi.stubGlobal("ResizeObserver", undefined);
    }
  });

  it("sans barre flottante dans le canevas : marge normale seule", async () => {
    const scrollNode = { closest: () => ({ querySelector: () => null }) };
    await act(async () => {
      renderer = create(
        <BridgetTaskJournal
          environmentId={environmentId}
          thread={makeThread()}
          onOpenParent={null}
        />,
        { createNodeMock: (element) => (element.type === "div" ? scrollNode : null) },
      );
    });
    expect(scrollStyle()?.paddingBottom).toBe("calc(0.75rem + 0px)");
  });
});
