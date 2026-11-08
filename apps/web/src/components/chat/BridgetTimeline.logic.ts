import {
  projectBridgetConversation,
  bridgetTurnDurationMs,
  type BridgetJournalProjection,
  type BridgetJournalBlock,
} from "@t3tools/client-runtime/bridget-journal-presentation";
import {
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import type { ThreadTimeline } from "./ThreadTimeline";

type TimelineProps = ComponentProps<typeof ThreadTimeline>;
export type BridgetTimelinePresentation = Pick<
  TimelineProps,
  | "draftEntries"
  | "importedTurnItems"
  | "latestRun"
  | "runningRunId"
  | "isWorking"
  | "activeTurnStartedAt"
  | "turnTimingByRunId"
>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function input(detail: string | null): unknown {
  if (detail === null) return undefined;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

const observedTimings = new WeakMap<
  object,
  NonNullable<BridgetTimelinePresentation["turnTimingByRunId"]>
>();
const projectedRows = new WeakMap<OrchestrationV2TurnItem, OrchestrationV2ProjectedTurnItem>();
const projectedBlocks = new WeakMap<
  BridgetJournalBlock,
  { scope: string; item: OrchestrationV2TurnItem }
>();

/** Translate data only. Rendering and presentation settings belong to ThreadTimeline. */
export function projectBridgetTimeline(
  projection: BridgetJournalProjection,
  thread: Pick<OrchestrationV2AppThread, "id" | "bridgetTask" | "bridgetTaskRef">,
  result: string | null = null,
): BridgetTimelinePresentation {
  const turns = projectBridgetConversation(projection);
  const rows: OrchestrationV2ProjectedTurnItem[] = [];
  const timing = new Map<RunId, { startedAt: string | null; completedAt: string | null }>();
  const taskStatus = thread.bridgetTask?.status ?? thread.bridgetTaskRef?.status;
  const working = ["working", "waiting_for_children"].includes(taskStatus ?? "");
  let latestRun: TimelineProps["latestRun"] = null;
  for (const [index, turn] of turns.entries()) {
    const runId = RunId.make(`bridget:${thread.id}:${turn.key}`);
    timing.set(runId, {
      startedAt: turn.excerpt ? null : turn.startedAt,
      completedAt: bridgetTurnDurationMs(turn) === null ? null : turn.endedAt,
    });
    const last = index === turns.length - 1;
    const active = last && working && turn.outcome === null;
    const successful = turn.outcome === "completed" || turn.outcome === "end_turn";
    if (last)
      latestRun = {
        runId,
        status: active
          ? "running"
          : turn.outcome === "failed"
            ? "failed"
            : turn.outcome === "cancelled"
              ? "interrupted"
              : successful
                ? "completed"
                : "starting",
        startedAt: turn.excerpt ? null : turn.startedAt,
        completedAt: bridgetTurnDurationMs(turn) === null ? null : turn.endedAt,
        turnEnded: turn.outcome !== null,
      };
    const finalText = turn.blocks.findLast((block) => block.kind === "text");
    const append = (item: OrchestrationV2TurnItem) => {
      let row = projectedRows.get(item);
      if (row?.position !== rows.length) {
        row = {
          position: rows.length,
          visibility: "local",
          sourceThreadId: thread.id,
          sourceItemId: item.id,
          item,
        };
        projectedRows.set(item, row);
      }
      rows.push(row);
    };
    for (const block of turn.blocks) {
      const streaming = active && block.kind === "text" && block === turn.blocks.at(-1);
      const scope = `${runId}:${active}:${streaming}:${turn.excerpt}:${block === finalText ? turn.endedAt : ""}`;
      const cached = projectedBlocks.get(block);
      if (cached?.scope === scope) {
        append(cached.item);
        continue;
      }
      const add = (item: OrchestrationV2TurnItem) => {
        projectedBlocks.set(block, { scope, item });
        append(item);
      };
      const first = block.events[0];
      const final = block.events.at(-1);
      // Invalid dates remain in the raw journal; never invent an item timestamp.
      if (
        !first ||
        !final ||
        !Number.isFinite(Date.parse(first.ts)) ||
        !Number.isFinite(Date.parse(final.ts))
      )
        continue;
      const payload = record(first.payload);
      const id = TurnItemId.make(`bridget:${thread.id}:${block.key}`);
      const updatedAt = DateTime.makeUnsafe(final.ts);
      const base = {
        id,
        threadId: thread.id,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: first.seq,
        status: "idle" as const,
        title: null,
        startedAt: DateTime.makeUnsafe(first.ts),
        completedAt: null,
        updatedAt,
      };
      if (
        (first.event === "turn_start" || first.event === "user_message") &&
        typeof payload.body === "string"
      ) {
        add({
          ...base,
          type: "user_message",
          messageId: MessageId.make(id),
          text: payload.body,
          inputIntent: "turn_start",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          status: "completed",
          completedAt: updatedAt,
        });
      } else if (block.kind === "text") {
        add({
          ...base,
          type: "assistant_message",
          messageId: MessageId.make(id),
          text: block.content,
          streaming,
          status: streaming ? "running" : "completed",
          completedAt: streaming ? null : updatedAt,
          updatedAt:
            block === finalText && turn.endedAt !== null && !turn.excerpt
              ? DateTime.makeUnsafe(turn.endedAt)
              : updatedAt,
        });
      } else if (block.kind === "activity") {
        const completed =
          block.detail === "item/completed" ||
          block.status === "completed" ||
          block.state === "completed";
        const failed =
          block.state === "failed" ||
          block.status === "failed" ||
          (block.exitCode !== null && block.exitCode !== 0);
        const activity = {
          ...base,
          status: failed
            ? ("failed" as const)
            : completed
              ? ("completed" as const)
              : block.detail === "item/started" && active
                ? ("running" as const)
                : ("idle" as const),
          completedAt: completed || failed ? updatedAt : null,
        };
        if (payload.kind === "command") {
          add({
            ...activity,
            type: "command_execution",
            input: block.text ?? "",
            ...(block.outputTail === null
              ? {}
              : { output: `Extrait de sortie conservé par Bridget\n${block.outputTail}` }),
            ...(block.exitCode === null ? {} : { exitCode: block.exitCode }),
          });
        } else if (payload.kind === "tool" || payload.kind === "tool_call") {
          add({
            ...activity,
            type: "dynamic_tool",
            toolName: block.text ?? block.label,
            input: input(block.detail),
          });
        } else if (
          payload.kind === "file" &&
          payload.write_confirmed === true &&
          typeof payload.path === "string" &&
          payload.path.trim()
        ) {
          add({
            ...activity,
            type: "file_change",
            fileName: payload.path,
            status: "completed",
            completedAt: updatedAt,
          });
        } else {
          add({
            ...activity,
            type: "system_notice",
            message: [block.label, block.text, block.detail].filter(Boolean).join(" · "),
          });
        }
      } else if (first.event === "error") {
        const message =
          typeof payload.message === "string"
            ? payload.message
            : typeof payload.reason === "string"
              ? payload.reason
              : typeof payload.detail === "string"
                ? payload.detail
                : typeof first.payload === "string"
                  ? first.payload
                  : "Erreur observée dans le journal Bridget.";
        add({
          ...base,
          type: "error",
          status: "failed",
          completedAt: updatedAt,
          failure: { class: "unknown", code: null, retryable: null, message },
        });
      } else if (typeof first.payload === "string") {
        add({ ...base, type: "system_notice", message: first.payload });
      }
    }
  }
  if (result !== null) {
    const ts =
      thread.bridgetTask?.completed_at ??
      thread.bridgetTask?.updated_at ??
      thread.bridgetTask?.created_at;
    if (typeof ts === "number") {
      const at = new Date(ts * 1000).toISOString();
      const id = MessageId.make(`bridget:${thread.id}:loaded-result`);
      const dt = DateTime.makeUnsafe(at);
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make(id),
        threadId: thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: dt,
        completedAt: dt,
        updatedAt: dt,
        type: "assistant_message",
        messageId: id,
        text: result,
        streaming: false,
      };
      return {
        draftEntries: null,
        importedTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: thread.id,
            sourceItemId: item.id,
            item,
          },
        ],
        latestRun: null,
        runningRunId: null,
        isWorking: false,
        activeTurnStartedAt: null,
        turnTimingByRunId: new Map(),
      };
    }
  }
  const previousTiming = observedTimings.get(thread);
  const unchanged =
    previousTiming?.size === timing.size &&
    [...timing].every(([id, value]) => {
      const before = previousTiming.get(id);
      return before?.startedAt === value.startedAt && before?.completedAt === value.completedAt;
    });
  const turnTimingByRunId = unchanged ? previousTiming : timing;
  if (!unchanged) observedTimings.set(thread, timing);
  return {
    draftEntries: null,
    importedTurnItems: rows,
    latestRun,
    runningRunId: latestRun?.status === "running" ? latestRun.runId : null,
    isWorking: latestRun?.status === "running",
    activeTurnStartedAt: latestRun?.status === "running" ? latestRun.startedAt : null,
    turnTimingByRunId,
  };
}
