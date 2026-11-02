import { it as effectIt } from "@effect/vitest";
import { act, render, stubGlobal, fakeTimers, type Screen } from "../../test/render";
import { FetchHttpClient } from "effect/http";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { cloneElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { describe, expect, it as baseIt, vi } from "vite-plus/test";

import { BridgetPanel } from "./BridgetPanel";
import { useRightPanelStore } from "../rightPanelStore";

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
const listeners = new Set<() => void>();
const requests: Target[] = [];
const pendingReads: {
  target: Target;
  resolve: (value: unknown) => void;
  signal: AbortSignal | undefined;
  settled: boolean;
}[] = [];
let activeWatches = 0;
let nativeRegistry: AtomRegistry.AtomRegistry | null = null;
let nativeWatch:
  | ((target: {
      environmentId: EnvironmentId;
      input: { threadId: ThreadId; projectId: ProjectId };
      visitId: string;
    }) => Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>)
  | null = null;
let watchSubscriptionId = Symbol("fixture-watch");
let watchValue: unknown = {
  _tag: "Success",
  value: {
    event: {
      version: 1,
      generation: "10000000-0000-4000-8000-000000000001",
      seq: 0,
      status: "ready",
    },
    readyGeneration: "10000000-0000-4000-8000-000000000001",
    subscriptionId: watchSubscriptionId,
  },
};
let connectionValue: unknown = { _tag: "Success", value: { phase: "connected", generation: 1 } };
const sharedIds = new Map<string, string>();
function sharedId(id: string): string {
  if (/^[0-9a-f]{8}-/.test(id)) return id;
  if (!sharedIds.has(id))
    sharedIds.set(id, `20000000-0000-4000-8000-${String(sharedIds.size + 1).padStart(12, "0")}`);
  return sharedIds.get(id)!;
}
const measurements = new Map<string, { clientHeight: number; scrollHeight: number }>();
const observers = new Set<{ callback: () => void; target: object | null }>();
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    bridgetRead: (target: Target) => target,
    bridgetWatch: (target: Target) => ({ kind: "watch", target }),
  },
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => ({ kind: "connection" }) },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {},
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: {
      kind: string;
      target?: {
        environmentId: EnvironmentId;
        input: { threadId: ThreadId; projectId: ProjectId };
        visitId: string;
      };
    }) => {
      if (atom.kind === "watch" && nativeWatch)
        return actual.useAtomValue(nativeWatch(atom.target!));
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          if (atom.kind === "watch") activeWatches++;
          return () => {
            listeners.delete(listener);
            if (atom.kind === "watch") activeWatches--;
          };
        },
        () => (atom.kind === "watch" ? watchValue : connectionValue),
      );
    },
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: (_registry: unknown, target: Target, options: { signal?: AbortSignal }) => {
    requests.push(target);
    return new Promise((resolve) => {
      const pending = { target, resolve, signal: options.signal, settled: false };
      pendingReads.push(pending);
      options.signal?.addEventListener(
        "abort",
        () => {
          pending.settled = true;
          resolve({ _tag: "Failure", cause: { reasons: [] } });
        },
        { once: true },
      );
    });
  },
}));
vi.mock("~/components/ui/button", () => ({
  Button: "button",
  buttonVariants: () => "",
}));
vi.mock("~/components/ui/input", () => ({
  Input: "input",
}));
vi.mock("~/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipScrollDismissArea: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  getVirtualizedScrollFadeClassName: () => undefined,
  ScrollBar: () => null,
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
const copy = vi.hoisted(() => vi.fn(async () => true));
vi.mock("~/hooks/useCopyToClipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useCopyToClipboard")>()),
  writeTextToClipboard: copy,
}));

const context = {
  environmentId: EnvironmentId.make("env-A"),
  threadId: ThreadId.make("t3-A"),
  projectId: ProjectId.make("p-A"),
  visible: true,
};
async function signal(
  seq: number,
  status = "changed",
  generation = "10000000-0000-4000-8000-000000000001",
) {
  await act(async () => {
    watchValue = {
      _tag: "Success",
      value: {
        event: { version: 1, generation, seq, status },
        readyGeneration: generation,
        subscriptionId: watchSubscriptionId,
      },
    };
    for (const listener of listeners) listener();
  });
}
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
const allBy = (
  attributes: Record<string, string | boolean>,
  scope: HTMLElement = screen.container,
) =>
  all("*", scope).filter((node) =>
    Object.entries(attributes).every(([key, value]) => node.getAttribute(key) === String(value)),
  );
const by = (
  attributes: Record<string, string | boolean>,
  scope: HTMLElement = screen.container,
) => {
  const node = allBy(attributes, scope)[0];
  if (!node) throw new Error(`Missing DOM attributes: ${JSON.stringify(attributes)}`);
  return node;
};
function changeInput(element: HTMLElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
function text(): string {
  return screen.container.textContent ?? "";
}
function button(label: string) {
  return all("button").find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.includes(label),
  )!;
}
async function mount(props: Parameters<typeof BridgetPanel>[0] = context) {
  const panel = <BridgetPanel {...props} />;
  screen = await render(
    nativeRegistry ? (
      <RegistryContext.Provider value={nativeRegistry}>{panel}</RegistryContext.Provider>
    ) : (
      panel
    ),
    { router: false },
  );
  return screen;
}
async function respond(action: string, result: unknown, sharedThreadId?: string) {
  const normalizedId = sharedThreadId ? sharedId(sharedThreadId) : undefined;
  if (result && typeof result === "object" && "thread_id" in result)
    result = { ...result, thread_id: sharedId(String(result.thread_id)) };
  const pending = pendingReads.findLast(
    (read) =>
      read.target.input.action === action && read.target.input.sharedThreadId === normalizedId,
  );
  if (!pending) throw new Error("No matching human read in the fixture.");
  await act(async () => {
    pending.settled = true;
    pending.resolve({
      _tag: "Success",
      value: { version: 1, subject: { agent_id: "agent-A", name: "Agent A" }, result },
    });
  });
}
const thread = (id: string, title = id) => ({
  thread_id: sharedId(id),
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
  await act(async () => button(`Ouvrir ${id}`).click());
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

const it = baseIt.extend<{ fixture: void }>({
  fixture: [
    async ({ task: _task }, use) => {
      requests.length = 0;
      pendingReads.length = 0;
      sharedIds.clear();
      useRightPanelStore.setState({
        bridgetSelectionByContextKey: {},
        byThreadKey: {},
        userActionRevisionByThreadKey: {},
      });
      watchValue = {
        _tag: "Success",
        value: {
          event: {
            version: 1,
            generation: "10000000-0000-4000-8000-000000000001",
            seq: 0,
            status: "ready",
          },
          readyGeneration: "10000000-0000-4000-8000-000000000001",
          subscriptionId: watchSubscriptionId,
        },
      };
      connectionValue = { _tag: "Success", value: { phase: "connected", generation: 1 } };
      copy.mockClear();
      measurements.clear();
      observers.clear();
      using _height = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return measurements.get(this.textContent ?? "")?.clientHeight ?? 80;
        });
      using _scrollHeight = vi
        .spyOn(HTMLElement.prototype, "scrollHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return measurements.get(this.textContent ?? "")?.scrollHeight ?? 40;
        });
      using _resize = stubGlobal(
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

      try {
        await use();
      } finally {
        nativeWatch = null;
        nativeRegistry?.dispose();
        nativeRegistry = null;
        listeners.clear();
      }
    },
    { auto: true },
  ],
});

describe("Bridget native reader", () => {
  it("US9 marks the selected row with native sidebar selection and keyboard focus states", async () => {
    await using _screen1 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    const selected = button("Ouvrir one");
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(selected.className).toContain("bg-sidebar-row-active");
    expect(selected.className).toContain("text-sidebar-foreground");
    expect(selected.className).toContain("focus-visible:ring-inset");
    expect(selected.className).not.toContain("hover:bg-sidebar-row-hover");
    expect(button("Ouvrir two").getAttribute("aria-pressed")).toBe("false");
    expect(button("Ouvrir two").className).toContain("hover:bg-sidebar-row-hover");
    const selectedControl = selected;
    selectedControl.focus();
    expect(document.activeElement).toBe(selectedControl);
    await open("two");
    await page("two", 1, 1, 1);
    expect(button("Ouvrir two").getAttribute("aria-current")).toBe("true");
    expect(button("Ouvrir one").getAttribute("aria-current")).toBeNull();
  });

  it("US9 starts history at messages and keeps thread details beside the selected row", async () => {
    await using _screen2 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one", true);
    await page("one", 1, 1, 1);
    const history = by({ "aria-label": "Historique du fil Bridget" }, screen.container);
    expect(all("h2", history)).toHaveLength(0);
    expect(
      all("summary", history).filter((node) => node.textContent?.includes("Détails du fil")),
    ).toHaveLength(0);
    const details = all("summary", screen.container).find((node) =>
      node.textContent?.includes("Détails du fil"),
    )!.parentElement!;
    expect(details.parentElement).toBe(button("Ouvrir one").parentElement);
    expect(one("summary", details).textContent).toBe("Détails du fil");
    expect(one("summary", details).className).toContain("focus-visible:ring-ring");
    expect(all("summary", button("Ouvrir one"))).toHaveLength(0);
    expect(all("button", button("Ouvrir one"))).toHaveLength(1);
    expect(all("time", details)).toHaveLength(2);
    expect(all("article", screen.container)).toHaveLength(1);
  });

  it("US9 exposes the full authorized title and members in keyboard-accessible thread details", async () => {
    const title =
      "Un titre de fil long qui reste entièrement consultable sans dépendre de la ligne tronquée de la liste supérieure";
    const members = [
      { agent_id: "agent-A", name: "Alice avec un nom autorisé particulièrement long" },
      { agent_id: "agent-B", name: "Bruno avec un autre nom autorisé particulièrement long" },
      { agent_id: "agent-C", name: null },
    ];
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    useRightPanelStore.setState({ bridgetSelectionByContextKey: { [key]: sharedId("one") } });
    await using _screen3 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one", title)],
      next_after: null,
    });
    await respond(
      "show",
      {
        status: "shown",
        ...thread("one", title),
        members,
        created_at: 1791378000,
        closed_at: null,
      },
      "one",
    );
    await page("one", 1, 1, 1);
    const summary = all("summary", screen.container).find((node) =>
      node.textContent?.includes("Détails du fil"),
    )!;
    const details = summary.parentElement!;
    expect(summary.className).toContain("focus-visible:ring-ring");
    expect(details.parentElement).toBe(button(`Ouvrir ${title}`).parentElement);
    const paragraphs = all("p", details);
    expect(paragraphs.some((node) => node.textContent?.includes(title))).toBe(true);
    expect(
      paragraphs.some((node) =>
        node.textContent?.includes(
          members.map((member) => member.name ?? member.agent_id).join(" · "),
        ),
      ),
    ).toBe(true);
    expect(paragraphs.filter((node) => node.className.includes("break-words"))).toHaveLength(2);
    expect(paragraphs.every((node) => !node.className.includes("truncate"))).toBe(true);
    expect(
      all("h2", by({ "aria-label": "Historique du fil Bridget" }, screen.container)),
    ).toHaveLength(0);
  });

  it("US9 retains a unique authorized row outside the list and search through A-B-A", async () => {
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    useRightPanelStore.setState({ bridgetSelectionByContextKey: { [key]: sharedId("old") } });
    await using _screen4 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first")],
      next_after: null,
    });
    const { last_activity_at: _notExposedByShow, ...shown } = thread("old");
    await respond(
      "show",
      { status: "shown", ...shown, created_at: 1791378000, closed_at: null },
      "old",
    );
    await page("old", 1, 1, 1);
    expect(button("Ouvrir old")).toBeDefined();
    expect(
      all("span", button("Ouvrir old")).some((node) => node.textContent?.includes("Créé · ")),
    ).toBe(true);
    expect(one("time", button("Ouvrir old")).getAttribute("datetime")).toBe(
      new Date(1791378000 * 1000).toISOString(),
    );
    const row = button("Ouvrir old").parentElement;
    const details = all("summary", screen.container).find((node) =>
      node.textContent?.includes("Détails du fil"),
    )!.parentElement!;
    await act(async () => changeInput(one("input", screen.container), "first"));
    expect(button("Ouvrir old").getAttribute("aria-current")).toBe("true");
    expect(button("Ouvrir old").parentElement).toBe(row);
    await act(async () => changeInput(one("input", screen.container), ""));
    await signal(1);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first"), thread("old")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("old"), created_at: 1791378000, closed_at: null },
      "old",
    );
    await page("old", 1, 1, 1);
    expect(button("Ouvrir old").parentElement).toBe(row);
    expect(
      all("summary", screen.container).find((node) => node.textContent?.includes("Détails du fil"))!
        .parentElement,
    ).toBe(details);
    expect(allBy({ "aria-label": "Ouvrir old" }, screen.container)).toHaveLength(1);
    const other = { ...context, projectId: ProjectId.make("p-B") };
    await act(async () => screen.rerender(<BridgetPanel {...other} />));
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("two")],
      next_after: null,
    });
    await open("two");
    await page("two", 1, 1, 1);
    await act(async () => screen.rerender(<BridgetPanel {...context} />));
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("old"), created_at: 1791378000, closed_at: null },
      "old",
    );
    await page("old", 1, 1, 1);
    expect(button("Ouvrir old").getAttribute("aria-current")).toBe("true");
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBe(sharedId("old"));
  });

  it("US9 removes the exceptional row and its details on temporary masking and confirmed refusal", async () => {
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    useRightPanelStore.setState({ bridgetSelectionByContextKey: { [key]: sharedId("old") } });
    await using _screen5 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("old"), created_at: 1791378000, closed_at: null },
      "old",
    );
    await page("old", 1, 1, 1);
    expect(button("Ouvrir old")).toBeDefined();
    await signal(1);
    await respond("list_recent", {
      status: "error",
      code: "binding_unavailable",
      detail: "Indisponible",
      retryable: false,
    });
    expect(button("Ouvrir old")).toBeUndefined();
    expect(all("details", screen.container)).toHaveLength(0);
    expect(all("article", screen.container)).toHaveLength(0);
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBe(sharedId("old"));
    await act(async () => button("Rafraîchir").click());
    await signal(0, "ready", "10000000-0000-4000-8000-000000000002");
    await respond(
      "show",
      { status: "error", code: "thread_unavailable", detail: "Refusé", retryable: false },
      "old",
    );
    expect(button("Ouvrir old")).toBeUndefined();
    expect(all("details", screen.container)).toHaveLength(0);
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBeUndefined();
  });

  it("US9 preserves selected details, message and history scroll identity with exact copy on refresh", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 150 });
    await using _screen6 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    const details = all("summary", screen.container).find((node) =>
      node.textContent?.includes("Détails du fil"),
    )!.parentElement!;
    expect(details.parentElement).toBe(button("Ouvrir one").parentElement);
    const message = one("article", screen.container);
    const history = by({ "aria-label": "Historique du fil Bridget" }, screen.container);
    const scroll = history.children[0];
    await act(async () => button("Déplier le message 1").click());
    await signal(1);
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
    await page("one", 1, 2, 2);
    expect(
      all("summary", screen.container).find((node) => node.textContent?.includes("Détails du fil"))!
        .parentElement,
    ).toBe(details);
    expect(
      all("article", screen.container).find(
        (node) => node.getAttribute("aria-label") === "Message 1",
      ),
    ).toBe(message);
    expect(history.children[0]).toBe(scroll);
    expect(button("Replier le message 1")).toBeDefined();
    await act(async () => button("Copier le message 1").click());
    expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
  });

  it.each([
    {
      mode: "none",
      targets: ["30000000-0000-4000-8000-000000000001"],
      expected: "Sans sollicitation",
    },
    {
      mode: "targets",
      targets: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"],
      expected: "Alice → Bruno",
    },
    { mode: "all", targets: ["30000000-0000-4000-8000-000000000003"], expected: "Alice → Chloé" },
    {
      mode: "targets",
      targets: ["40000000-0000-4000-8000-000000000099"],
      expected: "Nom indisponible (40000000…0099)",
    },
    {
      mode: "targets",
      targets: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000003"],
      expected: "Alice → Bruno · Chloé",
    },
  ])(
    "shows requested recipients in the existing author/date row: $mode $expected",
    async ({ mode, targets, expected }) => {
      await using _screen7 = await mount();
      await respond("list_recent", {
        status: "listed_recent",
        threads: [thread("one")],
        next_after: null,
      });
      await act(async () => button("Ouvrir one").click());
      await respond(
        "show",
        {
          status: "shown",
          ...thread("one"),
          members: [
            { agent_id: "30000000-0000-4000-8000-000000000002", name: "Alice" },
            { agent_id: "30000000-0000-4000-8000-000000000001", name: "Bruno" },
            { agent_id: "30000000-0000-4000-8000-000000000003", name: "Chloé" },
            { agent_id: "30000000-0000-4000-8000-000000000004", name: "Membre non sollicité" },
          ],
          created_at: 1791378000,
          closed_at: null,
        },
        "one",
      );
      await respond(
        "history_recent",
        {
          status: "history_recent",
          thread_id: "one",
          snapshot_seq: 1,
          through_seq: 1,
          has_more: false,
          next_before_seq: null,
          entries: [
            {
              ...entry(1),
              author_id: "30000000-0000-4000-8000-000000000002",
              notify: { mode, targets },
            },
          ],
        },
        "one",
      );
      const message = one("article", screen.container);
      const authorRow = all("span", message)[0]!;
      const contents = (node: HTMLElement): string => node.textContent ?? "";
      expect(contents(authorRow)).toContain(expected);
      expect(contents(authorRow)).not.toContain("Membre non sollicité");
      let row = authorRow.parentElement;
      while (row && row.tagName !== "DIV") row = row.parentElement;
      expect(row ? all("time", row) : []).toHaveLength(1);
      expect(all("time", message)).toHaveLength(1);
      expect(by({ "data-bridget-body": true }, message).textContent).toBe(body);
      if (targets.includes("40000000-0000-4000-8000-000000000099"))
        expect(authorRow.getAttribute("aria-label")).toContain(
          "40000000-0000-4000-8000-000000000099",
        );
      await act(async () => button("Copier le message 1").click());
      expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
    },
  );
  effectIt.effect(
    "loads initially after a native ready-and-changed burst before React can observe ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          requests.length = 0;
          pendingReads.length = 0;
          useRightPanelStore.setState({
            bridgetSelectionByContextKey: {},
            byThreadKey: {},
            userActionRevisionByThreadKey: {},
          });
          const emitted = { observed: false };
          const session = yield* SubscriptionRef.make(
            Option.some({
              client: {
                "bridget.watch": () =>
                  Stream.make(
                    {
                      version: 1 as const,
                      generation: "10000000-0000-4000-8000-000000000001",
                      seq: 0,
                      status: "ready" as const,
                    },
                    {
                      version: 1 as const,
                      generation: "10000000-0000-4000-8000-000000000001",
                      seq: 1,
                      status: "changed" as const,
                    },
                  ).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.sync(() => {
                          emitted.observed = true;
                        }),
                      ).pipe(Stream.drain),
                    ),
                    Stream.concat(Stream.never),
                  ),
              },
            } as unknown as RpcSession),
          );
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId: context.environmentId,
              label: "Native burst",
              httpBaseUrl: "https://fixture.test",
              wsBaseUrl: "wss://fixture.test",
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session,
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          });
          const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
            _id,
            stream,
          ) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const service = EnvironmentRegistry.EnvironmentRegistry.of({
            run,
            followStream,
            stateChanges: () => SubscriptionRef.changes(supervisor.state),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          const atoms = createOrchestrationEnvironmentAtoms(
            Atom.runtime(
              Layer.merge(
                FetchHttpClient.layer,
                Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service),
              ),
            ),
          );
          nativeRegistry = AtomRegistry.make();
          nativeWatch = (target) => atoms.bridgetWatch(target);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              nativeWatch = null;
              nativeRegistry?.dispose();
              nativeRegistry = null;
              listeners.clear();
            }),
          );
          yield* Effect.promise(async () => {
            await using nativeScreen = await render(
              <RegistryContext.Provider value={nativeRegistry!}>
                <BridgetPanel {...context} />
              </RegistryContext.Provider>,
              { router: false },
            );
            screen = nativeScreen;
            await vi.waitFor(() => expect(emitted.observed).toBe(true));
            await act(async () => {});
            expect(
              requests.filter((request) => request.input.action === "list_recent"),
            ).toHaveLength(1);
          });
        }),
      ),
  );
  it("restores a remembered UUID outside the first list page without selecting the first thread", async () => {
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    useRightPanelStore.setState({ bridgetSelectionByContextKey: { [key]: sharedId("old") } });
    await using _screen8 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first")],
      next_after: null,
    });
    expect(
      requests.some(
        (request) =>
          request.input.action === "show" && request.input.sharedThreadId === sharedId("old"),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.input.sharedThreadId === sharedId("first"))).toBe(
      false,
    );
  });
  it("coalesces 100 signals into one running revalidation and one latest follow-up, with no quiet polling", async () => {
    await using _screen9 = await mount();
    await respond("list_recent", { status: "listed_recent", threads: [], next_after: null });
    const settled = requests.length;
    {
      using _timers = fakeTimers();
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
    }
    expect(requests).toHaveLength(settled);
    await act(async () => {
      watchValue = {
        _tag: "Success",
        value: {
          event: {
            version: 1,
            generation: "10000000-0000-4000-8000-000000000001",
            seq: 1,
            status: "changed",
          },
          readyGeneration: "10000000-0000-4000-8000-000000000001",
          subscriptionId: watchSubscriptionId,
        },
      };
      for (const listener of listeners) listener();
    });
    for (let seq = 2; seq <= 100; seq++)
      await act(async () => {
        watchValue = {
          _tag: "Success",
          value: {
            event: {
              version: 1,
              generation: "10000000-0000-4000-8000-000000000001",
              seq,
              status: "changed",
            },
            readyGeneration: "10000000-0000-4000-8000-000000000001",
            subscriptionId: watchSubscriptionId,
          },
        };
        for (const listener of listeners) listener();
      });
    expect(requests).toHaveLength(settled + 1);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("stale")],
      next_after: null,
    });
    expect(text()).not.toContain("stale");
    expect(requests).toHaveLength(settled + 2);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("final")],
      next_after: null,
    });
    expect(text()).toContain("final");
  });
  it("revalidates replacement relations under a new common snapshot while page three is pending", async () => {
    measurements.set("Texte 100", { clientHeight: 80, scrollHeight: 200 });
    await using _screen10 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 88, 137, 137);
    await act(async () => button("Messages plus anciens").click());
    await page("one", 38, 87, 137);
    await act(async () => button("Déplier le message 100").click());
    const unchanged = by({ "aria-label": "Message 100" }, screen.container);
    await act(async () => button("Messages plus anciens").click());
    const stale = pendingReads.findLast((read) => read.target.input.beforeSeq === 37)!;
    await signal(1);
    await page("one", 1, 37, 137);
    expect(all("article", screen.container)).toHaveLength(100);
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
    await page("one", 89, 138, 138);
    expect(requests.at(-1)!.input).toMatchObject({ beforeSeq: 137, toSeq: 138 });
    await page("one", 88, 137, 138);
    expect(requests.at(-1)!.input).toMatchObject({ beforeSeq: 87, toSeq: 138 });
    await respond(
      "history_recent",
      {
        status: "history_recent",
        thread_id: "one",
        through_seq: 87,
        snapshot_seq: 138,
        has_more: true,
        next_before_seq: 37,
        entries: Array.from({ length: 50 }, (_, i) => ({
          ...entry(87 - i),
          ...(87 - i === 60 ? { superseded_by_seq: 138 } : {}),
        })),
      },
      "one",
    );
    expect(text()).not.toContain("Remplacé par #138");
    expect(requests.at(-1)!.input).toMatchObject({ beforeSeq: 37, toSeq: 138 });
    await page("one", 1, 37, 138);
    expect(text()).toContain("Remplacé par #138");
    expect(all("article", screen.container)).toHaveLength(138);
    expect(by({ "aria-label": "Message 100" }, screen.container)).toBe(unchanged);
    expect(button("Replier le message 100").getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      stale.resolve({
        _tag: "Success",
        value: {
          version: 1,
          result: {
            status: "history_recent",
            thread_id: sharedId("one"),
            snapshot_seq: 137,
            entries: [entry(60)],
          },
        },
      }),
    );
    expect(text()).toContain("Remplacé par #138");
  });
  it("keeps a contiguous window when more than one page of messages arrives", async () => {
    await using _screen11 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 88, 137, 137);
    await act(async () => button("Messages plus anciens").click());
    await page("one", 38, 87, 137);
    await signal(1);
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
    await page("one", 151, 200, 200);
    expect(requests.at(-1)!.input).toMatchObject({ beforeSeq: 150, toSeq: 200 });
    await page("one", 101, 150, 200);
    await page("one", 88, 137, 200);
    await page("one", 38, 87, 200);
    expect(all("article", screen.container).map((node) => node.getAttribute("aria-label"))).toEqual(
      Array.from({ length: 163 }, (_, index) => `Message ${200 - index}`),
    );
    await act(async () => button("Messages plus anciens").click());
    expect(requests.at(-1)!.input).toMatchObject({ beforeSeq: 37, toSeq: 200 });
  });
  it("keeps the choice after a binding failure and clears it only after a selected-thread refusal", async () => {
    await using _screen12 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    await signal(1);
    await respond("list_recent", {
      status: "error",
      code: "binding_unavailable",
      detail: "Liaison indisponible.",
      retryable: false,
    });
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBe(sharedId("one"));
    expect(all("article", screen.container)).toHaveLength(0);
    const count = requests.length;
    await signal(2);
    expect(requests).toHaveLength(count);
    await act(async () => button("Rafraîchir").click());
    await signal(0, "ready", "10000000-0000-4000-8000-000000000002");
    await respond(
      "show",
      { status: "error", code: "thread_unavailable", detail: "Fil refusé.", retryable: false },
      "one",
    );
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBeUndefined();
    expect(all("article", screen.container)).toHaveLength(0);
  });
  it("purges a confirmed refusal even when a newer invalidation arrived during the selected read", async () => {
    await using _screen13 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").click());
    await signal(1);
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
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBeUndefined();
    expect(all("article", screen.container)).toHaveLength(0);
  });
  it("masks the old view while the daemon watch is retrying on a healthy T3 connection", async () => {
    await using _screen14 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    await act(async () => {
      watchValue = {
        _tag: "Success",
        value: { event: null, readyGeneration: null, subscriptionId: Symbol("retry") },
      };
      for (const listener of listeners) listener();
    });
    const key = JSON.stringify([context.environmentId, context.projectId, context.threadId]);
    expect(useRightPanelStore.getState().bridgetSelectionByContextKey[key]).toBe(sharedId("one"));
    expect(all("article", screen.container)).toHaveLength(0);
    const count = requests.length;
    await act(async () => {});
    expect(requests).toHaveLength(count);
    await signal(0, "ready", "10000000-0000-4000-8000-000000000002");
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
    await page("one", 1, 3, 3);
    expect(text()).toContain("Texte 3");
  });
  it("isolates remembered choices on A-B-A and rejects the old A visit after returning", async () => {
    await using _screen15 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    const old = pendingReads.findLast((read) => read.target.input.action === "history_recent")!;
    const other = { ...context, projectId: ProjectId.make("project-B") };
    await act(async () => screen.rerender(<BridgetPanel {...other} />));
    expect(old.signal?.aborted).toBe(true);
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("two")],
      next_after: null,
    });
    await open("two");
    await page("two", 2, 2, 2);
    await act(async () => screen.rerender(<BridgetPanel {...context} />));
    expect(requests.at(-1)!.input.sharedThreadId).toBe(sharedId("one"));
    await act(async () =>
      old.resolve({
        _tag: "Success",
        value: {
          result: {
            status: "history_recent",
            thread_id: sharedId("one"),
            entries: [{ ...entry(6), body: "Ancienne visite A" }],
          },
        },
      }),
    );
    expect(text()).not.toContain("Ancienne visite A");
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("first")],
      next_after: null,
    });
    await respond(
      "show",
      { status: "shown", ...thread("one"), created_at: 1791378000, closed_at: null },
      "one",
    );
    await page("one", 1, 1, 1);
    expect(all("article", screen.container)).toHaveLength(1);
    await act(async () => screen.rerender(<BridgetPanel {...other} />));
    expect(requests.at(-1)!.input.sharedThreadId).toBe(sharedId("two"));
  });
  it("cancels reads and masks content on a hidden document, then reacquires the saved choice", async () => {
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    await using _screen16 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    const pending = pendingReads.findLast((read) => read.target.input.action === "history_recent")!;
    await act(async () => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pending.signal?.aborted).toBe(true);
    const count = requests.length;
    await signal(1);
    expect(requests).toHaveLength(count);
    expect(text()).toBe("");
    await act(async () => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(requests.at(-1)!.input.sharedThreadId).toBe(sharedId("one"));
  });
  it("releases its watch over ten close-open cycles without background content reads", async () => {
    await using _screen17 = await mount();
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(activeWatches).toBe(1);
      await act(async () => screen.rerender(<BridgetPanel {...context} visible={false} />));
      expect(activeWatches).toBe(0);
      const count = requests.length;
      await signal(cycle + 1);
      expect(requests).toHaveLength(count);
      await signal(0, "ready", `10000000-0000-4000-8000-${String(cycle + 2).padStart(12, "0")}`);
      await act(async () => screen.rerender(<BridgetPanel {...context} />));
    }
  });
  it("masks content during disconnect and waits for a fresh ready before catching up", async () => {
    await using _screen18 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    await signal(1);
    await act(async () => {
      connectionValue = { _tag: "Success", value: { phase: "backoff", generation: 1 } };
      for (const listener of listeners) listener();
    });
    expect(activeWatches).toBe(0);
    expect(text()).not.toContain("Texte 2");
    const count = requests.length;
    await act(async () => {
      connectionValue = { _tag: "Success", value: { phase: "connected", generation: 2 } };
      for (const listener of listeners) listener();
    });
    expect(requests).toHaveLength(count);
    await signal(0, "ready", "10000000-0000-4000-8000-000000000002");
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
    await page("one", 1, 3, 3);
    expect(text()).toContain("Texte 3");
    const settled = requests.length;
    await signal(0, "ready", "10000000-0000-4000-8000-000000000001");
    await signal(0, "ready", "10000000-0000-4000-8000-000000000002");
    expect(requests).toHaveLength(settled);
  });
  it("requests a globally recent list and the latest history page, not an oldest-first window", async () => {
    await using _screen19 = await mount();
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
    await using _screen20 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    expect(all("time", screen.container).length).toBeGreaterThan(0);
    expect(all("details", screen.container).length).toBeGreaterThan(0);
    expect(text()).not.toContain("AM");
    expect(text()).not.toContain("PM");
  });
  it("replaces a duplicate thread observation and reorders all loaded threads by activity and ID", async () => {
    await using _screen21 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [
        { ...thread("c"), last_activity_at: 200 },
        { ...thread("b"), last_activity_at: 100 },
      ],
      next_after: "100:00000000-0000-0000-0000-000000000001",
    });
    await act(async () => button("Autres fils").click());
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
      all("button", screen.container)
        .filter((node) => node.getAttribute("aria-label")?.startsWith("Ouvrir "))
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Ouvrir c", "Ouvrir a", "Ouvrir b nouveau", "Ouvrir d"]);
    expect(requests.at(-1)!.input.after).toBe("100:00000000-0000-0000-0000-000000000001");
  });
  it("distinguishes a new empty thread's creation date from its last exchange", async () => {
    await using _screen22 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [{ ...thread("empty"), last_seq: 0 }],
      next_after: null,
    });
    expect(text()).toContain("Créé · ");
    const date = one("time", screen.container);
    expect(date.getAttribute("datetime")).toBe(new Date(1791378000 * 1000).toISOString());
    expect(date.getAttribute("aria-label")).toMatch(/2026/);
    expect(date.textContent).toMatch(/oct\./);
  });
  it("offers expansion only for measured overflow and observes resize without accumulating observers", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 40 });
    await using _screen23 = await mount();
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
    expect(button("Déplier le message 1").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button("Copier le message 1").click());
    expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
    await act(async () => button("Déplier le message 1").click());
    expect(button("Replier le message 1").getAttribute("aria-expanded")).toBe("true");
    expect(by({ "data-bridget-body": true }, screen.container).textContent).toBe(body);
    expect(observers.size).toBe(0);
    await act(async () => button("Replier le message 1").click());
    expect(observers.size).toBe(1);
    measurements.get(body)!.scrollHeight = 40;
    await act(async () => {
      for (const observer of observers) observer.callback();
    });
    expect(button("Déplier le message 1")).toBeUndefined();
    await act(async () => screen.rerender(<BridgetPanel {...context} visible={false} />));
    expect(observers.size).toBe(0);
  });
  it("searches the hidden tail of a collapsed plain message and copies the exact CRLF and Unicode body", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 200 });
    await using _screen24 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    const count = requests.length;
    const search = by(
      {
        "aria-label": "Rechercher dans les données chargées",
      },
      screen.container,
    );
    await act(async () => changeInput(search, "fin"));
    expect(all("article", screen.container)).toHaveLength(1);
    expect(button("Déplier le message 1").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button("Copier le message 1").click());
    expect(copy).toHaveBeenLastCalledWith(body, "message Bridget");
    expect(requests).toHaveLength(count);
  });
  it("keeps keyboard focus on a message control when resizing removes its expansion button", async () => {
    measurements.set(body, { clientHeight: 80, scrollHeight: 200 });
    await using _screen25 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 1, 1);
    button("Déplier le message 1").focus();
    using focus = vi.spyOn(button("Copier le message 1"), "focus");
    measurements.get(body)!.scrollHeight = 40;
    await act(async () => {
      for (const observer of observers) observer.callback();
    });
    expect(button("Déplier le message 1")).toBeUndefined();
    expect(focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
    expect(document.activeElement).toBe(button("Copier le message 1"));
  });
  it("keeps correction coordinates and French kinds in the message details", async () => {
    await using _screen26 = await mount();
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
    const message = one("article", screen.container);
    const detail = one("details", message);
    expect(JSON.stringify(detail.textContent)).toContain("Blocage");
    expect(text()).toContain("Remplace #3");
    expect(by({ "data-bridget-body": true }, screen.container).textContent).toBe("Texte 9");
  });
  it("purges all loaded messages when an older page returns a different snapshot", async () => {
    await using _screen27 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").click());
    await page("one", 3, 4, 7);
    expect(text()).toContain("incompatible");
    expect(all("article", screen.container)).toHaveLength(0);
    expect(observers.size).toBe(0);
  });
  it("loads only the selected T3 context and exposes member names with ID fallback", async () => {
    await using _screen28 = await mount();
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
    await using _screen29 = await mount();
    await respond("list_recent", { status: "listed_recent", threads: [], next_after: null });
    expect(text()).toContain("Aucun fil Bridget");
    await act(async () => button("Rafraîchir").click());
    await respond("list_recent", {
      status: "error",
      code: "binding_unavailable",
      detail: "Liaison Bridget indisponible.",
      retryable: false,
    });
    expect(text()).toContain("Liaison Bridget indisponible");
    expect(button("Rafraîchir").hasAttribute("disabled")).not.toBe(true);
  });
  it("purges on close, rejects late A while in B and does not resurrect A after returning", async () => {
    await using _screen30 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("shared-A", "Secret A")],
      next_after: null,
    });
    await act(async () => button("Rafraîchir").click());
    const old = pendingReads.at(-1)!;
    await act(async () => screen.rerender(<BridgetPanel {...context} visible={false} />));
    expect(text()).not.toContain("Secret A");
    const other = {
      ...context,
      environmentId: EnvironmentId.make("env-B"),
      threadId: ThreadId.make("t3-B"),
    };
    await act(async () => screen.rerender(<BridgetPanel {...other} />));
    await act(async () => {
      old.resolve({
        _tag: "Success",
        value: {
          version: 1,
          subject: null,
          result: {
            status: "listed_recent",
            threads: [thread("shared-A", "Late A")],
            next_after: null,
          },
        },
      });
    });
    expect(text()).not.toContain("Late A");
    await act(async () => screen.rerender(<BridgetPanel {...context} />));
    expect(text()).not.toContain("Late A");
    expect(text()).not.toContain("Secret A");
  });
  it("refreshes a pending A request when returning through B before it has completed", async () => {
    await using _screen31 = await mount();
    const original = requests.length;
    await act(async () =>
      screen.rerender(<BridgetPanel {...context} environmentId={EnvironmentId.make("env-B")} />),
    );
    await act(async () => screen.rerender(<BridgetPanel {...context} />));
    expect(requests.filter((request) => request.environmentId === "env-A")).toHaveLength(
      original + 1,
    );
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(0);
  });
  it("reads the latest 137-message snapshot and appends older pages without reversing the page", async () => {
    await using _screen32 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await page("one", 88, 137, 137);
    expect(all("article", screen.container)[0]!.getAttribute("aria-label")).toBe("Message 137");
    await act(async () => button("Messages plus anciens").click());
    await page("one", 38, 87, 137);
    await act(async () => button("Messages plus anciens").click());
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
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(137);
    expect(all("article", screen.container).map((node) => node.getAttribute("aria-label"))).toEqual(
      Array.from({ length: 137 }, (_, index) => `Message ${137 - index}`),
    );
    expect(button("Messages plus anciens")).toBeUndefined();
    await act(async () => button("Copier le message 1").click());
    expect(copy).toHaveBeenCalledWith(body, "message Bridget");
    for (const label of ["Historique", "Action", "Blocage", "Décision", "Message", "agent-A"])
      expect(text()).toContain(label);
    await open("two", true);
    await page("two", 1, 1, 1);
    expect(text()).toContain("Fermé");
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(1);
    expect(text()).not.toContain("Texte 6");
  });
  it("clears loaded bodies and members when a later history page refuses access", async () => {
    await using _screen33 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").click());
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
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(0);
    expect(text()).not.toContain("Alice");
  });
  it("searches only loaded titles, members, authors and bodies without requests on typing", async () => {
    await using _screen34 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    const count = requests.length;
    const search = by(
      {
        "aria-label": "Rechercher dans les données chargées",
      },
      screen.container,
    );
    await act(async () => changeInput(search, "café"));
    expect(text()).toContain("données chargées");
    expect(allBy({ "aria-label": "Ouvrir two" }, screen.container)).toHaveLength(0);
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(1);
    await act(async () => changeInput(search, "inexistant"));
    expect(text()).toContain("Aucun résultat");
    await act(async () => button("Effacer la recherche").click());
    expect(allBy({ "aria-label": "Ouvrir two" }, screen.container)).toHaveLength(1);
    for (const value of ["one", "Alice", "agent-A"]) {
      await act(async () => changeInput(search, value));
      expect(text()).toContain("one");
    }
    expect(requests).toHaveLength(count);
  });
  it("refreshes the list and current thread manually with a new snapshot and no background reads", async () => {
    await using _screen35 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 1, 2);
    const before = requests.length;
    await act(async () => button("Rafraîchir").click());
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(2);
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
    await page("one", 1, 3, 7);
    await page("one", 1, 2, 7);
    expect(requests.length).toBeGreaterThan(before);
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(3);
    expect(
      all("button", screen.container).some((node) =>
        node.textContent?.includes("Messages plus anciens"),
      ),
    ).toBe(false);
    const settled = requests.length;
    await act(async () => {});
    expect(requests).toHaveLength(settled);
  });
  it("keeps already loaded pages until the refreshed snapshot is atomically ready", async () => {
    await using _screen36 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    await act(async () => button("Messages plus anciens").click());
    await page("one", 3, 4);
    await act(async () => button("Rafraîchir").click());
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
    expect(text()).toContain("Texte 3");
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(4);
    await page("one", 3, 4);
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(4);
  });
  it("does not query without a complete context and distinguishes an empty history from loading", async () => {
    await using _screenEmpty = await mount({ ...context, threadId: null });
    expect(requests).toHaveLength(0);
    expect(text()).toContain("Sélectionnez une conversation");
    await act(async () => screen.rerender(<BridgetPanel {...context} />));
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
    await using _screen37 = await mount();
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
    expect(button("Rafraîchir").hasAttribute("disabled")).not.toBe(true);
  });
  it("ignores an old thread history response after another thread is selected", async () => {
    await using _screen38 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one"), thread("two")],
      next_after: null,
    });
    await open("one");
    await open("two");
    await page("one", 1, 6);
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(0);
    await page("two", 2, 2, 2);
    expect(text()).toContain("Texte 2");
    expect(text()).not.toContain("Texte 6");
  });
  it("rejects a detail response for another shared thread instead of displaying its members", async () => {
    await using _screen39 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await act(async () => button("Ouvrir one").click());
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
    await using _screen40 = await mount();
    await respond("list_recent", {
      status: "listed_recent",
      threads: [thread("one")],
      next_after: null,
    });
    await open("one");
    await page("one", 5, 6);
    copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await act(async () => button("Copier le message 5").click());
    expect(text()).toContain("Copie indisponible");
    await act(async () => button("Messages plus anciens").click());
    const target = requests.findLast((request) => request.input.action === "history_recent")!;
    await act(async () => {
      const pending = pendingReads.findLast((read) => read.target === target)!;
      pending.settled = true;
      pending.resolve({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              _tag: "Fail",
              error: Object.assign(new Error("Bridget did not respond within six seconds."), {
                code: "timeout",
              }),
            },
          ],
        },
      });
    });
    expect(text()).toContain("six secondes");
    expect(text()).not.toContain("Alice");
    expect(allBy({ "data-bridget-body": true }, screen.container)).toHaveLength(0);
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
