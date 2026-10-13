import {
  BridgetHumanView,
  BridgetReadError,
  BridgetReadInput,
  BridgetWatchInput,
  BridgetWatchEvent,
  BridgetLineageSnapshot,
  BridgetLineageDetail,
  BridgetLineageJournal,
  BridgetLineageError,
  BridgetLineageErrorCode,
  BridgetLineageCancelResult,
  type BridgetLineageWatchInput,
  type BridgetLineageReadInput,
  type BridgetLineageCancelInput,
  type BridgetLineageJournalInput,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { resolveBridgetExecutable } from "./BridgetExecutable.ts";

const decodeLineageSnapshot = Schema.decodeUnknownEffect(BridgetLineageSnapshot, {
  onExcessProperty: "error",
});
const decodeInput = Schema.decodeUnknownEffect(BridgetReadInput);
const decodeWatchInput = Schema.decodeUnknownEffect(BridgetWatchInput);
const decodeWatchLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      BridgetWatchEvent,
      Schema.Struct({
        version: Schema.Literal(1),
        status: Schema.Literal("error"),
        code: Schema.Literals([
          "unsupported_version",
          "binding_unavailable",
          "project_mismatch",
          "thread_unavailable",
          "invalid_request",
          "storage_unavailable",
          "response_too_large",
        ]),
      }),
    ]),
  ),
  { onExcessProperty: "error" },
);
const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgetHumanView));
const decodeVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Int })),
);
const refusalDetails = {
  unsupported_version: "The human thread protocol is incompatible.",
  binding_unavailable: "The selected conversation has no available Bridget binding.",
  project_mismatch: "The selected conversation belongs to another project.",
  thread_unavailable: "This shared thread is unavailable for the selected conversation.",
  invalid_request: "The human thread request is invalid.",
  storage_unavailable: "The shared thread storage is unavailable.",
  response_too_large: "The human thread response exceeds the read limit.",
} as const;

export class BridgetReader extends Context.Service<
  BridgetReader,
  {
    readonly read: (input: BridgetReadInput) => Effect.Effect<BridgetHumanView, BridgetReadError>;
    readonly lineageSnapshot: (
      input: BridgetLineageWatchInput,
    ) => Effect.Effect<BridgetLineageSnapshot, BridgetLineageError>;
    readonly lineageRead: (
      input: Exclude<BridgetLineageReadInput, { readonly action: "list" }>,
    ) => Effect.Effect<BridgetLineageDetail | BridgetLineageJournal, BridgetLineageError>;
    readonly lineageWatch: (
      input: BridgetLineageWatchInput,
    ) => Stream.Stream<BridgetWatchEvent, BridgetLineageError>;
    readonly lineageJournal: (
      input: BridgetLineageJournalInput,
    ) => Stream.Stream<BridgetLineageJournal, BridgetLineageError>;
    readonly lineageCancel: (
      input: BridgetLineageCancelInput,
    ) => Effect.Effect<BridgetLineageCancelResult, BridgetLineageError>;
    readonly watch: (
      input: BridgetWatchInput,
    ) => Stream.Stream<BridgetWatchEvent, BridgetReadError>;
  }
>()("t3/bridget/BridgetReader") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const resolveExecutable = resolveBridgetExecutable(environment).pipe(
    Effect.provideService(Path.Path, path),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const resolveContext = Effect.fn("BridgetReader.resolveContext")(function* (
    input: BridgetWatchInput,
    nativeContext = false,
  ) {
    const thread = yield* snapshots
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => new BridgetReadError({ code: "storage_unavailable" })));
    if (
      thread === null ||
      (nativeContext && (thread.deletedAt !== null || thread.bridgetTaskRef !== undefined))
    )
      return yield* new BridgetReadError({ code: "context_missing" });
    if (thread.projectId !== input.projectId)
      return yield* new BridgetReadError({ code: "project_mismatch" });
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(Effect.mapError(() => new BridgetReadError({ code: "storage_unavailable" })));
    if (Option.isNone(project)) return yield* new BridgetReadError({ code: "context_missing" });
    return project.value;
  });

  // O(n + p): bounded response decoding plus executable PATH search; no per-message I/O.
  const read = Effect.fn("BridgetReader.read")(function* (raw: BridgetReadInput) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(() => new BridgetReadError({ code: "invalid_request" })),
    );
    const project = yield* resolveContext(input);
    const command = yield* resolveExecutable;
    const args = [
      "thread",
      "inspect",
      "--t3-thread",
      input.threadId,
      "--project-root",
      project.workspaceRoot,
      "--action",
      input.action,
      "--json",
    ];
    const isList = input.action === "list" || input.action === "list_recent";
    if (input.action === "show" || input.action === "history" || input.action === "history_recent")
      args.push("--thread", input.sharedThreadId);
    if (input.action !== "show" && input.limit !== undefined)
      args.push("--limit", String(input.limit));
    if ((input.action === "list" || input.action === "list_recent") && input.after !== undefined)
      args.push("--after", input.after);
    if (input.action === "history") {
      if (input.fromSeq !== undefined) args.push("--from-seq", String(input.fromSeq));
      if (input.toSeq !== undefined) args.push("--to-seq", String(input.toSeq));
    }
    if (input.action === "history_recent") {
      if (input.beforeSeq !== undefined) args.push("--before-seq", String(input.beforeSeq));
      if (input.toSeq !== undefined) args.push("--to-seq", String(input.toSeq));
    }
    const output = yield* runner
      .run({ command, args, timeout: "6 seconds", maxOutputBytes: 256 * 1024, outputMode: "error" })
      .pipe(
        Effect.mapError(
          (error) =>
            new BridgetReadError({
              code:
                error._tag === "ProcessTimeoutError"
                  ? "timeout"
                  : error._tag === "ProcessOutputLimitError"
                    ? "output_limit"
                    : error._tag === "ProcessSpawnError"
                      ? "unavailable"
                      : "command_failed",
            }),
        ),
      );
    if (output.timedOut) return yield* new BridgetReadError({ code: "timeout" });
    if (
      output.stdoutTruncated ||
      output.stderrTruncated ||
      Buffer.byteLength(output.stdout, "utf8") > 128 * 1024
    )
      return yield* new BridgetReadError({ code: "output_limit" });
    if (output.stdoutInvalidUtf8) return yield* new BridgetReadError({ code: "invalid_output" });
    if (output.code === 3) return yield* new BridgetReadError({ code: "unavailable" });
    if (output.code !== 0 && output.code !== 2)
      return yield* new BridgetReadError({ code: "command_failed" });
    const header = yield* decodeVersion(output.stdout).pipe(
      Effect.mapError(() => new BridgetReadError({ code: "invalid_output" })),
    );
    if (header.version !== 1) return yield* new BridgetReadError({ code: "unsupported_version" });
    const view = yield* decodeView(output.stdout).pipe(
      Effect.mapError(() => new BridgetReadError({ code: "invalid_output" })),
    );
    if (view.result.status === "error")
      return {
        ...view,
        subject: null,
        result: { ...view.result, detail: refusalDetails[view.result.code] },
      };
    const expectedStatus = {
      list: "listed",
      list_recent: "listed_recent",
      show: "shown",
      history: "history",
      history_recent: "history_recent",
    }[input.action];
    if (
      output.code !== 0 ||
      view.subject === null ||
      view.result.status !== expectedStatus ||
      (!isList &&
        "sharedThreadId" in input &&
        view.result.status !== "listed" &&
        view.result.status !== "listed_recent" &&
        view.result.thread_id !== input.sharedThreadId)
    ) {
      return yield* new BridgetReadError({ code: "invalid_output" });
    }
    if (input.action === "history_recent" && view.result.status === "history_recent") {
      if (
        (input.toSeq !== undefined && view.result.snapshot_seq !== input.toSeq) ||
        view.result.through_seq !==
          Math.min(input.beforeSeq ?? view.result.snapshot_seq, view.result.snapshot_seq) ||
        view.result.entries.length > (input.limit ?? 200)
      )
        return yield* new BridgetReadError({ code: "invalid_output" });
    }
    if (input.action === "list_recent" && view.result.status === "listed_recent") {
      if (view.result.threads.length > (input.limit ?? 100))
        return yield* new BridgetReadError({ code: "invalid_output" });
      if (input.after !== undefined) {
        const [timestamp, id] = input.after.split(":");
        if (
          view.result.threads.some(
            (row) =>
              row.last_activity_at > Number(timestamp) ||
              (row.last_activity_at === Number(timestamp) && row.thread_id <= id!),
          )
        )
          return yield* new BridgetReadError({ code: "invalid_output" });
      }
    }
    return view;
  });
  // O(n + p): each output byte is visited once; the partial line buffer is fixed at 4 KiB.
  const watch = (raw: BridgetWatchInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const input = yield* decodeWatchInput(raw).pipe(
          Effect.mapError(() => new BridgetReadError({ code: "invalid_request" })),
        );
        const project = yield* resolveContext(input);
        const command = yield* resolveExecutable;
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              command,
              [
                "thread",
                "watch",
                "--t3-thread",
                input.threadId,
                "--project-root",
                project.workspaceRoot,
                "--json",
              ],
              { shell: false, stdin: "ignore", stderr: "ignore" },
            ),
          )
          .pipe(Effect.mapError(() => new BridgetReadError({ code: "unavailable" })));
        const ready = yield* Deferred.make<void>();
        let generation: string | undefined;
        let sequence = -1;
        const partial = new Uint8Array(4096);
        let length = 0;
        const decodeLine = Effect.fn("BridgetReader.decodeWatchLine")(function* (
          bytes: Uint8Array,
        ) {
          const line = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new BridgetReadError({ code: "invalid_output" }),
          });
          const header = yield* decodeVersion(line).pipe(
            Effect.mapError(() => new BridgetReadError({ code: "invalid_output" })),
          );
          if (header.version !== 1)
            return yield* new BridgetReadError({ code: "unsupported_version" });
          const event = yield* decodeWatchLine(line).pipe(
            Effect.mapError(() => new BridgetReadError({ code: "invalid_output" })),
          );
          if (event.status === "error") {
            // A validated terminal reply is not a missing handshake. Preserve its refusal
            // category while the separately bounded exit classification completes.
            yield* Deferred.succeed(ready, undefined);
            // CLI147 shares this closed line for refusal (exit2) and transport loss (exit3).
            // Never wait indefinitely for a child that printed a terminal line but stayed alive.
            const exitCode =
              event.code === "binding_unavailable"
                ? yield* child.exitCode.pipe(
                    Effect.catch(() => Effect.succeed(null)),
                    Effect.timeoutOrElse({
                      duration: "500 millis",
                      orElse: () => Effect.succeed(null),
                    }),
                  )
                : null;
            return yield* new BridgetReadError({
              code: exitCode === 3 ? "unavailable" : event.code,
            });
          }
          if (generation === undefined) {
            if (event.status !== "ready" || event.seq !== 0)
              return yield* new BridgetReadError({ code: "invalid_output" });
            generation = event.generation;
            yield* Deferred.succeed(ready, undefined);
          } else if (
            event.generation !== generation ||
            event.status === "ready" ||
            event.seq <= sequence
          ) {
            return yield* new BridgetReadError({ code: "invalid_output" });
          }
          sequence = event.seq;
          return event;
        });
        const parseChunk = Effect.fn("BridgetReader.parseWatchChunk")(function* (
          chunk: Uint8Array,
        ) {
          const events: BridgetWatchEvent[] = [];
          for (const byte of chunk) {
            if (byte === 10) {
              if (length === partial.length)
                return yield* new BridgetReadError({ code: "output_limit" });
              events.push(yield* decodeLine(partial.subarray(0, length)));
              length = 0;
            } else {
              if (length === partial.length)
                return yield* new BridgetReadError({ code: "output_limit" });
              partial[length++] = byte;
            }
          }
          return events;
        });
        const handshake = Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "6 seconds",
            orElse: () => Effect.fail(new BridgetReadError({ code: "timeout" })),
          }),
          Effect.andThen(Effect.never),
        );
        const completed = Stream.fromEffect(
          Effect.gen(function* () {
            if (length !== 0) return yield* new BridgetReadError({ code: "invalid_output" });
            // EOF ends the watch even if the child keeps running after closing stdout.
            return yield* new BridgetReadError({
              code: generation === undefined ? "unavailable" : "command_failed",
            });
          }),
        );
        return child.stdout.pipe(
          Stream.mapError(() => new BridgetReadError({ code: "command_failed" })),
          // Bound both partial lines and decoded batches, even for a large stdout chunk.
          Stream.flatMap((chunk) =>
            Stream.fromIterable(
              (function* () {
                for (let offset = 0; offset < chunk.length; offset += partial.length)
                  yield chunk.subarray(offset, offset + partial.length);
              })(),
              { chunkSize: 1 },
            ),
          ),
          Stream.mapEffect(parseChunk),
          Stream.flatMap(Stream.fromIterable),
          Stream.concat(completed),
          Stream.interruptWhen(handshake),
          Stream.withSpan("BridgetReader.watch"),
        );
      }),
    );
  const refusal = Schema.Struct({
    version: Schema.Literal(1),
    status: Schema.Literal("error"),
    code: BridgetLineageErrorCode,
    retryable: Schema.optional(Schema.Boolean),
  });
  const decodeRefusal = Schema.decodeUnknownEffect(refusal, { onExcessProperty: "error" });
  const decodeLineageJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
  const encodeJournalEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const resolveLineageContext = (input: BridgetLineageWatchInput) =>
    resolveContext(input, true).pipe(
      Effect.mapError(
        (error) =>
          new BridgetLineageError({
            code: error.code === "project_mismatch" ? "project_mismatch" : "binding_unavailable",
          }),
      ),
    );
  const lineageArgs = (input: BridgetLineageWatchInput, workspaceRoot: string) => [
    "--t3-thread",
    input.threadId,
    "--project-root",
    workspaceRoot,
  ];
  const decodeNativeJson = Effect.fn("BridgetReader.decodeNativeJson")(function* (output: string) {
    const value = yield* decodeLineageJson(output).pipe(
      Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "error"
    ) {
      const rejected = yield* decodeRefusal(value).pipe(
        Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
      );
      return yield* new BridgetLineageError({ code: rejected.code });
    }
    return value;
  });
  const runLineage = Effect.fn("BridgetReader.runLineage")(function* (
    args: string[],
    maxBytes: number,
  ) {
    const command = yield* resolveExecutable.pipe(
      Effect.mapError(() => new BridgetLineageError({ code: "unavailable" })),
    );
    const output = yield* runner
      .run({
        command,
        args,
        timeout: "6 seconds",
        maxOutputBytes: maxBytes + 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new BridgetLineageError({
              code:
                error._tag === "ProcessTimeoutError"
                  ? "timeout"
                  : error._tag === "ProcessOutputLimitError"
                    ? "output_limit"
                    : error._tag === "ProcessSpawnError"
                      ? "unavailable"
                      : "command_failed",
            }),
        ),
      );
    if (output.timedOut) return yield* new BridgetLineageError({ code: "timeout" });
    if (
      output.stdoutTruncated ||
      output.stderrTruncated ||
      Buffer.byteLength(output.stdout, "utf8") > maxBytes
    )
      return yield* new BridgetLineageError({ code: "output_limit" });
    if (output.stdoutInvalidUtf8) return yield* new BridgetLineageError({ code: "invalid_output" });
    const decoded = yield* decodeNativeJson(output.stdout);
    if (output.code !== 0)
      return yield* new BridgetLineageError({
        code: output.code === 3 ? "unavailable" : "command_failed",
      });
    return decoded;
  });
  // O(n): each bounded page is decoded once; no mutation or provider operation.
  const lineageSnapshotPages = Effect.fn("BridgetReader.lineageSnapshot")(function* (
    input: BridgetLineageWatchInput,
    responseVersion: 1 | 2,
  ) {
    const project = yield* resolveLineageContext(input);
    let head: BridgetLineageSnapshot | undefined;
    const tasks: BridgetLineageSnapshot["tasks"][number][] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const raw: unknown = yield* runLineage(
        [
          "lineage",
          "inspect",
          ...lineageArgs(input, project.workspaceRoot),
          ...(responseVersion === 2 ? ["--response-version", "2"] : []),
          "--action",
          "list",
          "--limit",
          "100",
          ...(cursor === null ? [] : ["--cursor", cursor]),
          "--json",
        ],
        128 * 1024,
      );
      const page = yield* decodeLineageSnapshot(raw).pipe(
        Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
      );
      if (page.version !== responseVersion)
        return yield* new BridgetLineageError({ code: "invalid_output" });
      if (
        page.tasks.length > 100 ||
        (head !== undefined &&
          (page.seq !== head.seq ||
            page.generation !== head.generation ||
            page.root_owner_agent_id !== head.root_owner_agent_id))
      )
        return yield* new BridgetLineageError({ code: "snapshot_changed" });
      head ??= page;
      tasks.push(...page.tasks);
      if (tasks.length > 4096) return yield* new BridgetLineageError({ code: "resource_limit" });
      cursor = page.next_cursor;
      if (cursor !== null) {
        if (cursors.has(cursor) || page.tasks.length === 0)
          return yield* new BridgetLineageError({ code: "invalid_output" });
        cursors.add(cursor);
      }
    } while (cursor !== null);
    // Decode the assembled discriminated union once more to preserve its
    // version/task correlation; every individual page has already been bounded.
    return yield* decodeLineageSnapshot({ ...head!, tasks, next_cursor: null }).pipe(
      Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
    );
  });
  const lineageSnapshot = (input: BridgetLineageWatchInput) =>
    lineageSnapshotPages(input, 2).pipe(
      Effect.catch((error) =>
        error.code === "unsupported_version" || error.code === "invalid_request"
          ? lineageSnapshotPages(input, 1)
          : Effect.fail(error),
      ),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new BridgetLineageError({ code: "timeout" })),
      }),
    );
  // Native pages budget serialized JournalEntry bodies separately from the envelope.
  // The wire margin covers metadata and delimiters for up to 100 events.
  const journalContentBytes = 16 * 1024;
  const journalEnvelopeBytes = 24 * 1024;
  const validateJournal = (journal: BridgetLineageJournal, taskId: string, afterSeq: number) =>
    Effect.gen(function* () {
      if (
        journal.task_id !== taskId ||
        journal.next_seq < afterSeq ||
        (journal.gap !== null && journal.gap.to_seq < journal.gap.from_seq)
      )
        return yield* new BridgetLineageError({ code: "invalid_output" });
      let previous = afterSeq;
      let contentBytes = 0;
      for (const event of journal.events) {
        if (event.seq <= previous || event.seq > journal.next_seq)
          return yield* new BridgetLineageError({ code: "invalid_output" });
        const encoded = yield* encodeJournalEvent(event).pipe(
          Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
        );
        contentBytes += Buffer.byteLength(encoded, "utf8");
        if (contentBytes > journalContentBytes)
          return yield* new BridgetLineageError({ code: "output_limit" });
        previous = event.seq;
      }
      return journal;
    });
  const lineageReadAttempt = Effect.fn("BridgetReader.lineageRead")(function* (
    input: Exclude<BridgetLineageReadInput, { readonly action: "list" }>,
    responseVersion: 1 | 2,
  ) {
    const project = yield* resolveLineageContext(input);
    const args = [
      "lineage",
      "inspect",
      ...lineageArgs(input, project.workspaceRoot),
      ...(responseVersion === 2 ? ["--response-version", "2"] : []),
      "--action",
      input.action,
      "--task",
      input.taskId,
      "--json",
    ];
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    if (input.action === "show" && input.offset !== undefined)
      args.push("--offset", String(input.offset));
    if (input.action === "journal" && input.afterSeq !== undefined)
      args.push("--after-seq", String(input.afterSeq));
    const raw = yield* runLineage(args, input.action === "show" ? 24 * 1024 : journalEnvelopeBytes);
    if (input.action === "show") {
      const detail = yield* Schema.decodeUnknownEffect(BridgetLineageDetail, {
        onExcessProperty: "error",
      })(raw).pipe(Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })));
      const resultBytes = Buffer.byteLength(detail.result ?? "", "utf8");
      if (
        detail.version !== responseVersion ||
        detail.task.task_id !== input.taskId ||
        detail.result_offset !== (input.offset ?? 0) ||
        resultBytes > (input.limit ?? 16384) ||
        detail.result_offset + resultBytes > detail.result_total_bytes ||
        (detail.result_next_offset !== null &&
          (detail.result_next_offset !== detail.result_offset + resultBytes || resultBytes === 0))
      )
        return yield* new BridgetLineageError({ code: "invalid_output" });
      return detail;
    }
    const journal = yield* Schema.decodeUnknownEffect(BridgetLineageJournal, {
      onExcessProperty: "error",
    })(raw).pipe(Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })));
    return yield* validateJournal(journal, input.taskId, input.afterSeq ?? 0);
  });
  const lineageRead = (input: Exclude<BridgetLineageReadInput, { readonly action: "list" }>) =>
    input.action === "journal"
      ? lineageReadAttempt(input, 1)
      : lineageReadAttempt(input, 2).pipe(
          Effect.catch((error) =>
            error.code === "unsupported_version" || error.code === "invalid_request"
              ? lineageReadAttempt(input, 1)
              : Effect.fail(error),
          ),
        );
  const lineageCancel = Effect.fn("BridgetReader.lineageCancel")(function* (
    input: BridgetLineageCancelInput,
  ) {
    const project = yield* resolveLineageContext(input);
    const raw = yield* runLineage(
      [
        "lineage",
        "cancel",
        ...lineageArgs(input, project.workspaceRoot),
        "--task",
        input.taskId,
        "--request-id",
        input.requestId,
        "--json",
      ],
      4096,
    );
    const receipt = yield* Schema.decodeUnknownEffect(BridgetLineageCancelResult, {
      onExcessProperty: "error",
    })(raw).pipe(Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })));
    if (receipt.task_id !== input.taskId)
      return yield* new BridgetLineageError({ code: "invalid_output" });
    return receipt;
  });

  // This private framing helper shares only CLI NDJSON handling, not state or authority.
  const lineageLines = (input: BridgetLineageWatchInput, tail: string[], maxLine: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const project = yield* resolveLineageContext(input);
        const command = yield* resolveExecutable.pipe(
          Effect.mapError(() => new BridgetLineageError({ code: "unavailable" })),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(
              command,
              [
                "lineage",
                ...tail.slice(0, 1),
                ...lineageArgs(input, project.workspaceRoot),
                ...tail.slice(1),
                "--json",
              ],
              { shell: false, stdin: "ignore", stderr: "ignore" },
            ),
          )
          .pipe(Effect.mapError(() => new BridgetLineageError({ code: "unavailable" })));
        const ready = yield* Deferred.make<void>();
        const partial = new Uint8Array(maxLine);
        let length = 0;
        const parse = Effect.fn("BridgetReader.lineageLines.parse")(function* (chunk: Uint8Array) {
          const values: unknown[] = [];
          for (const byte of chunk) {
            if (byte === 10) {
              const line = yield* Effect.try({
                try: () =>
                  new TextDecoder("utf-8", { fatal: true }).decode(partial.subarray(0, length)),
                catch: () => new BridgetLineageError({ code: "invalid_output" }),
              });
              length = 0;
              values.push(yield* decodeNativeJson(line));
              yield* Deferred.succeed(ready, undefined);
            } else {
              if (length === partial.length)
                return yield* new BridgetLineageError({ code: "output_limit" });
              partial[length++] = byte;
            }
          }
          return values;
        });
        const handshake = Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "6 seconds",
            orElse: () => Effect.fail(new BridgetLineageError({ code: "timeout" })),
          }),
          Effect.andThen(Effect.never),
        );
        return child.stdout.pipe(
          Stream.mapError(() => new BridgetLineageError({ code: "command_failed" })),
          Stream.flatMap((chunk) =>
            Stream.fromIterable(
              (function* () {
                for (let offset = 0; offset < chunk.length; offset += maxLine)
                  yield chunk.subarray(offset, offset + maxLine);
              })(),
              { chunkSize: 1 },
            ),
          ),
          Stream.mapEffect(parse),
          Stream.flatMap(Stream.fromIterable),
          Stream.concat(
            Stream.suspend(() =>
              Stream.fail(
                new BridgetLineageError({
                  code: length === 0 ? "command_failed" : "invalid_output",
                }),
              ),
            ),
          ),
          Stream.interruptWhen(handshake),
        );
      }),
    );
  const lineageWatch = (input: BridgetLineageWatchInput) =>
    Stream.unwrap(
      Effect.sync(() => {
        let generation: string | undefined;
        let sequence = -1;
        return lineageLines(input, ["watch"], 4096).pipe(
          Stream.mapEffect((raw) =>
            Effect.gen(function* () {
              const event = yield* Schema.decodeUnknownEffect(BridgetWatchEvent, {
                onExcessProperty: "error",
              })(raw).pipe(
                Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
              );
              if (generation === undefined) {
                if (event.status !== "ready" || event.seq !== 0)
                  return yield* new BridgetLineageError({ code: "invalid_output" });
                generation = event.generation;
              } else if (
                event.status === "ready" ||
                (event.generation === generation && event.seq <= sequence)
              ) {
                return yield* new BridgetLineageError({ code: "invalid_output" });
              } else if (event.generation !== generation && event.status !== "resync") {
                return yield* new BridgetLineageError({ code: "invalid_output" });
              }
              generation = event.generation;
              sequence = event.seq;
              return event;
            }),
          ),
        );
      }),
    );
  const lineageJournal = (input: BridgetLineageJournalInput) =>
    Stream.unwrap(
      Effect.sync(() => {
        let afterSeq = input.afterSeq ?? 0;
        return lineageLines(
          input,
          [
            "inspect",
            "--action",
            "journal",
            "--task",
            input.taskId,
            "--after-seq",
            String(afterSeq),
            "--limit",
            "100",
            "--follow",
          ],
          journalEnvelopeBytes,
        ).pipe(
          Stream.mapEffect((raw) =>
            Effect.gen(function* () {
              const journal = yield* Schema.decodeUnknownEffect(BridgetLineageJournal, {
                onExcessProperty: "error",
              })(raw).pipe(
                Effect.mapError(() => new BridgetLineageError({ code: "invalid_output" })),
              );
              yield* validateJournal(journal, input.taskId, afterSeq);
              afterSeq = journal.next_seq;
              return journal;
            }),
          ),
        );
      }),
    );
  return BridgetReader.of({
    read,
    watch,
    lineageSnapshot,
    lineageRead,
    lineageWatch,
    lineageJournal,
    lineageCancel,
  });
});

export const layer = Layer.effect(BridgetReader, make);
