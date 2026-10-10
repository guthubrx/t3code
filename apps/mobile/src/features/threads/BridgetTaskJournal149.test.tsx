// @vitest-environment jsdom
import {
  BridgetLineageError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BridgetJournalEvent,
  type BridgetLineageDetail,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, createElement, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BridgetTaskJournal } from "./BridgetTaskJournal";

// Session 149 — journal de tâche Bridget côté mobile, écran natif lecture seule
// (contracts/lineage.md §Journal, §Résultat, §Panne ; test-strategy.md S149-16).
// Les mécanismes de flux (dédup, pli, relances) sont prouvés côté état et web ;
// ce lot prouve l'intégration native : focus/arrière-plan, lecture paginée, arrêt.

const TASK_ID = "25000000-0000-4000-8000-000000000001";
const ROOT_THREAD_ID = "40000000-0000-4000-8000-000000000001";
// Compte les UUID générés : chaque action d'arrêt doit en produire un neuf.
const uuidCalls = vi.hoisted(() => ({ count: 0 }));

const listeners = new Set<() => void>();
const pendingReads: {
  input: Record<string, unknown>;
  resolve: (value: unknown) => void;
  signal: AbortSignal | undefined;
  settled: boolean;
}[] = [];
const cancelCalls: { command: unknown; input: unknown }[] = [];
type LineageTarget = { environmentId: string; input: { context: Record<string, unknown> } };
const native = {
  appState: "active",
  stateListeners: new Set<(state: string) => void>(),
  canOperate: true,
  journalValue: AsyncResult.success({
    events: [],
    nextSeq: 0,
    caughtUp: false,
    gap: null,
    evicted: 0,
  }) as unknown,
  watchValue: AsyncResult.success({ version: 1, seq: 0 }) as unknown,
  cancelResult: {
    _tag: "Success",
    value: { version: 1, task_id: TASK_ID, status: "cancelling" },
  } as unknown,
  activeJournals: 0,
  activeLineageWatches: 0,
  lastJournalTarget: null as LineageTarget | null,
  lastWatchTarget: null as LineageTarget | null,
};

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (_type: string, handler: (state: string) => void) => {
      native.stateListeners.add(handler);
      return { remove: () => native.stateListeners.delete(handler) };
    },
  },
  View: "View",
  ScrollView: "ScrollView",
  Text: "Text",
  // Mappe le geste natif sur un bouton DOM : onPress devient onClick.
  Pressable: (props: { onPress?: () => void; disabled?: boolean; children?: ReactNode }) =>
    createElement(
      "button",
      { type: "button", disabled: props.disabled === true, onClick: props.onPress },
      props.children,
    ),
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => `mobile-test-request-${++uuidCalls.count}`,
}));
vi.mock("../../state/orchestration", () => ({
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
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { kind?: string; target?: Record<string, unknown> }) =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        if (atom.kind === "lineage-journal") native.activeJournals += 1;
        if (atom.kind === "lineage-watch") native.activeLineageWatches += 1;
        return () => {
          listeners.delete(listener);
          if (atom.kind === "lineage-journal") native.activeJournals -= 1;
          if (atom.kind === "lineage-watch") native.activeLineageWatches -= 1;
        };
      },
      () => {
        if (atom.kind === "lineage-journal") {
          native.lastJournalTarget = atom.target as LineageTarget;
          return native.journalValue;
        }
        if (atom.kind === "lineage-watch") {
          native.lastWatchTarget = atom.target as LineageTarget;
          return native.watchValue;
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
  ) =>
    new Promise((resolve) => {
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
    }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (input: unknown) => {
    cancelCalls.push({ command, input });
    return native.cancelResult;
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => native.canOperate,
}));

const journalEvent = (seq: number): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts: `2026-10-10T10:05:${String(seq % 60).padStart(2, "0")}Z`,
  session_id: "session-journal",
  event: "tool",
  payload: `ligne ${seq}`,
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
    bridgetTask: {
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
      execution_protocol: "codex_app_server",
      model: "test-model",
      effort: "high",
      cwd: "/tmp/bridget",
      posture: "development",
      title: "Mission Bridget",
      status: "working",
      error: null,
      result_available: false,
      journal_available: true,
      ...overrides.task,
    },
    bridgetLineage:
      overrides.lineage === undefined
        ? { generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce", seq: 3, available: true }
        : overrides.lineage,
  }) as unknown as OrchestrationV2ThreadShell;

const environmentId = EnvironmentId.make("env-A");

let container: HTMLElement | null = null;
let root: Root | null = null;
function text(): string {
  return container?.textContent ?? "";
}
async function press(label: string) {
  const target = [...(container?.querySelectorAll("button") ?? [])].find((node) =>
    node.textContent?.includes(label),
  );
  if (!target) throw new Error(`Bouton introuvable : ${label}`);
  await act(async () => target.click());
}
async function mount(thread: OrchestrationV2ThreadShell) {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <BridgetTaskJournal environmentId={environmentId} thread={thread} bottomInset={0} />,
    );
  });
}
async function deliverJournal(state: Record<string, unknown>) {
  await act(async () => {
    native.journalValue = AsyncResult.success(state);
    for (const listener of listeners) listener();
  });
}
async function respond(match: (input: Record<string, unknown>) => boolean, value: unknown) {
  const pending = pendingReads.findLast((read) => match(read.input));
  if (!pending) throw new Error("Aucune lecture pending dans le fixture.");
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
const detail = (result: string, nextOffset: number | null): BridgetLineageDetail =>
  ({
    version: 1,
    status: "ok",
    generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce",
    seq: 5,
    root_owner_agent_id: "25000000-0000-4000-8000-000000000002",
    task: makeThread().bridgetTask,
    result,
    result_offset: nextOffset === null ? 16384 : 0,
    result_next_offset: nextOffset,
    result_total_bytes: 40000,
  }) as unknown as BridgetLineageDetail;

beforeEach(() => {
  listeners.clear();
  pendingReads.length = 0;
  cancelCalls.length = 0;
  uuidCalls.count = 0;
  native.appState = "active";
  native.stateListeners.clear();
  native.canOperate = true;
  native.journalValue = AsyncResult.success({
    events: [],
    nextSeq: 0,
    caughtUp: false,
    gap: null,
    evicted: 0,
  });
  native.watchValue = AsyncResult.success({ version: 1, seq: 0 });
  native.cancelResult = {
    _tag: "Success",
    value: { version: 1, task_id: TASK_ID, status: "cancelling" },
  };
  native.activeJournals = 0;
  native.activeLineageWatches = 0;
  native.lastJournalTarget = null;
  native.lastWatchTarget = null;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("BridgetTaskJournal (mobile, session 149)", () => {
  it("suit le journal à l'écran actif, coupe à l'arrière-plan et reprend avec afterSeq", async () => {
    await mount(makeThread());
    // Écran actif : watch + journal natifs souscrits, chargement annoncé.
    expect(native.activeJournals).toBe(1);
    expect(native.activeLineageWatches).toBe(1);
    expect(native.lastJournalTarget!.input.context).toMatchObject({
      projectId: "p-A",
      threadId: ROOT_THREAD_ID,
      taskId: TASK_ID,
      afterSeq: 0,
    });
    expect(text()).toContain("Journal Bridget · lecture seule");
    expect(text()).toContain("test-model · high");
    expect(text()).toContain("/tmp/bridget");
    expect(text()).toContain("Chargement du journal…");
    await deliverJournal({
      events: [journalEvent(7)],
      nextSeq: 7,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    expect(text()).toContain("ligne 7");
    expect(text()).not.toContain("Chargement du journal…");
    // Un gap explicite reste affiché, une éviction annonce l'historique.
    await deliverJournal({
      events: [],
      nextSeq: 8,
      caughtUp: true,
      gap: { from_seq: 4, to_seq: 5, reason: "transport" },
      evicted: 3,
    });
    expect(text()).toContain("Journal incomplet : 4–5 (transport).");
    expect(text()).toContain("Dernières 4 096 lignes");
    // Une lecture d'historique en vol au passage en arrière-plan est avortée.
    await press("Lire le début");
    expect(pendingReads).toHaveLength(1);
    await act(async () => {
      native.appState = "background";
      for (const handler of native.stateListeners) handler("background");
    });
    expect(native.activeJournals).toBe(0);
    expect(native.activeLineageWatches).toBe(0);
    expect(pendingReads[0]!.settled).toBe(true);
    expect(pendingReads[0]!.signal!.aborted).toBe(true);
    // Retour au premier plan : reprise depuis la dernière séquence connue.
    await act(async () => {
      native.appState = "active";
      for (const handler of native.stateListeners) handler("active");
    });
    expect(native.activeJournals).toBe(1);
    // La reprise porte la dernière séquence connue (nextSeq du dernier pli).
    expect(native.lastJournalTarget!.input.context.afterSeq).toBe(8);
  });

  it("lit le résultat paginé, garde le contenu en cas de panne, et confine l'arrêt à l'annulation native", async () => {
    await mount(makeThread({ task: { result_available: true } }));
    // Première page du résultat natif (UTF-8, 16 Kio) puis suite paginée.
    await press("Lire le résultat");
    expect(pendingReads.findLast((read) => isShow(read.input))!.input).toMatchObject({
      taskId: TASK_ID,
      offset: 0,
      limit: 16384,
    });
    const partieUne = `Partie une — 你好 🎉 é · ${"x".repeat(16384 - 20)}`;
    await respond(isShow, detail(partieUne, 16384));
    expect(text()).toContain("Résultat");
    expect(text()).toContain("你好 🎉");
    await press("Suite du résultat");
    expect(pendingReads.findLast((read) => isShow(read.input))!.input.offset).toBe(16384);
    // Panne du lecteur en pleine pagination : message d'échec, contenu déjà lu conservé.
    await respond(
      isShow,
      AsyncResult.failure(Cause.fail(new BridgetLineageError({ code: "snapshot_changed" }))),
    );
    expect(text()).toContain("snapshot_changed");
    expect(text()).toContain("你好 🎉");
    // Reprise : la suite paginée complète le résultat, puis la fin retire le bouton.
    await press("Suite du résultat");
    await respond(isShow, detail("partie-deux", null));
    expect(text()).toContain("partie-deux");
    expect(text()).not.toContain("Suite du résultat");
    // Arrêt : annulation native avec UUID local, jamais un tour T3.
    await press("Arrêter");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.input).toMatchObject({
      environmentId: "env-A",
      input: {
        projectId: "p-A",
        threadId: ROOT_THREAD_ID,
        taskId: TASK_ID,
        requestId: "mobile-test-request-1",
      },
    });
    // « Dernier état connu » : Bridget indisponible, l'arrêt est fermé.
    await mount(
      makeThread({
        task: { status: "result_available" },
        lineage: { generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce", seq: 3, available: false },
      }),
    );
    expect(text()).toContain("Dernier état connu");
    await press("Arrêter").catch(() => {});
    expect(cancelCalls).toHaveLength(1);
    // Tâche terminale : plus d'arrêt non plus.
    await mount(makeThread({ task: { status: "result_available" } }));
    expect(text()).not.toContain("Arrêter");
    // Sans le scope opérer : pas d'arrêt affiché du tout.
    native.canOperate = false;
    await mount(makeThread());
    expect(text()).not.toContain("Arrêter");
    // Un seul UUID généré : à l'action d'arrêt, jamais pour les arrêts fermés.
    expect(uuidCalls.count).toBe(1);
  });
});
