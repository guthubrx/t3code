// @vitest-environment jsdom

import {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  act,
  createRef,
  useLayoutEffect,
  type ReactNode,
  type Ref,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import { makeStreamingTimelineFixture } from "../../test-fixtures";

const activityTestState = vi.hoisted(() => ({
  expanded: false,
  expandedRuns: false,
  subagentTooltips: false,
}));

// Expose tooltip contents in the renderer without requiring a browser portal.
vi.mock("../ui/tooltip", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ui/tooltip")>();
  return {
    ...original,
    Tooltip: (props: { children?: ReactNode }) =>
      activityTestState.subagentTooltips ? props.children : <original.Tooltip {...props} />,
    TooltipTrigger: (props: { children?: ReactNode; render?: ReactElement }) =>
      activityTestState.subagentTooltips ? (
        <>
          {props.render}
          {props.children}
        </>
      ) : (
        <original.TooltipTrigger {...props} />
      ),
    TooltipPopup: (props: { children?: ReactNode }) =>
      activityTestState.subagentTooltips ? props.children : <original.TooltipPopup {...props} />,
  };
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("./MessagesTimeline.logic", async (importOriginal) => {
  const logic = await importOriginal<typeof import("./MessagesTimeline.logic")>();
  return {
    ...logic,
    deriveMessagesTimelineRowsWithState(
      input: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[0],
      previous: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[1],
    ) {
      if (activityTestState.expandedRuns) {
        input = { ...input, expandedRunIds: new Set([RunId.make("run-1")]) };
      }
      const projection = logic.deriveMessagesTimelineRowsWithState(input, previous);
      if (!activityTestState.expanded) return projection;
      return logic.deriveMessagesTimelineRowsWithState({
        ...input,
        expandedWorkGroupIds: new Set(
          projection.rows.flatMap((row) =>
            row.kind === "work-toggle" || row.kind === "work-live" ? [row.groupId] : [],
          ),
        ),
      });
    },
  };
});

beforeEach(() => {
  activityTestState.subagentTooltips = false;
  activityTestState.expanded = false;
  activityTestState.expandedRuns = false;
});

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
      onSizeChanged?: (size: number) => void;
    };
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: boolean;
        };
    className?: string;
    contentInsetEndAdjustment?: number;
    ref?: Ref<LegendListRef>;
  }) => {
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onSizeChanged?.(240);
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div
        data-testid={legendListTestId}
        data-class-name={props.className}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-maintain-visible-content-position-restore={
          typeof props.maintainVisibleContentPosition === "object"
            ? Boolean(props.maintainVisibleContentPosition.shouldRestorePosition)
            : undefined
        }
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

const ElementStub = class ElementStub {};
function stubDomGlobals() {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("Element", ElementStub);
  vi.stubGlobal("getComputedStyle", undefined);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    Element: ElementStub,
    localStorage: globalThis.localStorage,
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
}

beforeEach(stubDomGlobals);
beforeAll(async () => {
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true });
  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 30_000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    providerStatuses: [],
    runs: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      runId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl ? { previewUrl } : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}

describe("MessagesTimeline", () => {
  it("keeps the composer resting after closing an inter-agent reply at the timeline end", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const flushFrame = () =>
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(0));
      });
    const props = buildProps();
    props.listRef.current = {
      getState: () => ({ isAtEnd: true }),
      getScrollableNode: () => null,
    } as unknown as LegendListRef;
    let composerState: ReturnType<typeof useComposerFocusState> | undefined;
    let resting = false;
    function ThreadProbe() {
      const composer = useComposerFocusState();
      useLayoutEffect(() => {
        composerState = composer;
        resting = composer.isComposerScrollCollapsed;
      });
      return (
        <MessagesTimeline
          {...props}
          onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
          timelineEntries={[
            buildAssistantTimelineEntry(
              "↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\n**Agent reply**",
            ),
          ]}
        />
      );
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<ThreadProbe />);
      });
      await act(() => composerState!.setIsComposerScrollCollapsed(true));
      const toggle = () => renderer!.root.findByProps({ "data-bridget-reply-toggle": "true" });
      await act(() => toggle().props.onClick());
      await flushFrame();
      await flushFrame();
      expect(toggle().props["aria-expanded"]).toBe(true);
      expect(resting).toBe(true);
      await act(() => toggle().props.onClick());
      await flushFrame();
      await flushFrame();
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(resting).toBe(true);
      await act(() => toggle().props.onClick());
      expect(toggle().props["aria-expanded"]).toBe(true);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it.each([
    "**Résumé pour toi : cette note utilisateur**",
    "Résumé pour toi: cette note utilisateur",
    "### Résumé pour toi : cette note utilisateur",
    "Résumé\u00a0pour\u00a0toi : cette note utilisateur",
    "Pour\ttoi : cette note utilisateur",
  ])("does not hide an ambiguous user-note variant: %s", async (note) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const reply = buildAssistantTimelineEntry(
      `↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\nAgent\n\n---\n\n${note}`,
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<MessagesTimeline {...buildProps()} timelineEntries={[reply]} />);
      });
      expect(renderer!.root.findAllByProps({ "data-bridget-reply-toggle": "true" })).toHaveLength(
        0,
      );
      const source = renderer!.root.findByProps({
        "data-assistant-citation-source": reply.message.id,
      });
      expect(
        source
          .findAll(() => true)
          .flatMap((node) => node.children)
          .filter((child) => typeof child === "string")
          .join(" "),
      ).toContain("cette note utilisateur");
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("preserves a mixed reply's complete citation DOM while its agent body is visually collapsed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const note = "Résumé pour toi : Quote";
    const text = `↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\n\`\`\`text\n${note}\n\`\`\`\n\n---\n\n${note}`;
    const reply = buildAssistantTimelineEntry(text);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<MessagesTimeline {...buildProps()} timelineEntries={[reply]} />);
      });
      const toggle = () => renderer!.root.findByProps({ "data-bridget-reply-toggle": "true" });
      const content = () => renderer!.root.findByProps({ id: toggle().props["aria-controls"] });
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(content().props.hidden).toBeUndefined();
      expect(content().props["aria-hidden"]).toBeUndefined();
      expect(content().props.className).toBe("hidden");
      expect(
        content().findByProps({ className: "chat-markdown-shiki" }).props.dangerouslySetInnerHTML
          .__html,
      ).toContain("Quote");
      await act(() => toggle().props.onClick());
      expect(content().props.className).toBeUndefined();
      expect(
        content().findByProps({ className: "chat-markdown-shiki" }).props.dangerouslySetInnerHTML
          .__html,
      ).toContain("Quote");
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it.each([
    ["[docs]: https://example.test/docs", "[Voir][docs]"],
    ["[d\\]ocs]: https://example.test/docs", "[Voir][d\\]ocs]"],
    ["[docs\n name]: https://example.test/docs", "[Voir][docs name]"],
    ["> [docs]: https://example.test/docs", "[Voir][docs]"],
    ["- [docs]: https://example.test/docs", "[Voir][docs]"],
  ])(
    "keeps a Markdown reference from the agent section available to the user note: %s",
    async (definition, link) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("requestAnimationFrame", () => 0);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      const reply = buildAssistantTimelineEntry(
        `↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\n${definition}\n\n---\n\nRésumé pour toi : ${link}`,
      );
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(() => {
          renderer = create(<MessagesTimeline {...buildProps()} timelineEntries={[reply]} />);
        });
        expect(renderer!.root.findAllByProps({ "data-bridget-reply-toggle": "true" })).toHaveLength(
          0,
        );
        expect(
          renderer!.root
            .findAllByType("a")
            .some((link) => link.props.href === "https://example.test/docs"),
        ).toBe(true);
      } finally {
        await act(() => renderer?.unmount());
      }
    },
  );

  it("keeps the complete original reply native when an assistant citation targets it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("document", {
      ...globalThis.document,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const reply = buildAssistantTimelineEntry(
      "↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\n**Quote**\n\n---\n\nRésumé pour toi : **Quote**",
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[reply]}
            citationRequest={{
              key: "quote-target",
              citation: {
                version: 1,
                environmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
                threadId: ThreadId.make("thread-1"),
                messageId: reply.message.id,
                text: "Quote",
                start: 90,
                end: 95,
                prefix: "",
                suffix: "",
              },
            }}
          />,
        );
      });
      expect(renderer!.root.findAllByProps({ "data-bridget-reply-toggle": "true" })).toHaveLength(
        0,
      );
      expect(
        renderer!.root.findAllByProps({ "data-assistant-citation-source": reply.message.id }),
      ).toHaveLength(1);
      expect(renderer!.root.findAllByType("strong")).toHaveLength(2);
      expect(renderer!.root.findAllByType("hr")).toHaveLength(1);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("collapses an inter-agent assistant reply while keeping its user note visible and copy exact", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const previousNavigator = globalThis.navigator;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const id = "91388c07-f796-47e4-ae0e-41b62b4b54dd";
    const text = `↪ Réponse à ${id} (relayée par Bridget) :\n\n**Preuve pour l'agent**\n\n---\n\nRésumé pour toi : **Note utilisateur visible**`;
    const source = buildUserTimelineEntry(
      `💬 Message Bridget de wild4-camera (${id}) (id test) :\n\nQuestion`,
    );
    const reply = buildAssistantTimelineEntry(text);
    reply.id = "reply-entry";
    reply.message.id = MessageId.make("reply-message");
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<MessagesTimeline {...buildProps()} timelineEntries={[source, reply]} />);
      });
      const toggle = () => renderer!.root.findByProps({ "data-bridget-reply-toggle": "true" });
      const strongText = () =>
        renderer!.root
          .findAllByType("strong")
          .filter((node) => {
            for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
              if (ancestor.props.hidden || ancestor.props.className === "hidden") return false;
            }
            return true;
          })
          .flatMap((node) =>
            node
              .findAll(() => true)
              .flatMap((child) => child.children)
              .filter((child) => typeof child === "string"),
          )
          .join(" ");
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(toggle().props["aria-label"]).toBe(
        `Bridget · Pour wild4-camera (${id}) · Entre agents`,
      );
      expect(strongText()).toContain("Note utilisateur visible");
      expect(strongText()).not.toContain("Preuve pour l'agent");
      await act(() =>
        renderer!.root
          .findAll((node) => node.type === "button" && node.props["aria-label"] === "Copy message")
          .at(-1)!
          .props.onClick({ nativeEvent: {} }),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
      await act(() => toggle().props.onClick());
      expect(toggle().props["aria-expanded"]).toBe(true);
      expect(strongText()).toContain("Preuve pour l'agent");
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:thread-2"
            timelineEntries={[reply]}
          />,
        );
      });
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(toggle().props["aria-label"]).not.toContain("wild4-camera");
      await act(() => toggle().props.onClick());
      const edited = { ...reply, message: { ...reply.message, text: `${text}\nCorrection` } };
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:thread-2"
            timelineEntries={[edited]}
          />,
        );
      });
      expect(toggle().props["aria-expanded"]).toBe(false);
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:thread-2"
            timelineEntries={[reply]}
          />,
        );
      });
      expect(toggle().props["aria-expanded"]).toBe(false);
    } finally {
      await act(() => renderer?.unmount());
      vi.stubGlobal("navigator", previousNavigator);
    }
  });

  it("leaves a streaming relay reply in the ordinary assistant flow until completed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const reply = buildAssistantTimelineEntry(
      "↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :\n\n**Live reply**",
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[{ ...reply, message: { ...reply.message, streaming: true } }]}
          />,
        );
      });
      expect(renderer!.root.findAllByProps({ "data-bridget-reply-toggle": "true" })).toHaveLength(
        0,
      );
      expect(
        renderer!.root
          .findAllByType("strong")[0]!
          .findAll(() => true)
          .flatMap((node) => node.children)
          .filter((child) => typeof child === "string")
          .join(""),
      ).toContain("Live reply");
      await act(() => {
        renderer!.update(<MessagesTimeline {...buildProps()} timelineEntries={[reply]} />);
      });
      expect(
        renderer!.root.findByProps({ "data-bridget-reply-toggle": "true" }).props["aria-expanded"],
      ).toBe(false);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  const outgoing143 = {
    type: "mcpToolCall",
    server: "bridget",
    tool: "bridget_send",
    arguments: {
      to: "91388c07-f796-47e4-ae0e-41b62b4b54dd",
      body: "  Corps exact\nPRIVATE_BODY  ",
    },
    result: { structuredContent: { status: "in_flight" } },
  };
  function outgoingEntry143(toolData: Record<string, unknown> = outgoing143) {
    const source = makeStreamingTimelineFixture().visibleTurnItems[0]!;
    const item = {
      ...source.item,
      type: "dynamic_tool" as const,
      providerThreadId: null,
      status: "completed" as const,
      toolName:
        toolData.type === "mcpToolCall"
          ? `${toolData.server}.${toolData.tool}`
          : String(toolData.toolName),
      input: toolData.arguments ?? toolData.input,
      output: toolData.result,
    };
    return {
      id: "send143",
      kind: "work" as const,
      createdAt: MESSAGE_CREATED_AT,
      entry: {
        id: "send143",
        createdAt: MESSAGE_CREATED_AT,
        toolCallId: "send143",
        label: "bridget_send native",
        tone: "tool" as const,
        itemType: "dynamic_tool" as const,
        toolLifecycleStatus: "completed" as const,
        structuredPayload: item,
        projectedItem: { ...source, item },
        toolData: { input: item.input, output: item.output },
      },
    };
  }
  function outgoingNativeText(renderer: ReactTestRenderer): string {
    return renderer.root
      .findAllByProps({ "data-v2-item-inspector": "dynamic_tool" })
      .filter((node) => typeof node.type === "string")
      .map((inspector) =>
        inspector
          .findAll(() => true)
          .flatMap((node) => node.children)
          .filter((child) => typeof child === "string")
          .join(""),
      )
      .join("\n");
  }
  it.each([
    "💬 Message Bridget de psychologie (id test, reply=no) :\n\n**Corps intact**",
    "🧵 Sollicitation Bridget dans le fil politique (nouveautés jusqu'à 3, id notice) :\n\n**Corps intact**",
    "🔔 Notification Bridget (id test) :\n\n**Corps intact**",
    "🔔 2 notifications Bridget groupées dans ce tour :\n\n**Corps intact**",
    "📥 1 messages Bridget groupés dans ce tour (reply=no) :\n\n── 1/1 — de psychologie (id test) ──\n**Corps intact**\n",
    "📥 2 messages Bridget groupés dans ce tour (reply=no) :\n\n**Corps intact**",
  ])("SPEC143 removes entry frames and preserves actual disclosure for %s", async (text) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry(text)]} />,
        );
      });
      const toggle = () => renderer!.root.findByProps({ "data-bridget-toggle": "true" });
      const container = renderer!.root.findAll(
        (node) =>
          typeof node.type === "string" && String(node.props.className).includes("max-w-[92%]"),
      )[0]!;
      expect(container.props.className).not.toMatch(/(?:^|\s)(?:bg-|border(?:-|\s))/);
      expect(container.props.style?.backgroundColor).toBeUndefined();
      expect(toggle().props.className).toContain("py-1");
      await act(() => toggle().props.onClick());
      expect(strongTexts(renderer!)).toContain("Corps intact");
      for (const node of renderer!.root
        .findByProps({ "data-bridget-card": "true" })
        .findAll((node) => typeof node.type === "string" && node.props.className)) {
        if (
          String(node.props.className).includes("border-t") ||
          String(node.props.className).includes("divide-border")
        )
          throw new Error("Bridget separator still framed");
      }
    } finally {
      await act(() => renderer?.unmount());
    }
  });
  it.each([
    ["Codex", outgoing143],
    [
      "Claude",
      {
        toolName: "mcp__bridget__bridget_send",
        input: outgoing143.arguments,
        result: { content: JSON.stringify({ status: "accepted" }), is_error: false },
      },
    ],
  ])(
    "SPEC143 reuses %s outgoing disclosure with keyboard, full native data and no delivery claim",
    async (_provider, toolData) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("requestAnimationFrame", () => 0);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(() => {
          renderer = create(
            <MessagesTimeline {...buildProps()} timelineEntries={[outgoingEntry143(toolData)]} />,
          );
        });
        const row = () => renderer!.root.findByProps({ "data-bridget-send": "true" });
        expect(row().props["aria-expanded"]).toBe(false);
        expect(row().props["aria-label"]).toContain(outgoing143.arguments.to);
        expect(
          renderer!.root.findAllByProps({ "data-v2-item-inspector": "dynamic_tool" }),
        ).toHaveLength(0);
        expect(row().findAllByType("img")).toHaveLength(1);
        expect(
          row()
            .findAllByType("span")
            .flatMap((node) => node.children)
            .join(" "),
        ).toContain("Envoi");
        expect(row().props["aria-label"]).not.toMatch(/livré|reçu/i);
        const preventDefault = vi.fn();
        await act(() => row().props.onKeyDown({ key: "Enter", preventDefault }));
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(row().props["aria-expanded"]).toBe(true);
        const native = outgoingNativeText(renderer!);
        expect(native).toContain("PRIVATE_BODY");
        expect(native).toContain(outgoing143.arguments.to);
        expect(native).toMatch(/accepted|in_flight/);
        expect(
          renderer!.root.findAllByProps({ "data-bridget-details-toggle": "true" }),
        ).toHaveLength(0);
        await act(() => row().props.onKeyDown({ key: " ", preventDefault }));
        expect(row().props["aria-expanded"]).toBe(false);
        await act(() => row().props.onClick());
        expect(outgoingNativeText(renderer!)).toBe(native);
      } finally {
        await act(() => renderer?.unmount());
      }
    },
  );
  it.each(["unknown_recipient", "cross_project_reason_required", "envelope_mismatch", "unknown"])(
    "SPEC143 keeps %s native and readable after opening",
    async (status) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("requestAnimationFrame", () => 0);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      const toolData = { ...outgoing143, result: { structuredContent: { status } } };
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(() => {
          renderer = create(
            <MessagesTimeline {...buildProps()} timelineEntries={[outgoingEntry143(toolData)]} />,
          );
        });
        expect(renderer!.root.findAllByProps({ "data-bridget-send": "true" })).toHaveLength(0);
        await act(() => renderer!.root.findByProps({ "aria-expanded": false }).props.onClick());
        expect(outgoingNativeText(renderer!)).toContain(status);
      } finally {
        await act(() => renderer?.unmount());
      }
    },
  );

  it.each([
    {
      toolName: "mcp__bridget__bridget_send",
      type: "mcpToolCall",
      server: "other",
      tool: "run_shell",
      input: outgoing143.arguments,
      result: { content: JSON.stringify({ status: "accepted" }) },
    },
    {
      toolName: "mcp__bridget__bridget_send",
      input: outgoing143.arguments,
      result: { content: JSON.stringify({ status: "accepted" }), is_error: "true" },
    },
    { ...outgoing143, result: { structuredContent: { status: "accepted", isError: "true" } } },
  ])("SPEC143 leaves ambiguous provider/error data fully native: %j", async (toolData) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline {...buildProps()} timelineEntries={[outgoingEntry143(toolData)]} />,
        );
      });
      expect(renderer!.root.findAllByProps({ "data-bridget-send": "true" })).toHaveLength(0);
      await act(() => renderer!.root.findByProps({ "aria-expanded": false }).props.onClick());
      expect(outgoingNativeText(renderer!)).toContain("PRIVATE_BODY");
      expect(outgoingNativeText(renderer!)).toContain("accepted");
    } finally {
      await act(() => renderer?.unmount());
    }
  });
  function directBatch(
    bodies = ["**Premier corps**", "**Deuxième corps**", "**Troisième corps**"],
  ) {
    return (
      `📥 ${bodies.length} messages Bridget groupés dans ce tour (reply=no) :\n` +
      bodies
        .map(
          (body, index) =>
            `\n── ${index + 1}/${bodies.length} — de ${index === 1 ? "Atelier coordination" : "Atelier interface"} (id same-id) ──\n${body}\n`,
        )
        .join("")
    );
  }
  function strongTexts(renderer: ReactTestRenderer) {
    return renderer.root.findAllByType("strong").map((node) =>
      node
        .findAll(() => true)
        .flatMap((child) => child.children)
        .filter((child) => typeof child === "string")
        .join(""),
    );
  }

  it("SPEC141 opens named sections independently and preserves choices while the group is closed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const bodies = [
      "**Premier corps**",
      "**Deuxième corps**",
      "**Troisième corps** " + "L".repeat(200),
    ];
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[buildUserTimelineEntry(directBatch(bodies))]}
          />,
        );
      });
      const outer = () => renderer!.root.findByProps({ "data-bridget-toggle": "true" });
      const members = () =>
        renderer!.root.findAll(
          (node) =>
            node.type === "button" && node.props["data-bridget-member-toggle"] !== undefined,
        );
      expect(outer().props["aria-expanded"]).toBe(false);
      expect(members()).toHaveLength(0);
      await act(() => outer().props.onClick());
      expect(members().map((node) => node.props["aria-expanded"])).toEqual([true, false, false]);
      expect(members().map((node) => node.props["aria-label"])).toEqual([
        "Message 1 de Atelier interface",
        "Message 2 de Atelier coordination",
        "Message 3 de Atelier interface",
      ]);
      expect(members().every((node) => node.props["aria-controls"])).toBe(true);
      expect(new Set(members().map((node) => node.props["aria-controls"])).size).toBe(3);
      expect(
        renderer!.root
          .findAllByProps({ "data-bridget-member-preview": "true" })
          .map((node) => node.children.join("")),
      ).toEqual(bodies.map((body) => body.slice(0, 120)));
      expect(strongTexts(renderer!)).toEqual(["Premier corps"]);
      await act(() => members()[1]!.props.onClick());
      expect(members().map((node) => node.props["aria-expanded"])).toEqual([true, true, false]);
      expect(strongTexts(renderer!)).toEqual(["Premier corps", "Deuxième corps"]);
      await act(() => members()[0]!.props.onClick());
      await act(() => outer().props.onClick());
      expect(members()).toHaveLength(0);
      await act(() => outer().props.onClick());
      expect(members().map((node) => node.props["aria-expanded"])).toEqual([false, true, false]);
      expect(renderer!.root.findAllByProps({ "data-bridget-details-toggle": "true" })).toHaveLength(
        0,
      );
      expect(renderer!.root.findAllByProps({ "data-bridget-raw": "true" })).toHaveLength(0);
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:other-thread"
            timelineEntries={[buildUserTimelineEntry(directBatch(bodies))]}
          />,
        );
      });
      expect(outer().props["aria-expanded"]).toBe(false);
      await act(() => outer().props.onClick());
      expect(members().map((node) => node.props["aria-expanded"])).toEqual([true, false, false]);
      const next = buildUserTimelineEntry(directBatch(bodies));
      next.message.id = MessageId.make("other-message");
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:other-thread"
            timelineEntries={[next]}
          />,
        );
      });
      expect(outer().props["aria-expanded"]).toBe(false);
      await act(() => outer().props.onClick());
      expect(members().map((node) => node.props["aria-expanded"])).toEqual([true, false, false]);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it.each(["valid", "fallback", "overlong", "mixed-heading"])(
    "SPEC141 copies the exact original context links and hides sources even on fallback (%j)",
    async (variant) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("requestAnimationFrame", () => 0);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.stubGlobal("HTMLElement", ElementStub);
      Object.assign(window, { HTMLElement: ElementStub });
      const previousNavigator = globalThis.navigator;
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const raw = directBatch([
        "**Corps conservé** [x](t3-context://v1/skill/ctx_1)\n<script>neverExecute()</script>",
      ]);
      const text =
        variant === "fallback"
          ? raw.replace("📥 1", "📥 2")
          : variant === "overlong"
            ? raw.replace("📥 1", `📥 ${"1".repeat(1100)}`)
            : variant === "mixed-heading"
              ? raw.replace(" :\n\n", " :\n\r\n")
              : raw;
      let renderer: ReactTestRenderer | undefined;
      try {
        const entry = buildSnapShotTimelineEntry("http://localhost/screenshot.png");
        entry.message.text = text;
        await act(() => {
          renderer = create(
            <MessagesTimeline
              {...buildProps()}
              onImageExpand={vi.fn()}
              timelineEntries={[entry]}
            />,
          );
        });
        await act(() =>
          renderer!.root
            .find((node) => node.type === "button" && node.props["aria-label"] === "Copy message")
            .props.onClick({ nativeEvent: {} }),
        );
        expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
        expect(
          renderer!.root
            .findAllByType("img")
            .some((node) => node.props.src === "http://localhost/screenshot.png"),
        ).toBe(true);
        if (variant === "overlong")
          expect(renderer!.root.findAllByProps({ "data-bridget-toggle": "true" })).toHaveLength(0);
        else
          await act(() =>
            renderer!.root.findByProps({ "data-bridget-toggle": "true" }).props.onClick(),
          );
        expect(
          renderer!.root.findAllByProps({ "data-bridget-details-toggle": "true" }),
        ).toHaveLength(0);
        expect(renderer!.root.findAllByProps({ "data-bridget-raw": "true" })).toHaveLength(0);
        expect(renderer!.root.findAllByType("script")).toHaveLength(0);
        expect(strongTexts(renderer!)).toContain("Corps conservé");
        expect(
          renderer!.root.findAll(
            (node) =>
              node.type === "button" && node.props["data-bridget-member-toggle"] !== undefined,
          ),
        ).toHaveLength(variant === "valid" ? 1 : 0);
      } finally {
        await act(() => renderer?.unmount());
        vi.stubGlobal("navigator", previousNavigator);
      }
    },
  );

  it.each([
    "💬 Message Bridget de psychologie (91388c07-f796-47e4-ae0e-41b62b4b54dd) (id test, reply=no) :",
    "💬 Message Bridget de psychologie (91388c07-f796-47e4-ae0e-41b62b4b54dd) (via sous-agent codex 0123456789abcdef) (id test, reply=no) :",
    "🧵 Sollicitation Bridget dans le fil abc (nouveautés jusqu'à 3, id notice) :",
    "🔔 Notification Bridget (id bridget-observation:test) :",
    "🔔 2 notifications Bridget groupées dans ce tour :",
  ])("opens compact Bridget content and exact technical text for %s", async (heading) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const previousNavigator = globalThis.navigator;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const body = `**Preuve visible après ouverture** <script>not HTML</script>\n\n${"Long message intact. ".repeat(500)}`;
    const text = `${heading}\n\n${body}`;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry(text)]} />,
        );
      });
      const toggle = () => renderer!.root.findByProps({ "data-bridget-toggle": "true" });
      expect(toggle().props["aria-expanded"]).toBe(false);
      expect(renderer!.root.findAllByType("strong")).toHaveLength(0);
      await act(() =>
        renderer!.root
          .find((node) => node.type === "button" && node.props["aria-label"] === "Copy message")
          .props.onClick({ nativeEvent: {} }),
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
      await act(() => toggle().props.onClick());
      expect(toggle().props["aria-expanded"]).toBe(true);
      expect(
        renderer!.root
          .findAllByType("strong")[0]!
          .findAll(() => true)
          .flatMap((node) => node.children)
          .filter((child) => typeof child === "string")
          .join(""),
      ).toContain("Preuve visible après ouverture");
      expect(renderer!.root.findAllByType("script")).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ "data-bridget-raw": "true" })).toHaveLength(0);
      await act(() =>
        renderer!.root.findByProps({ "data-bridget-details-toggle": "true" }).props.onClick(),
      );
      expect(renderer!.root.findByProps({ "data-bridget-raw": "true" }).children).toEqual([text]);
      await act(() => toggle().props.onClick());
      expect(renderer!.root.findAllByType("strong")).toHaveLength(0);
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            timelineEntries={[buildUserTimelineEntry("Ordinary **message**")]}
          />,
        );
      });
      expect(renderer!.root.findAllByProps({ "data-bridget-toggle": "true" })).toHaveLength(0);
      expect(
        renderer!.root
          .findAllByType("strong")[0]!
          .findAll(() => true)
          .flatMap((node) => node.children)
          .filter((child) => typeof child === "string")
          .join(""),
      ).toContain("message");
    } finally {
      await act(() => renderer?.unmount());
      vi.stubGlobal("navigator", previousNavigator);
    }
  });

  it("does not carry Bridget disclosure state into another thread or recycled message", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const text = "🔔 Notification Bridget (id bridget-observation:test) :\n\n**Notification body**";
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry(text)]} />,
        );
      });
      const toggle = () => renderer!.root.findByProps({ "data-bridget-toggle": "true" });
      await act(() => toggle().props.onClick());
      expect(toggle().props["aria-expanded"]).toBe(true);
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:thread-2"
            timelineEntries={[buildUserTimelineEntry(text)]}
          />,
        );
      });
      expect(toggle().props["aria-expanded"]).toBe(false);
      await act(() => toggle().props.onClick());
      const next = buildUserTimelineEntry(text);
      next.message.id = MessageId.make("message-2");
      await act(() => {
        renderer!.update(
          <MessagesTimeline
            {...buildProps()}
            routeThreadKey="environment-local:thread-2"
            timelineEntries={[next]}
          />,
        );
      });
      expect(toggle().props["aria-expanded"]).toBe(false);
    } finally {
      await act(() => renderer?.unmount());
    }
  });
});
