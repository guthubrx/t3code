import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type BridgetJournalEvent } from "@t3tools/contracts";
import { projectBridgetJournal } from "@t3tools/client-runtime/bridget-journal-presentation";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  workEntryIndicatesToolSuccess,
} from "../../session-logic";
import { projectBridgetTimeline } from "./BridgetTimeline.logic";
import { deriveMessagesTimelineRows, workEntryIsVisibleInGroup } from "./MessagesTimeline.logic";

const thread = {
  id: ThreadId.make("bridget-child"),
  bridgetTaskRef: {
    version: 1 as const,
    taskId: "25000000-0000-4000-8000-000000000001",
    rootThreadId: ThreadId.make("parent"),
    parentTaskId: null,
    generation: "25000000-0000-4000-8000-000000000002",
    seq: 1,
    status: "result_available" as const,
  },
};
const event = (
  seq: number,
  type: string,
  payload: BridgetJournalEvent["payload"],
  ts = `2026-11-08T12:00:${String(seq).padStart(2, "0")}Z`,
): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts,
  session_id: "session",
  message_id: "message",
  event: type,
  payload,
});
const transcript = () => [
  event(1, "turn_start", { body: "Vérifier le correctif." }, "2026-11-08T12:00:00Z"),
  event(2, "update", { kind: "text", content: "Je vérifie les sources." }),
  event(3, "update", {
    kind: "command",
    detail: "item/completed",
    text: "git diff --check",
    exit_code: 0,
    state: "completed",
    output_tail: "Aucun défaut de format.",
  }),
  event(4, "update", {
    kind: "text",
    content: "**Verdict favorable.**\n\n```ts\nconst ready = true;\n```",
  }),
  event(5, "turn_end", { stop_reason: "completed" }, "2026-11-08T12:02:40Z"),
];

describe("adaptation du journal vers la conversation T3", () => {
  it("utilise les messages, commandes et repli de tour natifs avec la durée attestée", () => {
    const native = projectBridgetTimeline(projectBridgetJournal({ events: transcript() }), thread);
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: native.importedTurnItems!,
      optimisticMessages: [],
    });
    const command = entries.find((entry) => entry.kind === "work");
    expect(command?.kind === "work" && command.entry.structuredPayload).toMatchObject({
      type: "command_execution",
      input: "git diff --check",
      exitCode: 0,
      status: "completed",
    });
    expect(
      entries.filter((entry) => entry.kind === "message").map((entry) => entry.message.text),
    ).toEqual([
      "Vérifier le correctif.",
      "Je vérifie les sources.",
      "**Verdict favorable.**\n\n```ts\nconst ready = true;\n```",
    ]);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: native.latestRun,
      turnTimingByRunId: native.turnTimingByRunId,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows).toContainEqual(
      expect.objectContaining({ kind: "turn-fold", label: "Worked for 2m 40s" }),
    );
    expect(
      rows.some((row) => row.kind === "message" && row.message.text.includes("Verdict favorable")),
    ).toBe(true);
    expect(
      rows.some((row) => row.kind === "message" && row.message.text.includes("Je vérifie")),
    ).toBe(false);
  });

  it("transmet une durée inconnue aux composants natifs après une lacune", () => {
    const native = projectBridgetTimeline(
      projectBridgetJournal({
        events: transcript(),
        gaps: [{ from_seq: 3, to_seq: 3, reason: "transport" }],
      }),
      thread,
    );
    expect(
      [...native.turnTimingByRunId!.values()].every((value) => value.completedAt === null),
    ).toBe(true);
  });

  it("ne transforme pas une invocation d'outil sans résultat en succès", () => {
    const native = projectBridgetTimeline(
      projectBridgetJournal({
        events: [
          event(1, "turn_start", {}),
          event(2, "update", {
            kind: "tool",
            text: "Read",
            detail: '{"path":"/project/index.ts"}',
          }),
        ],
      }),
      thread,
    );
    const tool = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: native.importedTurnItems!,
      optimisticMessages: [],
    }).find((entry) => entry.kind === "work");
    expect(tool?.kind === "work" && tool.entry.structuredPayload).toMatchObject({
      type: "dynamic_tool",
      toolName: "Read",
      input: { path: "/project/index.ts" },
      status: "idle",
    });
    if (tool?.kind !== "work") throw new Error("Missing observed tool");
    expect(workEntryIsVisibleInGroup(tool.entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(tool.entry)).toBe(false);
    expect(
      workEntryIsVisibleInGroup({
        ...tool.entry,
        projectedItem: {
          ...tool.entry.projectedItem!,
          item: { ...tool.entry.projectedItem!.item, startedAt: null },
        },
      }),
    ).toBe(false);
  });

  it("conserve le refus terminal dans la carte d'erreur native sans changer la source", () => {
    const source = [
      event(1, "turn_start", {}),
      event(2, "update", { kind: "text", content: "Analyse partielle." }),
      event(3, "error", { terminal_kind: "turn_failed", message: "Fournisseur indisponible." }),
    ];
    const projection = projectBridgetJournal({ events: source });
    const native = projectBridgetTimeline(projection, thread);
    expect(native.latestRun?.status).toBe("failed");
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: native.importedTurnItems!,
        optimisticMessages: [],
      }).some(
        (entry) =>
          entry.kind === "work" &&
          entry.entry.structuredPayload?.type === "error" &&
          entry.entry.structuredPayload.failure.message === "Fournisseur indisponible.",
      ),
    ).toBe(true);
    expect(projection.sourceEvents).toEqual(source);
  });
});
