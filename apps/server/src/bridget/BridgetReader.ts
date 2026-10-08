import {
  BridgetHumanView,
  BridgetReadError,
  BridgetReadInput,
  BridgetWatchInput,
  BridgetWatchEvent,
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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveBridgetExecutable } from "./BridgetExecutable.ts";

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
    readonly watch: (
      input: BridgetWatchInput,
    ) => Stream.Stream<BridgetWatchEvent, BridgetReadError>;
  }
>()("t3/bridget/BridgetReader") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
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
  ) {
    const thread = yield* snapshots
      .getThreadShellById(input.threadId)
      .pipe(Effect.mapError(() => new BridgetReadError({ code: "storage_unavailable" })));
    if (Option.isNone(thread)) return yield* new BridgetReadError({ code: "context_missing" });
    if (thread.value.projectId !== input.projectId)
      return yield* new BridgetReadError({ code: "project_mismatch" });
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
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
  return BridgetReader.of({ read, watch });
});

export const layer = Layer.effect(BridgetReader, make);
