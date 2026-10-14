import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";

const Uuid = Schema.String.check(Schema.isUUID(), Schema.isPattern(/^[0-9a-f-]{36}$/));
const Sequence = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const UnixSeconds = Sequence.check(Schema.isLessThanOrEqualTo(8_640_000_000_000));
const bounded = (length: number) => Schema.String.check(Schema.isMaxLength(length));
const context = { projectId: ProjectId, threadId: ThreadId };

export const BridgetNativeTaskStatus = Schema.Literals([
  "queued",
  "starting",
  "mission_pending",
  "working",
  "waiting_for_children",
  "cancelling",
  "result_available",
  "failed",
  "cancelled",
]);
export type BridgetNativeTaskStatus = typeof BridgetNativeTaskStatus.Type;

/** Frozen v1 wire fields. Enrichment must never leak into a v1 response. */
export const BridgetLineageTaskV1 = Schema.Struct({
  task_id: Uuid,
  parent_task_id: Schema.NullOr(Uuid),
  parent_agent_id: Uuid,
  child_agent_id: Uuid,
  child_instance_id: Schema.NullOr(bounded(2048)),
  created_at: UnixSeconds,
  updated_at: UnixSeconds,
  started_at: Schema.NullOr(UnixSeconds),
  completed_at: Schema.NullOr(UnixSeconds),
  agent_type: bounded(256),
  execution_protocol: Schema.Literals(["codex_app_server", "claude_stream_json"]),
  model: bounded(512),
  effort: Schema.NullOr(bounded(256)),
  cwd: bounded(4096),
  posture: Schema.Literals(["discovery", "development"]),
  title: Schema.String.check(
    Schema.makeFilter((value: string) => Array.from(value).length <= 256, {
      expected: "at most 256 characters",
    }),
  ),
  status: BridgetNativeTaskStatus,
  error: Schema.NullOr(bounded(1024)),
  result_available: Schema.Boolean,
  journal_available: Schema.Boolean,
});
export type BridgetLineageTaskV1 = typeof BridgetLineageTaskV1.Type;

// Same byte/control bound as native worker identities. Keep the permissions
// module's private validator local to its own boundary rather than exporting it.
const WorkerIdentity = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      value.length > 0 &&
      new TextEncoder().encode(value).length <= 256 &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }),
  ),
);
export const BridgetLineagePlacementV2 = Schema.Struct({
  machine_id: WorkerIdentity,
  display_name: Schema.NullOr(bounded(256)),
  worker_id: WorkerIdentity,
  last_contact_at: Schema.NullOr(UnixSeconds),
  contact_state: Schema.Literals(["connected", "stale", "unknown"]),
});
export type BridgetLineagePlacementV2 = typeof BridgetLineagePlacementV2.Type;

export const BridgetLineageTaskV2 = Schema.Struct({
  ...BridgetLineageTaskV1.fields,
  placement: Schema.NullOr(BridgetLineagePlacementV2),
});
export type BridgetLineageTaskV2 = typeof BridgetLineageTaskV2.Type;

// Exact rendering-inertia guard from bridget-core/src/text_guards.rs, including
// variation selectors and reserved U+2065 beyond Unicode Cc/Cf categories.
const decisionControlCharacters =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{110bd}\u{110cd}\u{13430}-\u{1345f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;

/** Decision text is data only; v3 never changes a frozen v1/v2 task. */
export const BridgetLineageDecisionV3 = Schema.Struct({
  mode: Schema.Literals(["explicit", "automatic", "fallback"]),
  candidate_id: Schema.String.check(Schema.isPattern(/^c0[1-8]$/)),
  reason: Schema.optional(
    Schema.String.check(
      Schema.makeFilter(
        (value: string) => {
          const bytes = new TextEncoder().encode(value).length;
          return bytes >= 1 && bytes <= 256 && !decisionControlCharacters.test(value);
        },
        {
          expected: "1 to 256 UTF-8 bytes without control or format characters",
        },
      ),
    ),
  ),
});
export type BridgetLineageDecisionV3 = typeof BridgetLineageDecisionV3.Type;
export const BridgetLineageTaskV3 = Schema.Struct({
  ...BridgetLineageTaskV2.fields,
  decision: Schema.NullOr(BridgetLineageDecisionV3),
});
export type BridgetLineageTaskV3 = typeof BridgetLineageTaskV3.Type;

/** Stored projections may predate enrichment; absent fields mean metadata unavailable. */
export const BridgetLineageTask = Schema.Struct({
  ...BridgetLineageTaskV1.fields,
  placement: Schema.optional(Schema.NullOr(BridgetLineagePlacementV2)),
  decision: Schema.optional(Schema.NullOr(BridgetLineageDecisionV3)),
});
export type BridgetLineageTask = typeof BridgetLineageTask.Type;

export const BridgetTaskRef = Schema.Struct({
  version: Schema.Literal(1),
  taskId: Uuid,
  rootThreadId: ThreadId,
  parentTaskId: Schema.NullOr(Uuid),
  generation: Uuid,
  seq: Sequence,
  status: BridgetNativeTaskStatus,
});
export type BridgetTaskRef = typeof BridgetTaskRef.Type;

export const BridgetLineageSnapshotV1 = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("ok"),
  generation: Uuid,
  seq: Sequence,
  root_owner_agent_id: Uuid,
  tasks: Schema.Array(BridgetLineageTaskV1).check(Schema.isMaxLength(4096)),
  next_cursor: Schema.NullOr(bounded(2048)),
});
export const BridgetLineageSnapshotV2 = Schema.Struct({
  ...BridgetLineageSnapshotV1.fields,
  version: Schema.Literal(2),
  tasks: Schema.Array(BridgetLineageTaskV2).check(Schema.isMaxLength(4096)),
});
export const BridgetLineageSnapshotV3 = Schema.Struct({
  ...BridgetLineageSnapshotV2.fields,
  version: Schema.Literal(3),
  tasks: Schema.Array(BridgetLineageTaskV3).check(Schema.isMaxLength(4096)),
});
export const BridgetLineageSnapshot = Schema.Union([
  BridgetLineageSnapshotV1,
  BridgetLineageSnapshotV2,
  BridgetLineageSnapshotV3,
]);
export type BridgetLineageSnapshot = typeof BridgetLineageSnapshot.Type;

export const BridgetLineageDetailV1 = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("ok"),
  generation: Uuid,
  seq: Sequence,
  root_owner_agent_id: Uuid,
  task: BridgetLineageTaskV1,
  result: Schema.NullOr(bounded(16384)),
  result_offset: Sequence,
  result_next_offset: Schema.NullOr(Sequence),
  result_total_bytes: Sequence.check(Schema.isLessThanOrEqualTo(256 * 1024)),
});
export const BridgetLineageDetailV2 = Schema.Struct({
  ...BridgetLineageDetailV1.fields,
  version: Schema.Literal(2),
  task: BridgetLineageTaskV2,
});
export const BridgetLineageDetailV3 = Schema.Struct({
  ...BridgetLineageDetailV2.fields,
  version: Schema.Literal(3),
  task: BridgetLineageTaskV3,
});
export const BridgetLineageDetail = Schema.Union([
  BridgetLineageDetailV1,
  BridgetLineageDetailV2,
  BridgetLineageDetailV3,
]);
export type BridgetLineageDetail = typeof BridgetLineageDetail.Type;

export const BridgetJournalEvent = Schema.Struct({
  v: Schema.Literal(1),
  seq: Sequence,
  ts: bounded(256),
  session_id: bounded(2048),
  event: bounded(256),
  message_id: Schema.optional(bounded(2048)),
  payload: Schema.Json,
});
export type BridgetJournalEvent = typeof BridgetJournalEvent.Type;
export const BridgetLineageJournal = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("ok"),
  task_id: Uuid,
  events: Schema.Array(BridgetJournalEvent).check(Schema.isMaxLength(100)),
  next_seq: Sequence,
  caught_up: Schema.Boolean,
  gap: Schema.NullOr(
    Schema.Struct({ from_seq: Sequence, to_seq: Sequence, reason: bounded(1024) }),
  ),
});
export type BridgetLineageJournal = typeof BridgetLineageJournal.Type;
export const BridgetLineageView = Schema.Union([
  BridgetLineageSnapshot,
  BridgetLineageDetail,
  BridgetLineageJournal,
]);
export type BridgetLineageView = typeof BridgetLineageView.Type;

const ReadInput = Schema.Union([
  Schema.Struct({ ...context, action: Schema.Literal("list") }),
  Schema.Struct({
    ...context,
    action: Schema.Literal("show"),
    taskId: Uuid,
    offset: Schema.optional(Sequence),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(16384))),
  }),
  Schema.Struct({
    ...context,
    action: Schema.Literal("journal"),
    taskId: Uuid,
    afterSeq: Schema.optional(Sequence),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
]);
export const BridgetLineageReadInput = Schema.declareConstructor<
  typeof ReadInput.Type,
  typeof ReadInput.Encoded
>()(
  [ReadInput],
  ([codec]) =>
    (input) =>
      SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" })(input),
);
export type BridgetLineageReadInput = typeof BridgetLineageReadInput.Type;

const WatchInput = Schema.Struct(context);
export const BridgetLineageWatchInput = Schema.declareConstructor<
  typeof WatchInput.Type,
  typeof WatchInput.Encoded
>()(
  [WatchInput],
  ([codec]) =>
    (input) =>
      SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" })(input),
);
export type BridgetLineageWatchInput = typeof BridgetLineageWatchInput.Type;

const JournalInput = Schema.Struct({
  ...context,
  taskId: Uuid,
  afterSeq: Schema.optional(Sequence),
});
export const BridgetLineageJournalInput = Schema.declareConstructor<
  typeof JournalInput.Type,
  typeof JournalInput.Encoded
>()(
  [JournalInput],
  ([codec]) =>
    (input) =>
      SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" })(input),
);
export type BridgetLineageJournalInput = typeof BridgetLineageJournalInput.Type;

const CancelInput = Schema.Struct({ ...context, taskId: Uuid, requestId: Uuid });
export const BridgetLineageCancelInput = Schema.declareConstructor<
  typeof CancelInput.Type,
  typeof CancelInput.Encoded
>()(
  [CancelInput],
  ([codec]) =>
    (input) =>
      SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" })(input),
);
export type BridgetLineageCancelInput = typeof BridgetLineageCancelInput.Type;
export const BridgetLineageCancelResult = Schema.Struct({
  version: Schema.Literal(1),
  task_id: Uuid,
  status: BridgetNativeTaskStatus,
});
export type BridgetLineageCancelResult = typeof BridgetLineageCancelResult.Type;

export const BridgetLineageErrorCode = Schema.Literals([
  "unsupported_version",
  "invalid_request",
  "binding_unavailable",
  "project_mismatch",
  "task_unavailable",
  "snapshot_changed",
  "journal_unavailable",
  "result_offset_invalid",
  "envelope_mismatch",
  "resource_limit",
  "store_unavailable",
  "unavailable",
  "timeout",
  "invalid_output",
  "output_limit",
  "command_failed",
]);
export class BridgetLineageError extends Schema.TaggedError<BridgetLineageError>()(
  "BridgetLineageError",
  { code: BridgetLineageErrorCode },
) {
  override get message(): string {
    return `Bridget lineage is unavailable (${this.code}).`;
  }
}

/** Provider-independent status; this does not claim a T3 run exists. */
export function bridgetTaskStatus(
  status: BridgetNativeTaskStatus,
): "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" {
  switch (status) {
    case "queued":
    case "starting":
    case "mission_pending":
      return "pending";
    case "working":
      return "running";
    case "waiting_for_children":
    case "cancelling":
      return "waiting";
    case "result_available":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}
