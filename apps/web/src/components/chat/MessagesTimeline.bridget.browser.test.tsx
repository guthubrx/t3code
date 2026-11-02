import { randomUUID } from "~/lib/utils";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createRef, type ComponentProps } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import { MessagesTimeline } from "./MessagesTimeline";
import "~/index.css";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));
// Keep completed groups open so these tests exercise the native send row itself.
vi.mock("./MessagesTimeline.logic", async (original) => {
  const logic = await original<typeof import("./MessagesTimeline.logic")>();
  return {
    ...logic,
    deriveMessagesTimelineRowsWithState(
      input: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[0],
      previous: Parameters<typeof logic.deriveMessagesTimelineRowsWithState>[1],
    ) {
      const projection = logic.deriveMessagesTimelineRowsWithState(input, previous);
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

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    emptyPlaceholderInset: 0,
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
function directBatch(bodies = ["**Premier corps**", "**Deuxième corps**", "**Troisième corps**"]) {
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
type Props = ComponentProps<typeof MessagesTimeline>;
type Entry = Props["timelineEntries"][number];
async function renderTimeline(entries: ReadonlyArray<Entry>, overrides: Partial<Props> = {}) {
  const props = {
    ...buildProps(),
    routeThreadKey: `environment-local:bridget-${randomUUID()}`,
    ...overrides,
  };
  const ui = (next: ReadonlyArray<Entry>, patch: Partial<Props> = {}) => (
    <MessagesTimeline {...props} {...patch} timelineEntries={next} />
  );
  const container = document.createElement("div");
  container.style.cssText = "height:1200px;width:900px;display:flex;flex-direction:column";
  const screen = await render(ui(entries), { container });
  return Object.assign(screen, {
    replace: (next: ReadonlyArray<Entry>, patch: Partial<Props> = {}) =>
      screen.rerender(ui(next, patch)),
    button: (selector: string) => {
      const element = container.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing timeline control: ${selector}`);
      return element;
    },
    strong: () =>
      [...container.querySelectorAll("strong")]
        .filter((node) => !node.closest("[hidden], .hidden"))
        .map((node) => node.textContent),
  });
}
async function click(element: HTMLElement) {
  await act(() => element.click());
}
const replyToggle = '[data-bridget-reply-toggle="true"]';
const envelopeToggle = '[data-bridget-toggle="true"]';
const replyHeading = "↪ Réponse à 91388c07-f796-47e4-ae0e-41b62b4b54dd (relayée par Bridget) :";

describe("Bridget timeline disclosures", () => {
  it.each([
    "**Résumé pour toi : cette note utilisateur**",
    "Résumé pour toi: cette note utilisateur",
    "### Résumé pour toi : cette note utilisateur",
    "Résumé\u00a0pour\u00a0toi : cette note utilisateur",
    "Pour\ttoi : cette note utilisateur",
  ])("keeps ambiguous user notes visible: %s", async (note) => {
    const text = `${replyHeading}\n\nAgent\n\n---\n\n${note}`;
    await using screen = await renderTimeline([buildAssistantTimelineEntry(text)]);
    expect(screen.container.querySelector(replyToggle)).toBeNull();
    expect(screen.container.textContent).toContain("cette note utilisateur");
  });

  it("keeps user text visible, preserves citation text and copies the whole mixed reply", async () => {
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const text = `${replyHeading}\n\n**Preuve pour l'agent**\n\n---\n\nRésumé pour toi : **Note utilisateur visible**`;
    const source = buildUserTimelineEntry(
      "💬 Message Bridget de wild4-camera (91388c07-f796-47e4-ae0e-41b62b4b54dd) (id test) :\n\nQuestion",
    );
    const reply = buildAssistantTimelineEntry(text);
    reply.id = "reply-entry";
    reply.message.id = MessageId.make("reply-message");
    await using screen = await renderTimeline([source, reply]);
    const toggle = () => screen.button(replyToggle);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toContain("wild4-camera");
    expect(screen.strong()).toContain("Note utilisateur visible");
    expect(screen.strong()).not.toContain("Preuve pour l'agent");
    const content = document.getElementById(toggle().getAttribute("aria-controls")!)!;
    expect(content.hidden).toBe(false);
    expect(content.className).toBe("hidden");
    const citationText = content.textContent;
    await click(
      [...screen.container.querySelectorAll<HTMLElement>('button[aria-label="Copy message"]')].at(
        -1,
      )!,
    );
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(text);
    await click(toggle());
    expect(screen.strong()).toContain("Preuve pour l'agent");
    expect(content.textContent).toBe(citationText);
    await click(toggle());
    expect(screen.strong()).not.toContain("Preuve pour l'agent");
    await screen.replace([reply], { routeThreadKey: "environment-local:other-reply" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).not.toContain("wild4-camera");
    await click(toggle());
    await screen.replace(
      [{ ...reply, message: { ...reply.message, text: `${text}\nCorrection` } }],
      { routeThreadKey: "environment-local:other-reply" },
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the original reply open when a citation targets it", async () => {
    const reply = buildAssistantTimelineEntry(
      `${replyHeading}\n\n**Quote**\n\n---\n\nRésumé pour toi : **Quote**`,
    );
    await using screen = await renderTimeline([reply], {
      citationRequest: {
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
      },
    });
    expect(screen.container.querySelector(replyToggle)).toBeNull();
    expect(screen.container.querySelectorAll("strong")).toHaveLength(2);
    expect(screen.container.querySelectorAll("hr")).toHaveLength(1);
  });

  it("waits for streaming completion before folding a relay reply", async () => {
    const reply = buildAssistantTimelineEntry(`${replyHeading}\n\n**Réponse intacte**`);
    await using screen = await renderTimeline([
      { ...reply, message: { ...reply.message, streaming: true } },
    ]);
    expect(screen.container.querySelector(replyToggle)).toBeNull();
    expect(screen.strong()).toContain("Réponse intacte");
    await screen.replace([reply]);
    expect(screen.button(replyToggle).getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    "💬 Message Bridget de psychologie (91388c07-f796-47e4-ae0e-41b62b4b54dd) (id test, reply=no) :",
    "💬 Message Bridget de psychologie (91388c07-f796-47e4-ae0e-41b62b4b54dd) (via sous-agent codex 0123456789abcdef) (id test, reply=no) :",
    "🧵 Sollicitation Bridget dans le fil abc (nouveautés jusqu'à 3, id notice) :",
    "🔔 Notification Bridget (id bridget-observation:test) :",
    "🔔 2 notifications Bridget groupées dans ce tour :",
  ])("opens compact messages without interpreting their technical source: %s", async (heading) => {
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const text = `${heading}\n\n**Preuve visible après ouverture** <script>not HTML</script>\n\n${"Long message intact. ".repeat(500)}`;
    await using screen = await renderTimeline([buildUserTimelineEntry(text)]);
    const toggle = () => screen.button(envelopeToggle);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.strong()).toHaveLength(0);
    await click(screen.button('button[aria-label="Copy message"]'));
    expect(clipboard).toHaveBeenCalledExactlyOnceWith(text);
    await click(toggle());
    expect(screen.strong()).toContain("Preuve visible après ouverture");
    expect(screen.container.querySelector("script")).toBeNull();
    await click(screen.button('[data-bridget-details-toggle="true"]'));
    expect(screen.container.querySelector('[data-bridget-raw="true"]')?.textContent).toBe(text);
    await click(toggle());
    expect(screen.strong()).toHaveLength(0);
    await screen.replace([buildUserTimelineEntry("Ordinary **message**")]);
    expect(screen.container.querySelector(envelopeToggle)).toBeNull();
    expect(screen.strong()).toContain("message");
  });

  it("opens batch members independently and resets them for a different message or thread", async () => {
    const entry = buildUserTimelineEntry(directBatch());
    await using screen = await renderTimeline([entry]);
    const toggle = () => screen.button(envelopeToggle);
    const members = () => [
      ...screen.container.querySelectorAll<HTMLButtonElement>("[data-bridget-member-toggle]"),
    ];
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await click(toggle());
    expect(members().map((node) => node.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(new Set(members().map((node) => node.getAttribute("aria-controls"))).size).toBe(3);
    expect(screen.strong()).toEqual(["Premier corps"]);
    await click(members()[1]!);
    expect(screen.strong()).toEqual(["Premier corps", "Deuxième corps"]);
    await click(members()[0]!);
    await click(toggle());
    await click(toggle());
    expect(members().map((node) => node.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(screen.container.querySelector("[data-bridget-details-toggle]")).toBeNull();
    expect(screen.container.querySelector("[data-bridget-raw]")).toBeNull();
    await screen.replace([entry], { routeThreadKey: "environment-local:other-batch" });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await click(toggle());
    expect(members().map((node) => node.getAttribute("aria-expanded"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    await screen.replace(
      [{ ...entry, id: "entry-2", message: { ...entry.message, id: MessageId.make("message-2") } }],
      { routeThreadKey: "environment-local:other-batch" },
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["valid", "fallback", "overlong", "mixed-heading"])(
    "copies context links and attachments exactly on batch %s",
    async (variant) => {
      using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
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
      const entry = buildSnapShotTimelineEntry("http://localhost/screenshot.png");
      entry.message.text = text;
      await using screen = await renderTimeline([entry]);
      await click(screen.button('button[aria-label="Copy message"]'));
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(text);
      expect(
        [...screen.container.querySelectorAll("img")].some(
          (image) => image.src === "http://localhost/screenshot.png",
        ),
      ).toBe(true);
      if (variant === "overlong") expect(screen.container.querySelector(envelopeToggle)).toBeNull();
      else await click(screen.button(envelopeToggle));
      expect(screen.container.querySelector("[data-bridget-details-toggle]")).toBeNull();
      expect(screen.container.querySelector("[data-bridget-raw]")).toBeNull();
      expect(screen.container.querySelector("script")).toBeNull();
      expect(screen.strong()).toContain("Corps conservé");
      expect(screen.container.querySelectorAll("[data-bridget-member-toggle]")).toHaveLength(
        variant === "valid" ? 1 : 0,
      );
    },
  );

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
    "opens %s sends with the keyboard, preserving native data and avoiding delivery claims",
    async (_provider, toolData) => {
      await using screen = await renderTimeline([outgoingEntry143(toolData)]);
      const row = () => screen.button('[data-bridget-send="true"]');
      expect(row().getAttribute("aria-expanded")).toBe("false");
      expect(row().getAttribute("aria-label")).toContain(outgoing143.arguments.to);
      expect(row().getAttribute("aria-label")).not.toMatch(/livré|reçu/i);
      expect(row().textContent).toContain("Envoi");
      expect(row().querySelectorAll("img")).toHaveLength(1);
      const key = async (value: string) => {
        await act(() =>
          row().dispatchEvent(
            new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
          ),
        );
      };
      await key("Enter");
      expect(row().getAttribute("aria-expanded")).toBe("true");
      const native = screen.container.querySelector(
        '[data-v2-item-inspector="dynamic_tool"]',
      )?.textContent;
      expect(native).toContain("PRIVATE_BODY");
      expect(native).toContain(outgoing143.arguments.to);
      expect(native).toMatch(/accepted|in_flight/);
      await key(" ");
      expect(row().getAttribute("aria-expanded")).toBe("false");
      await click(row());
      expect(
        screen.container.querySelector('[data-v2-item-inspector="dynamic_tool"]')?.textContent,
      ).toBe(native);
    },
  );

  it.each(["unknown_recipient", "cross_project_reason_required", "envelope_mismatch", "unknown"])(
    "retains rejected send status %s in its native disclosure",
    async (status) => {
      await using screen = await renderTimeline([
        outgoingEntry143({ ...outgoing143, result: { structuredContent: { status } } }),
      ]);
      expect(screen.container.querySelector("[data-bridget-send]")).toBeNull();
      await click(screen.button('[aria-expanded="false"]'));
      expect(
        screen.container.querySelector('[data-v2-item-inspector="dynamic_tool"]')?.textContent,
      ).toContain(status);
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
  ])("keeps ambiguous or failed send data native: %j", async (toolData) => {
    await using screen = await renderTimeline([outgoingEntry143(toolData)]);
    expect(screen.container.querySelector("[data-bridget-send]")).toBeNull();
    await click(screen.button('[aria-expanded="false"]'));
    const native = screen.container.querySelector(
      '[data-v2-item-inspector="dynamic_tool"]',
    )?.textContent;
    expect(native).toContain("PRIVATE_BODY");
    expect(native).toContain("accepted");
  });
});
