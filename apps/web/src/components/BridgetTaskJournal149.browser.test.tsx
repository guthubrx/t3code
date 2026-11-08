import { act, render, type Screen } from "../../test/render";
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
import { useSyncExternalStore } from "react";
import { describe, expect, it as baseIt, vi } from "vite-plus/test";

import { type BridgetJournalProjection } from "@t3tools/client-runtime/bridget-journal-presentation";
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
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {},
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
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
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
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
vi.mock("~/hooks/useCopyToClipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useCopyToClipboard")>()),
  writeTextToClipboard: vi.fn(async () => true),
}));
vi.mock("~/components/ui/button", () => ({
  Button: "button",
  buttonVariants: () => "",
}));
vi.mock("./ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

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

let screen: Screen;
const all = (selector: string, scope: HTMLElement = screen.container): HTMLElement[] => [
  ...(scope.matches(selector) ? [scope] : []),
  ...scope.querySelectorAll<HTMLElement>(selector),
];
const one = (selector: string, scope: HTMLElement = screen.container): HTMLElement => {
  const node = all(selector, scope)[0];
  if (!node) throw new Error(`Missing DOM element: ${selector}`);
  return node;
};
function text(): string {
  return screen.container.textContent ?? "";
}
function button(label: string) {
  return all("button").find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
  )!;
}
function CaptureJournal({ blocks }: BridgetJournalProjection) {
  return (
    <ol>
      {blocks.map((block) => (
        <li key={block.key} data-journal-seq={block.firstSeq}>
          {block.excerpt ? <span>Extrait :</span> : null}
          {block.kind === "text"
            ? block.content
            : block.kind === "activity"
              ? `${block.label} · ${block.text ?? ""}`
              : typeof block.events[0]?.payload === "string"
                ? block.events[0].payload
                : "Activité technique"}
        </li>
      ))}
    </ol>
  );
}
async function mount(thread: OrchestrationV2AppThread, onOpenParent?: () => void) {
  screen = await render(
    <BridgetTaskJournal
      environmentId={environmentId}
      thread={thread}
      onOpenParent={onOpenParent ?? null}
      renderTimeline={(projection, _thread, result) =>
        result === null ? <CaptureJournal {...projection} /> : <div>{result}</div>
      }
    />,
    { router: false },
  );
  return screen;
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

const it = baseIt.extend<{ fixture: void }>({
  fixture: [
    async ({ task: _task }, use) => {
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
      cancelResult = {
        _tag: "Success",
        value: { version: 1, task_id: TASK_ID, status: "cancelling" },
      };
      visibilityState = "visible";
      using _visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockImplementation(() => visibilityState as DocumentVisibilityState);

      await use();
    },
    { auto: true },
  ],
});

describe("BridgetTaskJournal (web, session 149)", () => {
  it("présente les fragments exacts et les activités sans fabriquer un tour fournisseur", async () => {
    await using _screen1 = await mount(makeThread());
    await deliverJournal({
      events: [
        {
          ...journalEvent(1),
          event: "update",
          payload: { kind: "text", content: "workflow" },
        },
        {
          ...journalEvent(2),
          event: "update",
          payload: { kind: "text", content: " SpecKit" },
        },
        {
          ...journalEvent(3),
          event: "update",
          payload: { kind: "command", detail: "item/started", text: "pwd" },
        },
        {
          ...journalEvent(4),
          event: "update",
          payload: {
            kind: "command",
            detail: "item/completed",
            text: "pwd",
            item_id: "exec-1",
            exit_code: 0,
            state: "completed",
            status: "completed",
            output_tail: "workspace",
          },
        },
      ],
      nextSeq: 4,
      caughtUp: true,
      gap: null,
      gaps: [],
      continuityCut: null,
      conflicts: [],
      evicted: 0,
    });
    expect(text()).toContain("workflow SpecKit");
    expect(text()).toContain("Commande commencée · pwd");
    expect(text()).toContain("Commande terminée · pwd");
    expect(text()).not.toContain("assistant");
  });

  it("rend l’enveloppe complète et le témoin ts/v seulement après ouverture des détails", async () => {
    await using _screen2 = await mount(makeThread());
    const first = {
      ...journalEvent(11),
      session_id: "session-r5",
      message_id: "message-r5",
      payload: "preuve-r5",
    };
    const conflicting = {
      ...first,
      ts: "2026-10-10T10:06:11Z",
    };
    await deliverJournal({
      events: [first, conflicting],
      nextSeq: 11,
      caughtUp: true,
      gap: null,
      gaps: [],
      continuityCut: null,
      conflicts: [],
      evicted: 0,
    });
    expect(text()).toContain("Détails techniques");
    expect(text()).not.toContain('"ts": "2026-10-10T10:05:11Z"');
    expect(text()).not.toContain('"ts": "2026-10-10T10:06:11Z"');
    const technicalDetails = all("details", screen.container).find((node) =>
      all("summary", node).some((summary) =>
        (summary.textContent ?? "").includes("Détails techniques"),
      ),
    );
    expect(technicalDetails).toBeDefined();
    await act(async () => {
      const toggled = new Promise<void>((resolve) =>
        technicalDetails!.addEventListener("toggle", () => resolve(), { once: true }),
      );
      one("summary", technicalDetails).click();
      await toggled;
    });
    expect(text()).toContain("Conflit de rejeu #11");
    expect(text()).toContain('"v": 1');
    expect(text()).toContain('"ts": "2026-10-10T10:05:11Z"');
    expect(text()).toContain('"ts": "2026-10-10T10:06:11Z"');
    expect(text()).toContain('"session_id": "session-r5"');
    expect(text()).toContain('"message_id": "message-r5"');
    expect(text()).toContain('"payload": "preuve-r5"');
  });

  it("montre le chargement, déduplique par seq, trie, puis affiche gap et éviction", async () => {
    await using _screen3 = await mount(makeThread());
    expect(text()).toContain("Chargement du journal…");
    await deliverJournal({
      events: [journalEvent(47), journalEvent(43), journalEvent(43), journalEvent(42)],
      nextSeq: 47,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    expect(text()).not.toContain("Chargement du journal…");
    const seqs = all("*", screen.container)
      .filter((node) => node.hasAttribute("data-journal-seq"))
      .map((node) => Number(node.getAttribute("data-journal-seq")));
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
    await using _screen4 = await mount(makeThread({ task: { result_available: true } }));
    expect(button("Lire le résultat")).toBeTruthy();
    await act(async () => button("Lire le résultat")!.click());
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
    await act(async () => button("Suite du résultat")!.click());
    expect(pendingReads[1]!.input).toMatchObject({ action: "show", offset: 16384, limit: 16384 });
    await respond(isShow, detail("partie-deux", null));
    expect(text()).toContain("Partie une — 你好 🎉 é");
    expect(text()).toContain("partie-deux");
    expect(button("Suite du résultat")).toBeUndefined();
    // Refus fermé : message avec code, contenu déjà lu conservé.
    pendingReads.length = 0;
    await act(async () => button("Lire le début")!.click());
    await respond(isJournalRead, {
      _tag: "Failure",
      cause: Cause.fail(new BridgetLineageError({ code: "snapshot_changed" })),
    });
    expect(text()).toContain("Bridget indisponible (snapshot_changed)");
    expect(text()).toContain("partie-deux");
  });

  it("interrompt la souscription page masquée, avorte les lectures et reprend au dernier seq", async () => {
    await using _screen5 = await mount(makeThread());
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
    await act(async () => button("Lire le début")!.click());
    expect(pendingReads.length).toBe(1);
    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(activeJournals).toBe(0);
    expect(pendingReads[0]!.settled).toBe(true);
    // Retour au premier plan : une nouvelle souscription repart du dernier seq.
    await act(async () => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(activeJournals).toBe(1);
    expect(lastJournalTarget?.input.context).toMatchObject({ afterSeq: 8 });
  });

  it("conserve les lacunes et la coupe chargées après une nouvelle visite partielle", async () => {
    await using _screen6 = await mount(makeThread());
    const events = [
      { ...journalEvent(1), event: "update", payload: { kind: "text", content: "avant G1" } },
      { ...journalEvent(3), event: "update", payload: { kind: "text", content: "entre G1 et G2" } },
      { ...journalEvent(5), event: "update", payload: { kind: "text", content: "après G2" } },
    ];
    const g1 = { from_seq: 2, to_seq: 2, reason: "transport" } as const;
    const g2 = { from_seq: 4, to_seq: 4, reason: "transport" } as const;
    await deliverJournal({
      events,
      nextSeq: 5,
      caughtUp: true,
      gap: null,
      gaps: [g1, g2],
      continuityCut: { fromSeq: 4, toSeq: 4, reason: "gap-pressure" },
      conflicts: [],
      evicted: 0,
    });
    expect(
      all("*", screen.container)
        .filter((node) => node.hasAttribute("data-journal-seq"))
        .map((node) => Number(node.getAttribute("data-journal-seq"))),
    ).toEqual([1, 3, 5]);
    await act(async () => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(lastJournalTarget?.input.context).toMatchObject({ afterSeq: 5 });
    await deliverJournal({
      events: [],
      nextSeq: 5,
      caughtUp: true,
      gap: null,
      gaps: [g2],
      continuityCut: null,
      conflicts: [],
      evicted: 0,
    });
    expect(
      all("*", screen.container)
        .filter((node) => node.hasAttribute("data-journal-seq"))
        .map((node) => Number(node.getAttribute("data-journal-seq"))),
    ).toEqual([1, 3, 5]);
    expect(text()).toContain("Continuité du journal incertaine entre les séquences 4–4");
    await deliverJournal({
      events: [],
      nextSeq: 5,
      caughtUp: true,
      gap: null,
      gaps: [],
      continuityCut: null,
      conflicts: [],
      evicted: 0,
    });
    expect(
      all("*", screen.container)
        .filter((node) => node.hasAttribute("data-journal-seq"))
        .map((node) => Number(node.getAttribute("data-journal-seq"))),
    ).toEqual([1, 3, 5]);
    expect(text()).toContain("Continuité du journal incertaine entre les séquences 4–4");
    const empty = {
      events: [],
      caughtUp: true,
      gap: null,
      gaps: [],
      continuityCut: null,
      conflicts: [],
      evicted: 0,
    };
    for (const prefixMissing of [false, true]) {
      await act(async () => screen.unmount());

      await deliverJournal({ ...empty, nextSeq: 0 });
      await using _screen7 = await mount(makeThread());
      if (prefixMissing) {
        await deliverJournal({
          ...empty,
          nextSeq: 40,
          gap: { from_seq: 1, to_seq: 40, reason: "transport" },
        });
      }
      await deliverJournal({
        ...empty,
        nextSeq: 41,
        events: [
          {
            ...journalEvent(41),
            event: "update",
            payload: { kind: "text", content: "fragment 41" },
          },
        ],
      });
      expect(text()).toContain("fragment 41");
      expect(text().includes("Extrait :")).toBe(prefixMissing);
      await act(async () => {
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(lastJournalTarget?.input.context).toMatchObject({ afterSeq: 41 });
      await deliverJournal({ ...empty, nextSeq: 41 });
      expect(text()).toContain("fragment 41");
      expect(text().includes("Extrait :")).toBe(prefixMissing);
    }
  });

  it("garde le statut historique sans disponibilité feinte et conserve le journal en cas de panne", async () => {
    await using _screen8 = await mount(
      makeThread({
        lineage: { generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce", seq: 3, available: false },
      }),
    );
    expect(text()).toContain("Dernier état connu");
    expect(text()).not.toContain("En cours");
    // Non terminal + droit d'opérer, mais Bridget indisponible : arrêt fermé.
    expect(button("Arrêter")).toBeTruthy();
    expect(button("Arrêter")!.hasAttribute("disabled")).toBe(true);
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
    await using _screen9 = await mount(makeThread({ task: { status: "cancelled" } }));
    await deliverJournal({
      events: [journalEvent(7)],
      nextSeq: 7,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await act(async () => button("Lire le début")!.click());
    expect(pendingReads[0]!.input).toMatchObject({ action: "journal", afterSeq: 0 });
    // Lecture réelle refusée : seul le journal est en panne, pas le service Bridget.
    await respond(isJournalRead, {
      _tag: "Failure",
      cause: Cause.fail(new BridgetLineageError({ code: "journal_unavailable" })),
    });
    const statuses = all("*", screen.container)
      .filter((node) => node.getAttribute("role") === "status")
      .map((node) => node.textContent);
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
    await using _screen10 = await mount(makeThread(), onOpenParent);
    expect(one("section", screen.container).getAttribute("aria-label")).toBe(
      "Journal de la tâche Bridget",
    );
    expect(button("Ouvrir le parent")).toBeTruthy();
    await act(async () => button("Ouvrir le parent")!.click());
    expect(onOpenParent).toHaveBeenCalled();
    expect(one("section", screen.container).getAttribute("aria-label")).toBe(
      "Journal de la tâche Bridget",
    );
    await act(async () => button("Arrêter")!.click());
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
    await act(async () => button("Reconnecter")!.click());
    await act(async () => button("Arrêter")!.click());
    expect(text()).toContain("Bridget indisponible (command_failed)");
    // Chaque action d'arrêt génère un UUID frais (helper repo, jamais un identifiant figé).
    expect(cancelCalls.length).toBe(2);
    expect(UUID_RE.test(requestIdOf(cancelCalls[1]!))).toBe(true);
    expect(requestIdOf(cancelCalls[1]!)).not.toBe(requestIdOf(cancelCalls[0]!));
    // Tâche terminale : plus aucun bouton d'arrêt.
    await act(async () => screen.unmount());
    await using _screen11 = await mount(
      makeThread({ task: { status: "failed", error: "processus mort" } }),
    );
    expect(text()).toContain("processus mort");
    expect(button("Arrêter")).toBeUndefined();
    // Sans droit d'opérer : pas d'arrêt non plus.
    await act(async () => screen.unmount());
    canOperate = false;
    await using _screen12 = await mount(makeThread());
    expect(button("Arrêter")).toBeUndefined();
  });

  it("pagine l'historique du journal par 100 et revient au suivi live", async () => {
    await using _screen13 = await mount(makeThread());
    await deliverJournal({
      events: [journalEvent(7), journalEvent(8)],
      nextSeq: 8,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await act(async () => button("Lire le début")!.click());
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
    expect(button("Page suivante")!.hasAttribute("disabled")).toBe(false);
    await act(async () => button("Page suivante")!.click());
    expect(pendingReads[1]!.input).toMatchObject({ action: "journal", afterSeq: 100, limit: 100 });
    await respond(isJournalRead, history([], 150, true));
    expect(button("Page suivante")!.hasAttribute("disabled")).toBe(true);
    await act(async () => button("Retour au suivi")!.click());
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
    await using subscriptionScreen = await render(
      <BridgetLineageSubscription context={context} known={true} />,
      { router: false },
    );
    screen = subscriptionScreen;
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
    await act(async () => button("Reconnecter Bridget")!.click());
    // Le watch est recréé avec un nouveau visitId (nouvelle visite).
    expect(lastWatchTarget).not.toBe(previousWatchTarget);
    await act(async () => {
      watchValue = AsyncResult.success({ version: 1, seq: 1 });
      for (const listener of listeners) listener();
    });
    expect(text()).not.toContain("Lineage Bridget indisponible");
  });
});

describe("BridgetTaskJournal remote metadata (162)", () => {
  const placement = {
    machine_id: "cartae",
    display_name: "Serveur Cartae",
    worker_id: "worker-cartae",
    last_contact_at: 1790000010,
    contact_state: "connected",
  };

  it("actualise le contact distant sans confondre le worker avec le maître ni perdre le journal", async () => {
    await using _screen14 = await mount(
      makeThread({ task: { placement, agent_type: "claude_glm" } }),
    );
    expect(text()).toContain("Serveur Cartae (cartae)");
    expect(text()).toContain("claude_glm · test-model");
    expect(text()).toContain("Contact observé");
    expect(text()).toContain("Dernier contact observé :");
    expect(text()).toContain(new Date(1790000010 * 1000).toLocaleString("fr-FR"));
    await deliverJournal({
      events: [journalEvent(7)],
      nextSeq: 7,
      caughtUp: true,
      gap: null,
      evicted: 0,
    });
    await act(async () =>
      screen.rerender(
        <BridgetTaskJournal
          environmentId={environmentId}
          thread={makeThread({ task: { placement: { ...placement, contact_state: "stale" } } })}
          onOpenParent={null}
          renderTimeline={(projection, _thread, result) =>
            result === null ? <CaptureJournal {...projection} /> : <div>{result}</div>
          }
        />,
      ),
    );
    expect(text()).toContain("Contact perdu");
    expect(text()).toContain("En cours");
    expect(text()).not.toContain("Dernier état connu");
    expect(text()).toContain("ligne 7");
    expect(button("Arrêter")!.hasAttribute("disabled")).toBe(false);
    await deliverJournalFailure("journal_unavailable");
    expect(text()).toContain("Journal de la tâche indisponible");
    expect(text()).not.toContain("Bridget indisponible");
    expect(text()).toContain("ligne 7");
    expect(cancelCalls).toEqual([]);
    expect(pendingReads).toEqual([]);
    expect(activeJournals).toBe(1);
  });

  it("distingue les métadonnées v1 absentes, le placement v2 nul et le contact inconnu", async () => {
    await using _screen15 = await mount(makeThread());
    expect(text()).toContain("Métadonnées distantes indisponibles");
    expect(text()).not.toContain("Exécution locale");
    await act(async () =>
      screen.rerender(
        <BridgetTaskJournal
          environmentId={environmentId}
          thread={makeThread({ task: { placement: null } })}
          onOpenParent={null}
          renderTimeline={(projection, _thread, result) =>
            result === null ? <CaptureJournal {...projection} /> : <div>{result}</div>
          }
        />,
      ),
    );
    expect(text()).toContain("Aucun placement distant");
    expect(text()).not.toContain("Métadonnées distantes indisponibles");
    await act(async () =>
      screen.rerender(
        <BridgetTaskJournal
          environmentId={environmentId}
          thread={makeThread({
            task: {
              placement: {
                ...placement,
                display_name: null,
                last_contact_at: null,
                contact_state: "unknown",
              },
            },
          })}
          onOpenParent={null}
          renderTimeline={(projection, _thread, result) =>
            result === null ? <CaptureJournal {...projection} /> : <div>{result}</div>
          }
        />,
      ),
    );
    expect(text()).toContain("cartae");
    expect(text()).toContain("Contact inconnu");
    expect(text()).toContain("Date du contact inconnue");
    expect(text()).not.toContain("Contact observé");
    expect(pendingReads).toEqual([]);
  });
});

vi.mock("~/lib/observeResize", () => ({
  observeResize: (
    element: Element,
    callback: (entries: readonly ResizeObserverEntry[]) => void,
  ) => {
    if (typeof ResizeObserver === "undefined") return () => undefined;
    const observer = new ResizeObserver((entries) => callback(entries));
    observer.observe(element);
    return () => observer.disconnect();
  },
}));
