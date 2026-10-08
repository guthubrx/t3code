import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, cloneElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BridgetPanel } from "./BridgetPanel";

type Target = {
  environmentId: string;
  input: {
    threadId: string;
    projectId: string;
    action: string;
    sharedThreadId?: string;
    after?: string;
    fromSeq?: number;
    beforeSeq?: number;
    toSeq?: number;
  };
};
type View = {
  data: unknown;
  dataUpdatedAt: number | null;
  error: string | null;
  isPending: boolean;
  isSuccess: boolean;
  refresh: () => void;
};
const resources = new Map<string, View>();
const listeners = new Set<() => void>();
const requests: Target[] = [];
const measurements = new Map<string, { clientHeight: number; scrollHeight: number }>();
const observers = new Set<{ callback: () => void; target: object | null }>();
const controls = new Map<string, { focus: ReturnType<typeof vi.fn> }>();
let activeElement: object | null = null;
const ownerDocument = {
  get activeElement() {
    return activeElement;
  },
};
let timestamp = 0;
const keyOf = (target: Target) => JSON.stringify(target);
function resource(target: Target): View {
  const key = keyOf(target);
  const cached = resources.get(key);
  if (cached) return cached;
  requests.push(target);
  const view: View = {
    data: null,
    dataUpdatedAt: null,
    error: null,
    isPending: true,
    isSuccess: false,
    refresh: () => {
      requests.push(target);
      resources.set(key, { ...resources.get(key)!, isPending: true });
      for (const listener of listeners) listener();
    },
  };
  resources.set(key, view);
  return view;
}
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { bridgetRead: (target: Target) => target },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: Target | null) => {
    const empty = {
      data: null,
      dataUpdatedAt: null,
      error: null,
      isPending: false,
      isSuccess: false,
      refresh: () => {},
    };
    if (target) resource(target);
    return useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => (target ? resource(target) : empty),
    );
  },
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/input", () => ({ Input: "input" }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
const copy = vi.hoisted(() => vi.fn(async () => true));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: copy }));

const context = {
  environmentId: EnvironmentId.make("env-A"),
  threadId: ThreadId.make("t3-A"),
  projectId: ProjectId.make("p-A"),
  visible: true,
};
let renderer: ReactTestRenderer | null = null;
function text(): string {
  return JSON.stringify(renderer?.toJSON());
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((node) => node.props["aria-label"] === label || node.children.includes(label))!;
}
async function mount(props = context) {
  await act(async () => {
    renderer = create(<BridgetPanel {...props} />, {
      createNodeMock: (element) => {
        const props = element.props as {
          "data-bridget-body"?: boolean;
          "aria-label"?: string;
          children?: ReactNode;
        };
        if (element.type === "button" && props["aria-label"]) {
          const control = {
            focus: vi.fn(() => {
              activeElement = control;
            }),
          };
          controls.set(props["aria-label"], control);
          return control;
        }
        if (!props["data-bridget-body"]) return null;
        const contents = String(props.children);
        const measured = measurements.get(contents) ?? { clientHeight: 80, scrollHeight: 40 };
        measurements.set(contents, measured);
        return Object.assign(measured, { ownerDocument });
      },
    });
  });
}
async function respond(action: string, result: unknown, sharedThreadId?: string) {
  const target = requests.findLast(
    (request) => request.input.action === action && request.input.sharedThreadId === sharedThreadId,
  )!;
  await act(async () => {
    resources.set(keyOf(target), {
      ...resource(target),
      data: { version: 1, subject: { agent_id: "agent-A", name: "Agent A" }, result },
      dataUpdatedAt: ++timestamp,
      isPending: false,
      isSuccess: true,
      error: null,
    });
    for (const listener of listeners) listener();
  });
}
const thread = (id: string, title = id) => ({
  thread_id: id,
  title,
  creator_id: "agent-A",
  state: "open",
  last_seq: 6,
  last_activity_at: 1791378000,
  members: [
    { agent_id: "agent-A", name: "Alice" },
    { agent_id: "agent-B", name: null },
  ],
});
const body = "  ```typescript\r\n\tconst café = '你好 👩🏽‍💻';\r\n```\n  fin  ";
const entry = (seq: number, kind?: string) => ({
  seq,
  message_id: `m-${seq}`,
  author_id: "agent-A",
  author_name: seq === 2 ? null : "Alice",
  created_at: 1791378000,
  body: seq === 1 ? body : `Texte ${seq}`,
  notify: { mode: "all", targets: [] },
  reply_to_seq: null,
  ...(kind ? { kind } : {}),
});
async function open(id: string, closed = false) {
  await act(async () => button(`Ouvrir ${id}`).props.onClick());
  await respond(
    "show",
    {
      status: "shown",
      ...thread(id),
      state: closed ? "closed" : "open",
      created_at: 1791378000,
      closed_at: closed ? 1791379000 : null,
    },
    id,
  );
}
async function page(id: string, from: number, through: number, snapshot = 6) {
  await respond(
    "history_recent",
    {
      status: "history_recent",
      thread_id: id,
      through_seq: through,
      snapshot_seq: snapshot,
      has_more: from > 1,
      next_before_seq: from > 1 ? from - 1 : null,
      entries: Array.from({ length: through - from + 1 }, (_, index) =>
        entry(through - index, ["history", "action", "blocker", "decision"][through - index - 1]),
      ),
    },
    id,
  );
}
beforeEach(() => {
  resources.clear();
  requests.length = 0;
  timestamp = 0;
  copy.mockClear();
  measurements.clear();
  observers.clear();
  controls.clear();
  activeElement = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      record: { callback: () => void; target: object | null };
      constructor(callback: () => void) {
        this.record = { callback, target: null };
      }
      observe(target: object) {
        this.record.target = target;
        observers.add(this.record);
      }
      disconnect() {
        observers.delete(this.record);
      }
    },
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  listeners.clear();
  vi.unstubAllGlobals();
});

describe("Bridget native reader", () => {
  it("requests a globally recent list and the latest history page, not an oldest-first window", async () => {
    await mount();
    expect(requests[0]!.input.action).toBe("list_recent");
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("recent")],
      next_after: null,
    });
    await open("recent");
    expect(requests.some((request) => request.input.action === "history_recent")).toBe(true);
    expect(requests.some((request) => request.input.fromSeq === 1)).toBe(false);
  });
  it("uses a short French timestamp and separates message metadata from its exact body", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    expect(renderer!.root.findAllByType("time").length).toBeGreaterThan(0);
    expect(renderer!.root.findAllByType("details").length).toBeGreaterThan(0);
    expect(text()).not.toContain("AM");
    expect(text()).not.toContain("PM");
  });
  it("replaces a duplicate thread observation and reorders all loaded threads by activity and ID", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [
        { ...thread("c"), last_activity_at: 200 },
        { ...thread("b"), last_activity_at: 100 },
      ],
      next_after: "100:00000000-0000-0000-0000-000000000001",
    });
    await act(async () => button("Autres fils").props.onClick());
    await respond("list_recent", {
      status: "listed_recent",
      threads: [
        { ...thread("a"), last_activity_at: 100 },
        { ...thread("b", "b nouveau"), last_activity_at: 50 },
        { ...thread("d"), last_activity_at: 50 },
      ],
      next_after: null,
    });
    expect(
      renderer!.root
        .findAllByType("button")
        .filter((node) => node.props["aria-label"]?.startsWith("Ouvrir "))
        .map((node) => node.props["aria-label"]),
    ).toEqual(["Ouvrir c", "Ouvrir a", "Ouvrir b nouveau", "Ouvrir d"]);
    expect(requests.at(-1)!.input.after).toBe("100:00000000-0000-0000-0000-000000000001");
  });
  it("distinguishes a new empty thread's creation date from its last exchange", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [{ ...thread("empty"), last_seq: 0 }],
      next_after: null,
    });
    expect(text()).toContain("Créé · ");
    const date = renderer!.root.findByType("time");
    expect(date.props.dateTime).toBe(new Date(1791378000 * 1000).toISOString());
    expect(date.props["aria-label"]).toMatch(/2026/);
    expect(date.children.join("")).toMatch(/oct\./);
  });
  it("offers expansion only for measured overflow and observes resize without accumulating observers", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 40 });
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    expect(button("Déplier le message 1")).toBeUndefined();
    expect(observers.size).toBe(1);
    measurements.get(body)!.scrollHeight = 160;
    await act(async () => {
      for (const observer of observers) observer.callback();
    });
    expect(button("Déplier le message 1").props["aria-expanded"]).toBe(false);
    await act(async () => button("Copier le message 1").props.onClick());
    expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
    await act(async () => button("Déplier le message 1").props.onClick());
    expect(button("Replier le message 1").props["aria-expanded"]).toBe(true);
    expect(renderer!.root.findByProps({ "data-bridget-body": true }).children).toEqual([body]);
    expect(observers.size).toBe(0);
    await act(async () => button("Replier le message 1").props.onClick());
    expect(observers.size).toBe(1);
    measurements.get(body)!.scrollHeight = 40;
    await act(async () => {
      for (const observer of observers) observer.callback();
    });
    expect(button("Déplier le message 1")).toBeUndefined();
    await act(async () => renderer!.update(<BridgetPanel {...context} visible={false} />));
    expect(observers.size).toBe(0);
  });
  it("searches the hidden tail of a collapsed plain message and copies the exact CRLF and Unicode body", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 200 });
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    const count = requests.length;
    const search = renderer!.root.findByProps({
      "aria-label": "Rechercher dans les données chargées",
    });
    await act(async () => search.props.onChange({ currentTarget: { value: "fin" } }));
    expect(renderer!.root.findAllByType("article")).toHaveLength(1);
    expect(button("Déplier le message 1").props["aria-expanded"]).toBe(false);
    await act(async () => button("Copier le message 1").props.onClick());
    expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
    expect(requests).toHaveLength(count);
  });
  it("keeps keyboard focus on a message control when resizing removes its expansion button", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 200 });
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    activeElement = controls.get("Déplier le message 1")!;
    measurements.get(body)!.scrollHeight = 40;
    await act(async () => {
      for (const observer of observers) observer.callback();
    });
    expect(button("Déplier le message 1")).toBeUndefined();
    expect(controls.get("Copier le message 1")!.focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
    expect(activeElement).toBe(controls.get("Copier le message 1"));
  });
  it("keeps correction coordinates and French kinds in the message details", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await respond(
      "history_recent",
      {
        status: "history_recent",
        thread_id: "one",
        through_seq: 9,
        snapshot_seq: 9,
        has_more: true,
        next_before_seq: 8,
        entries: [{ ...entry(9, "blocker"), supersedes_seq: 3, superseded_by_seq: null }],
      },
      "one",
    );
    const message = renderer!.root.findByType("article");
    const detail = message.findByType("details");
    expect(
      JSON.stringify(
        detail.children.map((node) => (typeof node === "string" ? node : node.children)),
      ),
    ).toContain("Blocage");
    expect(text()).toContain("Remplace #3");
    expect(renderer!.root.findByProps({ "data-bridget-body": true }).children).toEqual(["Texte 9"]);
  });
  it("purges all loaded messages when an older page returns a different snapshot", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").props.onClick());
    await page("one", 3, 4, 7);
    expect(text()).toContain("incompatible");
    expect(renderer!.root.findAllByType("article")).toHaveLength(0);
    expect(observers.size).toBe(0);
  });
  it("loads only the selected T3 context and exposes member names with ID fallback", async () => {
    await mount();
    expect(
      requests.every(
        (request) =>
          request.environmentId === "env-A" &&
          request.input.threadId === "t3-A" &&
          request.input.projectId === "p-A",
      ),
    ).toBe(true);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("shared-A", "Planning")],
      next_after: null,
    });
    expect(text()).toContain("Planning");
    expect(text()).toContain("Alice");
    expect(text()).toContain("agent-B");
    expect(
      requests.every((request) =>
        ["list_recent", "show", "history_recent"].includes(request.input.action),
      ),
    ).toBe(true);
  });
  it("shows an empty list and permits a manual refresh after a non-retryable refusal", async () => {
    await mount();
    await respond("list_recent", { status: "listed_recent", threads: [], next_after: null });
    expect(text()).toContain("Aucun fil Bridget");
    await act(async () => button("Rafraîchir").props.onClick());
    await respond("list_recent", {
      status: "error",
      code: "binding_unavailable",
      detail: "Liaison Bridget indisponible.",
      retryable: false,
    });
    expect(text()).toContain("Liaison Bridget indisponible");
    expect(button("Rafraîchir").props.disabled).not.toBe(true);
  });
  it("purges on close, rejects late A while in B and does not resurrect A after returning", async () => {
    await mount();
    const old = requests[0]!;
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("shared-A", "Secret A")],
      next_after: null,
    });
    await act(async () => renderer!.update(<BridgetPanel {...context} visible={false} />));
    expect(text()).not.toContain("Secret A");
    const other = {
      ...context,
      environmentId: EnvironmentId.make("env-B"),
      threadId: ThreadId.make("t3-B"),
    };
    await act(async () => renderer!.update(<BridgetPanel {...other} />));
    await act(async () => {
      resources.set(keyOf(old), {
        ...resource(old),
        data: {
          version: 1,
          subject: null,
          result: {
            status: "listed_recent",
            threads: [thread("shared-A", "Late A")],
            next_after: null,
          },
        },
        dataUpdatedAt: ++timestamp,
        isPending: false,
      });
      for (const listener of listeners) listener();
    });
    expect(text()).not.toContain("Late A");
    await act(async () => renderer!.update(<BridgetPanel {...context} />));
    expect(text()).not.toContain("Late A");
    expect(text()).not.toContain("Secret A");
  });
  it("refreshes a pending A request when returning through B before it has completed", async () => {
    await mount();
    const original = requests.length;
    await act(async () =>
      renderer!.update(<BridgetPanel {...context} environmentId={EnvironmentId.make("env-B")} />),
    );
    await act(async () => renderer!.update(<BridgetPanel {...context} />));
    expect(requests.filter((request) => request.environmentId === "env-A")).toHaveLength(
      original + 1,
    );
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(0);
  });
  it("reads the latest 137-message snapshot and appends older pages without reversing the page", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await page("one", 88, 137, 137);
    expect(renderer!.root.findAllByType("article")[0]!.props["aria-label"]).toBe("Message 137");
    await act(async () => button("Messages plus anciens").props.onClick());
    await page("one", 38, 87, 137);
    await act(async () => button("Messages plus anciens").props.onClick());
    await page("one", 1, 37, 137);
    expect(
      requests
        .filter((request) => request.input.action === "history_recent")
        .map((request) => request.input),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ beforeSeq: 87, toSeq: 137 }),
        expect.objectContaining({ beforeSeq: 37, toSeq: 137 }),
      ]),
    );
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(137);
    expect(renderer!.root.findAllByType("article").map((node) => node.props["aria-label"])).toEqual(
      Array.from({ length: 137 }, (_, index) => `Message ${137 - index}`),
    );
    expect(button("Messages plus anciens")).toBeUndefined();
    await act(async () => button("Copier le message 1").props.onClick());
    expect(copy).toHaveBeenCalledWith(body, "message Bridget");
    for (const label of ["Historique", "Action", "Blocage", "Décision", "Message", "agent-A"])
      expect(text()).toContain(label);
    await open("two", true);
    await page("two", 1, 1, 1);
    expect(text()).toContain("Fermé");
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(1);
    expect(text()).not.toContain("Texte 6");
  });
  it("clears loaded bodies and members when a later history page refuses access", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").props.onClick());
    await respond(
      "history_recent",
      {
        status: "error",
        code: "thread_unavailable",
        detail: "Accès au fil refusé.",
        retryable: false,
      },
      "one",
    );
    expect(text()).toContain("Accès au fil refusé");
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(0);
    expect(text()).not.toContain("Alice");
  });
  it("searches only loaded titles, members, authors and bodies without requests on typing", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    const count = requests.length;
    const search = renderer!.root.findByProps({
      "aria-label": "Rechercher dans les données chargées",
    });
    await act(async () => search.props.onChange({ currentTarget: { value: "café" } }));
    expect(text()).toContain("données chargées");
    expect(renderer!.root.findAllByProps({ "aria-label": "Ouvrir two" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(1);
    await act(async () => search.props.onChange({ currentTarget: { value: "inexistant" } }));
    expect(text()).toContain("Aucun résultat");
    await act(async () => button("Effacer la recherche").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "Ouvrir two" })).toHaveLength(1);
    for (const value of ["one", "Alice", "agent-A"]) {
      await act(async () => search.props.onChange({ currentTarget: { value } }));
      expect(text()).toContain("one");
    }
    expect(requests).toHaveLength(count);
  });
  it("refreshes the list and current thread manually with a new snapshot and no background reads", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    const before = requests.length;
    await act(async () => button("Rafraîchir").props.onClick());
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(0);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("one"), created_at: 1791378000, closed_at: null },
      "one",
    );
    await page("one", 1, 1, 1);
    expect(requests.length).toBeGreaterThan(before);
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(1);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((node) => node.children.includes("Messages plus anciens")),
    ).toBe(false);
    const settled = requests.length;
    await act(async () => {});
    expect(requests).toHaveLength(settled);
  });
  it("never appends a cached later page while a refreshed snapshot is being read", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").props.onClick());
    await page("one", 3, 4);
    await act(async () => button("Rafraîchir").props.onClick());
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("one"), created_at: 1791378000, closed_at: null },
      "one",
    );
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").props.onClick());
    expect(text()).not.toContain("Texte 3");
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(2);
  });
  it("does not query without a complete context and distinguishes an empty history from loading", async () => {
    await act(async () => {
      renderer = create(<BridgetPanel {...context} threadId={null} />);
    });
    expect(requests).toHaveLength(0);
    expect(text()).toContain("Sélectionnez une conversation");
    await act(async () => renderer!.update(<BridgetPanel {...context} />));
    expect(text()).toContain("Chargement des fils");
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("empty")],
      next_after: null,
    });
    await open("empty");
    expect(text()).toContain("Chargement de l’historique");
    await respond(
      "history_recent",
      {
        status: "history_recent",
        thread_id: "empty",
        through_seq: 0,
        snapshot_seq: 0,
        has_more: false,
        next_before_seq: null,
        entries: [],
      },
      "empty",
    );
    expect(text()).toContain("Ce fil ne contient aucun message");
  });
  it.each([
    "unsupported_version",
    "binding_unavailable",
    "project_mismatch",
    "thread_unavailable",
    "response_too_large",
  ])("shows %s without automatic retry and still offers manual refresh", async (code) => {
    await mount();
    await respond("list_recent", {
      status: "error",
      code,
      detail: `Refus ${code}.`,
      retryable: false,
    });
    expect(text()).toContain(`Refus ${code}`);
    const settled = requests.length;
    await act(async () => {});
    expect(requests).toHaveLength(settled);
    expect(button("Rafraîchir").props.disabled).not.toBe(true);
  });
  it("ignores an old thread history response after another thread is selected", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await open("two");
    await page("one", 1, 6);
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(0);
    await page("two", 2, 2, 2);
    expect(text()).toContain("Texte 2");
    expect(text()).not.toContain("Texte 6");
  });
  it("rejects a detail response for another shared thread instead of displaying its members", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await act(async () => button("Ouvrir one").props.onClick());
    await respond(
      "show",
      {
        status: "shown",
        ...thread("forged", "Foreign title"),
        created_at: 1791378000,
        closed_at: null,
      },
      "one",
    );
    expect(text()).not.toContain("Foreign title");
    expect(text()).toContain("incompatible");
  });
  it("clears all loaded data on a transport timeout and reports a failed copy", async () => {
    await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await act(async () => button("Copier le message 5").props.onClick());
    expect(text()).toContain("Copie indisponible");
    await act(async () => button("Messages plus anciens").props.onClick());
    const target = requests.findLast((request) => request.input.action === "history_recent")!;
    await act(async () => {
      resources.set(keyOf(target), {
        ...resource(target),
        error: "Bridget did not respond within six seconds.",
        isPending: false,
        isSuccess: false,
      });
      for (const listener of listeners) listener();
    });
    expect(text()).toContain("six seconds");
    expect(text()).not.toContain("Alice");
    expect(renderer!.root.findAllByProps({ "data-bridget-body": true })).toHaveLength(0);
  });
});
