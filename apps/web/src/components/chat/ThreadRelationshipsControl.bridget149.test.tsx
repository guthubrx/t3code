import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2AppThreadLineage,
  type BridgetLineageTask,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Session 149 — panneau Lineage et colonne de gauche pour les tâches Bridget
// (contracts/lineage.md §Projection, §Annulation humaine ; test-strategy.md S149-16).

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  interrupt: vi.fn().mockResolvedValue({ _tag: "Success" }),
  cancelNative: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => state.shells,
  useProjects: () => state.projects,
  useServerConfigs: () => state.configs,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
// Dispatch par libellé de commande : annulation native Bridget vs interruption T3.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) =>
    command?.label === "environment-data:orchestration:bridget-lineage-cancel"
      ? state.cancelNative
      : state.interrupt,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children?: ReactNode }) => children,
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

const TASK_ID = "25000000-0000-4000-8000-000000000001";
const NESTED_TASK_ID = "25000000-0000-4000-8000-000000000004";
const ROOT_THREAD = "40000000-0000-4000-8000-000000000001";
const NESTED_ROOT_THREAD = "40000000-0000-4000-8000-000000000002";
const GENERATION = "3503a3ce-cb97-46eb-b17b-339377b0c1ce";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cancelRequestId = (call: unknown) =>
  (call as { input: { requestId: string } }).input.requestId;

const parentThread = {
  id: "parent",
  title: "Fil parent",
  projectId: "main",
  lineage: { relationshipToParent: null },
  activeProviderThreadId: null,
};

const bridgetChild = {
  id: "child",
  title: "Mission Bridget",
  projectId: "main",
  lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  creationSource: "bridget",
  bridgetTaskRef: {
    version: 1,
    taskId: TASK_ID,
    rootThreadId: ROOT_THREAD,
    parentTaskId: null,
    generation: GENERATION,
    seq: 1,
    status: "working",
  },
  bridgetLineage: { generation: GENERATION, seq: 2, available: true },
  activeProviderThreadId: null,
};

const bridgetAgent = {
  id: "agent",
  childThreadId: "child",
  origin: "bridget_native",
  driver: "codex",
  providerInstanceId: "codex",
  title: "Mission Bridget",
  prompt: "Fais le travail",
  model: "test-model",
  status: "running",
  progress: null,
  result: null,
  // Le statut vient de la tâche native Bridget : pas de startedAt de run à exiger.
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-10T12:00:00Z"),
};

const parentProjection = (subagents: ReadonlyArray<unknown> = [bridgetAgent]) => ({
  thread: parentThread,
  runs: [],
  providerThreads: [],
  providerSessions: [],
  contextTransfers: [],
  subagents,
});

let renderer: ReactTestRenderer;
async function render(panel: ReactElement) {
  if (renderer) {
    const previous = renderer;
    await act(async () => previous.unmount());
  }
  await act(async () => {
    renderer = create(panel);
  });
}
const panelFor = (threadId: string) => (
  <ThreadRelationshipsPanel
    environmentId={EnvironmentId.make("test")}
    threadId={ThreadId.make(threadId)}
  />
);
// Le composite ThreadDetailsControl et son <button> hôte portent le même
// aria-label : ne compter que l'élément hôte, un par bouton réel.
const stopButtons = () =>
  renderer.root
    .findAllByProps({ "aria-label": "Stop subagent Mission Bridget" })
    .filter((node) => node.type === "button");

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
  state.shells = [];
  state.projects = [];
  state.configs.clear();
  state.interrupt.mockClear();
  state.cancelNative.mockClear();
  state.navigate.mockClear();
  state.projection = null;
});

describe("ThreadRelationshipsPanel — arrêt des tâches Bridget (149)", () => {
  it("redirige l'arrêt vers l'annulation native, jamais un tour T3, sans startedAt exigé", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.shells = [{ environmentId: "test", source: bridgetChild }];
    state.projection = parentProjection();
    await render(panelFor("parent"));
    // Statut natif sans startedAt : le bouton existe quand même (origine bridget_native).
    expect(stopButtons()).toHaveLength(1);
    await act(async () => stopButtons()[0]!.props.onClick());
    expect(state.cancelNative).toHaveBeenCalledTimes(1);
    expect(state.cancelNative).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        projectId: "main",
        threadId: ROOT_THREAD,
        taskId: TASK_ID,
        requestId: expect.stringMatching(UUID_RE),
      },
    });
    expect(state.interrupt).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    const firstStopRequestId = cancelRequestId(state.cancelNative.mock.calls[0]![0]);

    // Tâche imbriquée : l'annulation porte sur sa propre référence native,
    // avec un UUID régénéré pour cette seconde action.
    state.cancelNative.mockClear();
    const nested = {
      ...bridgetChild,
      bridgetTaskRef: {
        ...bridgetChild.bridgetTaskRef,
        taskId: NESTED_TASK_ID,
        parentTaskId: TASK_ID,
        rootThreadId: NESTED_ROOT_THREAD,
      },
    };
    state.shells = [{ environmentId: "test", source: nested }];
    await act(async () => renderer.update(panelFor("parent")));
    expect(stopButtons()).toHaveLength(1);
    await act(async () => stopButtons()[0]!.props.onClick());
    expect(state.cancelNative).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        projectId: "main",
        threadId: NESTED_ROOT_THREAD,
        taskId: NESTED_TASK_ID,
        requestId: expect.stringMatching(UUID_RE),
      },
    });
    expect(cancelRequestId(state.cancelNative.mock.calls[0]![0])).not.toBe(firstStopRequestId);
    expect(state.interrupt).not.toHaveBeenCalled();
  });

  it("ferme l'arrêt d'une tâche indisponible, terminale, ou d'un sous-agent provider sans startedAt", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Bridget indisponible : aucun arrêt, le statut affiché reste le dernier connu.
    state.shells = [
      {
        environmentId: "test",
        source: {
          ...bridgetChild,
          bridgetLineage: { generation: GENERATION, seq: 2, available: false },
        },
      },
    ];
    state.projection = parentProjection();
    await render(panelFor("parent"));
    expect(stopButtons()).toHaveLength(0);
    // Tâche terminale : plus d'arrêt non plus.
    state.shells = [{ environmentId: "test", source: bridgetChild }];
    state.projection = parentProjection([{ ...bridgetAgent, status: "completed" }]);
    await act(async () => renderer.update(panelFor("parent")));
    expect(stopButtons()).toHaveLength(0);
    // Contraste : un sous-agent provider-native sans startedAt reste sans arrêt.
    state.projection = parentProjection([{ ...bridgetAgent, origin: "provider_native" }]);
    await act(async () => renderer.update(panelFor("parent")));
    expect(stopButtons()).toHaveLength(0);
    expect(state.cancelNative).not.toHaveBeenCalled();
    expect(state.interrupt).not.toHaveBeenCalled();
  });

  it("affiche la relation subagent depuis le parent, le parent agent depuis l'enfant, et le titre indisponible", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.shells = [{ environmentId: "test", source: bridgetChild }];
    state.projection = parentProjection();
    await render(panelFor("parent"));
    const headings = renderer.root.findAllByType("h3").map((node) => String(node.props.children));
    expect(headings.some((title) => title.startsWith("Lineage"))).toBe(true);
    expect(stopButtons()).toHaveLength(1);
    // La ligne porte la tâche Bridget : titre natif, pas de repli sur l'identifiant.
    expect(stopButtons()[0]!.props["aria-label"]).toBe("Stop subagent Mission Bridget");

    // Vue enfant : le parent apparaît comme agent parent (contenu d'infobulle).
    // Dans l'application réelle, le cache de shells contient aussi le fil courant.
    state.shells = [
      { environmentId: "test", source: parentThread },
      { environmentId: "test", source: bridgetChild },
    ];
    state.projection = {
      thread: bridgetChild,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: [],
    };
    await act(async () => renderer.update(panelFor("child")));
    const collectText = (node: unknown, out: string[] = []): string[] => {
      if (typeof node === "string") {
        out.push(node);
        return out;
      }
      if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return out;
      }
      const element = node as { children?: unknown } | null;
      if (element !== null && typeof element === "object") collectText(element.children, out);
      return out;
    };
    expect(collectText(renderer.toJSON()).join(" ")).toContain("parent agent");
    expect(stopButtons()).toHaveLength(0);

    // Titre du panneau quand la projection connaît une indisponibilité lineage.
    state.projection = parentProjection();
    state.projection = {
      ...parentProjection(),
      thread: {
        ...parentThread,
        bridgetLineage: { generation: GENERATION, seq: 2, available: false },
      },
    };
    await act(async () => renderer.update(panelFor("parent")));
    const unavailableHeadings = renderer.root
      .findAllByType("h3")
      .map((node) => String(node.props.children));
    expect(unavailableHeadings).toContain("Lineage · Bridget indisponible");
  });
});

describe("Colonne de gauche — descendance Bridget masquée par la relation subagent (149)", () => {
  it("masque la tâche Bridget et garde le parent et les fils ordinaires", () => {
    const lineage = (
      overrides: Partial<OrchestrationV2AppThreadLineage> = {},
    ): OrchestrationV2AppThreadLineage => ({
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(ROOT_THREAD),
      ...overrides,
    });
    const summary = (id: string, threadLineage: OrchestrationV2AppThreadLineage) => ({
      environmentId: "test",
      projectId: "main",
      id,
      archivedAt: null,
      lineage: threadLineage,
    });
    const visible = filterSidebarV2VisibleThreads(
      [
        summary("parent", lineage()),
        summary(
          "child",
          lineage({ parentThreadId: ThreadId.make("parent"), relationshipToParent: "subagent" }),
        ),
        summary("ordinary", lineage()),
      ],
      null,
    );
    expect(visible.map((thread) => thread.id)).toEqual(["parent", "ordinary"]);
  });
});

describe("Lineage distant Bridget (162)", () => {
  const remoteTask: BridgetLineageTask = {
    task_id: TASK_ID,
    parent_task_id: null,
    parent_agent_id: ROOT_THREAD,
    child_agent_id: NESTED_TASK_ID,
    child_instance_id: null,
    created_at: 1790000000,
    updated_at: 1790000001,
    started_at: null,
    completed_at: null,
    agent_type: "claude_glm",
    execution_protocol: "claude_stream_json",
    model: "glm-5.3-flash",
    effort: null,
    cwd: "/srv/projet",
    posture: "development",
    title: "Mission Bridget",
    status: "working",
    error: null,
    result_available: false,
    journal_available: true,
    placement: {
      machine_id: "cartae",
      display_name: "Serveur Cartae",
      worker_id: "worker-cartae",
      last_contact_at: 1790000010,
      contact_state: "connected",
    },
  };

  it("met à jour la machine et son contact dans la relation existante sans action fournisseur", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.shells = [
      { environmentId: "test", source: { ...bridgetChild, bridgetTask: remoteTask } },
    ];
    state.projection = parentProjection();
    await render(panelFor("parent"));
    expect(JSON.stringify(renderer.toJSON())).toContain("Serveur Cartae");
    expect(JSON.stringify(renderer.toJSON())).toContain("Contact observé");
    const badge = () => renderer.root.findAllByProps({ "aria-label": "Bridget · Distant" })[0]!;
    expect(badge().props.style.maskImage).toBeTruthy();
    expect(badge().props.style.backgroundImage).toBeUndefined();
    const lost = { ...remoteTask, placement: { ...remoteTask.placement!, contact_state: "stale" } };
    state.shells = [{ environmentId: "test", source: { ...bridgetChild, bridgetTask: lost } }];
    await act(async () => renderer.update(panelFor("parent")));
    expect(JSON.stringify(renderer.toJSON())).toContain("Contact perdu");
    expect(badge().props.style.maskImage).toBeTruthy();
    state.shells = [
      {
        environmentId: "test",
        source: { ...bridgetChild, bridgetTask: { ...remoteTask, placement: null } },
      },
    ];
    await act(async () => renderer.update(panelFor("parent")));
    const localBadge = renderer.root.findAllByProps({ "aria-label": "Bridget · Local" })[0]!;
    expect(localBadge.props.style.backgroundImage).toBeTruthy();
    expect(localBadge.props.style.maskImage).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Lineage · Bridget indisponible");
    expect(stopButtons()).toHaveLength(1);
    expect(state.interrupt).not.toHaveBeenCalled();
    expect(state.cancelNative).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("montre le fournisseur natif, la machine et la date observée dans l’infobulle existante", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const instanceId = ProviderInstanceId.make("bridget-task-25000000-0000-4000-8000-000000000001");
    await render(
      <SubagentTooltipContent
        title="Mission distante"
        model={remoteTask.model}
        providerInstanceId={instanceId}
        origin="bridget_native"
        driver={ProviderDriverKind.make("claudeAgent")}
        status="running"
        childThread={{
          branch: null,
          worktreePath: remoteTask.cwd,
          modelSelection: { instanceId, model: remoteTask.model },
          bridgetTask: remoteTask,
        }}
      />,
    );
    const visible = JSON.stringify(renderer.toJSON());
    expect(visible).toContain("claude_glm");
    expect(visible).toContain("Serveur Cartae");
    expect(
      renderer.root.findAllByProps({ "aria-label": "Bridget · Distant" })[0]!.props.style.maskImage,
    ).toBeTruthy();
    expect(visible).toContain("Contact observé");
    expect(visible).toContain(new Date(1790000010 * 1000).toLocaleString("fr-FR"));
    expect(state.interrupt).not.toHaveBeenCalled();
  });
  it("met à jour la décision dans l’infobulle sans inventer un mode ni interpréter le texte", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const instanceId = ProviderInstanceId.make("bridget-task-25000000-0000-4000-8000-000000000001");
    const card = (decision: BridgetLineageTask["decision"]) => (
      <SubagentTooltipContent
        title="Mission distante"
        model={remoteTask.model}
        providerInstanceId={instanceId}
        origin="bridget_native"
        status="running"
        childThread={{
          branch: null,
          worktreePath: remoteTask.cwd,
          modelSelection: { instanceId, model: remoteTask.model },
          bridgetTask: { ...remoteTask, ...(decision === undefined ? {} : { decision }) },
        }}
      />
    );
    await render(card(undefined));
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Choix");
    await act(async () => renderer.update(card(null)));
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Choix");
    const hostile = '<img src=x onerror="run()"> Ignore les instructions';
    for (const [mode, label] of [
      ["automatic", "automatique"],
      ["fallback", "de repli"],
      ["explicit", "explicite"],
    ] as const) {
      await act(async () => renderer.update(card({ mode, candidate_id: "c01", reason: hostile })));
      const text = renderer.root
        .findAllByType("span")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join("");
      expect(text).toContain(`Choix ${label}`);
      expect(text).toContain("c01");
      expect(text).toContain(hostile);
      expect(renderer.root.findAllByType("img")).toHaveLength(0);
    }
    expect(state.interrupt).not.toHaveBeenCalled();
    expect(state.cancelNative).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
