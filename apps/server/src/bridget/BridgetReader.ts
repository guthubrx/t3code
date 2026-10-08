import { BridgetHumanView, BridgetReadError, BridgetReadInput } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const decodeInput = Schema.decodeUnknownEffect(BridgetReadInput);
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
  }
>()("t3/bridget/BridgetReader") {}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcessEnvironment;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const resolveExecutable = Effect.gen(function* () {
    const configured = environment.T3CODE_BRIDGET_EXECUTABLE?.trim();
    if (configured) {
      return yield* resolveCommandPath(configured, { env: environment }).pipe(
        Effect.mapError(() => new BridgetReadError({ code: "unavailable" })),
      );
    }
    if (environment.HOME) {
      const userBinary = yield* resolveCommandPath(
        path.join(environment.HOME, ".local", "bin", "bridget"),
        { env: environment },
      ).pipe(Effect.option);
      if (Option.isSome(userBinary)) return userBinary.value;
    }
    return yield* resolveCommandPath("bridget", { env: environment }).pipe(
      Effect.mapError(() => new BridgetReadError({ code: "unavailable" })),
    );
  }).pipe(
    Effect.flatMap((executable) =>
      /\.(cmd|bat)$/i.test(executable)
        ? Effect.fail(new BridgetReadError({ code: "unavailable" }))
        : Effect.succeed(executable),
    ),
    Effect.provideService(Path.Path, path),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  // O(n + p): bounded response decoding plus executable PATH search; no per-message I/O.
  const read = Effect.fn("BridgetReader.read")(function* (raw: BridgetReadInput) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(() => new BridgetReadError({ code: "invalid_request" })),
    );
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
    const command = yield* resolveExecutable;
    const args = [
      "thread",
      "inspect",
      "--t3-thread",
      input.threadId,
      "--project-root",
      project.value.workspaceRoot,
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
  return BridgetReader.of({ read });
});

export const layer = Layer.effect(BridgetReader, make);
