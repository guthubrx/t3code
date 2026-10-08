import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";

const Uuid = Schema.String.check(Schema.isUUID());
const Name = Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)));
const Sequence = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const RecentCursor = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((cursor) => {
    const match =
      /^(0|[1-9][0-9]*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(cursor);
    return match !== null && Number.isSafeInteger(Number(match[1]));
  }),
);
const context = { threadId: ThreadId.check(Schema.isUUID()), projectId: ProjectId };

const ReadInput = Schema.Union([
  Schema.Struct({
    ...context,
    action: Schema.Literal("list"),
    after: Schema.optional(Uuid),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
  Schema.Struct({ ...context, action: Schema.Literal("show"), sharedThreadId: Uuid }),
  Schema.Struct({
    ...context,
    action: Schema.Literal("list_recent"),
    after: Schema.optional(RecentCursor),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
  Schema.Struct({
    ...context,
    action: Schema.Literal("history_recent"),
    sharedThreadId: Uuid,
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
    beforeSeq: Schema.optional(Sequence),
    toSeq: Schema.optional(Sequence),
  }),
  Schema.Struct({
    ...context,
    action: Schema.Literal("history"),
    sharedThreadId: Uuid,
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
    fromSeq: Schema.optional(
      PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    ),
    toSeq: Schema.optional(Sequence),
  }).check(
    Schema.makeFilter(
      (input) =>
        input.fromSeq === undefined || input.toSeq === undefined || input.fromSeq <= input.toSeq,
    ),
  ),
]);
// RPC decoders otherwise discard unknown authority fields. Enforce closed parsing at the schema boundary.
export const BridgetReadInput = Schema.declareConstructor<
  typeof ReadInput.Type,
  typeof ReadInput.Encoded
>()([ReadInput], ([codec]) => {
  const decode = SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" });
  return (input) => decode(input);
});
export type BridgetReadInput = typeof BridgetReadInput.Type;

const Member = Schema.Struct({ agent_id: Uuid, name: Name });
const members = Schema.Array(Member).check(Schema.isMaxLength(16));
const ThreadSummary = Schema.Struct({
  thread_id: Uuid,
  title: Schema.String.check(Schema.isMaxLength(512)),
  creator_id: Uuid,
  state: Schema.Literals(["open", "closed"]),
  last_seq: Sequence,
  members,
});
const Entry = Schema.Struct({
  seq: PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  message_id: Uuid,
  author_id: Uuid,
  author_name: Name,
  created_at: Schema.Int,
  body: Schema.String.check(Schema.isMaxLength(60 * 1024)),
  notify: Schema.Struct({
    mode: Schema.Literals(["none", "targets", "all"]),
    targets: Schema.Array(Uuid).check(Schema.isMaxLength(16)),
  }),
  reply_to_seq: Schema.NullOr(Sequence),
  kind: Schema.optional(
    Schema.NullOr(Schema.Literals(["history", "action", "blocker", "decision"])),
  ),
  supersedes_seq: Schema.optional(Schema.NullOr(Sequence)),
  superseded_by_seq: Schema.optional(Schema.NullOr(Sequence)),
});
const HumanErrorCode = Schema.Literals([
  "unsupported_version",
  "binding_unavailable",
  "project_mismatch",
  "thread_unavailable",
  "invalid_request",
  "storage_unavailable",
  "response_too_large",
]);

const HumanView = Schema.Struct({
  version: Schema.Literal(1),
  subject: Schema.NullOr(Member),
  result: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("listed"),
      threads: Schema.Array(ThreadSummary).check(Schema.isMaxLength(100)),
      next_after: Schema.NullOr(Uuid),
    }),
    Schema.Struct({
      status: Schema.Literal("shown"),
      ...ThreadSummary.fields,
      created_at: Schema.Int,
      closed_at: Schema.NullOr(Schema.Int),
    }),
    Schema.Struct({
      status: Schema.Literal("listed_recent"),
      threads: Schema.Array(
        Schema.Struct({
          ...ThreadSummary.fields,
          last_activity_at: Sequence,
        }),
      ).check(Schema.isMaxLength(100)),
      next_after: Schema.NullOr(RecentCursor),
    }).check(
      Schema.makeFilter((result) => {
        const seen = new Set<string>();
        for (let index = 0; index < result.threads.length; index++) {
          const current = result.threads[index]!;
          if (seen.has(current.thread_id)) return false;
          seen.add(current.thread_id);
          const previous = result.threads[index - 1];
          if (
            previous &&
            (previous.last_activity_at < current.last_activity_at ||
              (previous.last_activity_at === current.last_activity_at &&
                previous.thread_id >= current.thread_id))
          )
            return false;
        }
        const last = result.threads.at(-1);
        return (
          result.next_after === null ||
          (last !== undefined && result.next_after === `${last.last_activity_at}:${last.thread_id}`)
        );
      }),
    ),
    Schema.Struct({
      status: Schema.Literal("history_recent"),
      thread_id: Uuid,
      entries: Schema.Array(Entry).check(Schema.isMaxLength(200)),
      snapshot_seq: Sequence,
      through_seq: Sequence,
      has_more: Schema.Boolean,
      next_before_seq: Schema.NullOr(Sequence),
    }).check(
      Schema.makeFilter((result) => {
        if (result.through_seq > result.snapshot_seq) return false;
        for (let index = 0; index < result.entries.length; index++) {
          const current = result.entries[index]!;
          const previous = result.entries[index - 1];
          if (current.seq > result.through_seq || (previous && previous.seq <= current.seq))
            return false;
        }
        const last = result.entries.at(-1);
        return result.has_more
          ? last !== undefined && last.seq > 1 && result.next_before_seq === last.seq - 1
          : result.next_before_seq === null;
      }),
    ),
    Schema.Struct({
      status: Schema.Literal("history"),
      thread_id: Uuid,
      entries: Schema.Array(Entry).check(Schema.isMaxLength(200)),
      snapshot_seq: Sequence,
      through_seq: Sequence,
      has_more: Schema.Boolean,
      next_from_seq: Schema.NullOr(Sequence),
      from_seq: PositiveInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    }),
    Schema.Struct({
      status: Schema.Literal("error"),
      code: HumanErrorCode,
      detail: Schema.String.check(Schema.isMaxLength(512)),
      retryable: Schema.Boolean,
    }),
  ]),
});
export const BridgetHumanView = Schema.declareConstructor<
  typeof HumanView.Type,
  typeof HumanView.Encoded
>()([HumanView], ([codec]) => {
  const decode = SchemaParser.decodeUnknownEffect(codec, { onExcessProperty: "error" });
  return (input) => decode(input);
});
export type BridgetHumanView = typeof BridgetHumanView.Type;

const BridgetReadErrorCode = Schema.Literals([
  "unavailable",
  "timeout",
  "invalid_output",
  "output_limit",
  "context_missing",
  "project_mismatch",
  "unsupported_version",
  "invalid_request",
  "command_failed",
  "storage_unavailable",
]);
export class BridgetReadError extends Schema.TaggedError<BridgetReadError>()("BridgetReadError", {
  code: BridgetReadErrorCode,
}) {
  override get message(): string {
    switch (this.code) {
      case "unavailable":
        return "Bridget is unavailable in this environment.";
      case "timeout":
        return "Bridget did not respond within six seconds.";
      case "invalid_output":
        return "Bridget returned an invalid human thread response.";
      case "output_limit":
        return "The Bridget response exceeded the read limit.";
      case "context_missing":
        return "The selected conversation or project is unavailable.";
      case "project_mismatch":
        return "The selected conversation does not belong to this project.";
      case "unsupported_version":
        return "The Bridget human thread protocol is incompatible.";
      case "invalid_request":
        return "The Bridget read request is invalid.";
      case "command_failed":
        return "The Bridget read command failed.";
      case "storage_unavailable":
        return "The conversation context could not be read.";
    }
  }
}
