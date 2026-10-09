import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  BridgetReadError,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as BridgetReader from "./BridgetReader.ts";

const threadId = ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac");
const projectId = ProjectId.make("project-1");
const sharedThreadId = "3503a3ce-cb97-46eb-b17b-339377b0c1ce";
const input = { threadId, projectId, action: "list" } as const;
const envelope = {
  version: 1,
  subject: { agent_id: threadId, name: null },
  result: { status: "listed", threads: [], next_after: null },
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isBridgetReadError = Schema.is(BridgetReadError);
const output = (stdout = encodeJson(envelope), code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "private diagnostic secret",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const harness = Effect.fn("BridgetReaderTest.harness")(function* (
  options: {
    missingThread?: boolean;
    missingProject?: boolean;
    differentProject?: boolean;
    environment?: NodeJS.ProcessEnv;
    result?: ProcessRunner.ProcessRunOutput;
    error?: ProcessRunner.ProcessRunError;
    watchOutput?: Stream.Stream<Uint8Array>;
    watchSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
  } = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const watchCalls: ChildProcess.Command[] = [];
  let activeChildren = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        watchCalls.push(command);
        activeChildren += 1;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(147),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: options.watchOutput ?? Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
      () =>
        Effect.sync(() => {
          activeChildren -= 1;
        }),
    ),
  );
  const snapshots = ProjectionStoreV2.of({
    getThreadShell: () =>
      Effect.succeed(
        options.missingThread
          ? null
          : ({
              id: threadId,
              projectId: options.differentProject ? ProjectId.make("another-project") : projectId,
            } as OrchestrationV2ThreadShell),
      ),
  } as unknown as ProjectionStoreV2["Service"]);
  const projects = ProjectStoreV2.of({
    getShell: () =>
      Effect.succeed(
        options.missingProject
          ? Option.none()
          : Option.some({
              id: projectId,
              workspaceRoot: "/project with spaces/$(forged); é",
            } as OrchestrationProjectShell),
      ),
  } as unknown as ProjectStoreV2["Service"]);
  const runner = ProcessRunner.ProcessRunner.of({
    run: (request) => {
      calls.push(request);
      return options.error
        ? Effect.fail(options.error)
        : Effect.succeed(options.result ?? output());
    },
  });
  const reader = yield* BridgetReader.BridgetReader.pipe(
    Effect.provide(
      BridgetReader.layer.pipe(
        Layer.provide(Layer.succeed(ProjectionStoreV2, snapshots)),
        Layer.provide(Layer.succeed(ProjectStoreV2, projects)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, options.watchSpawner ?? spawner),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.succeed(
            HostProcessEnvironment,
            options.environment ?? {
              T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
              PATH: "/usr/bin:/bin",
            },
          ),
        ),
        Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
      ),
    ),
  );
  return { reader, calls, watchCalls, activeChildren: () => activeChildren };
});

const watchReady = { version: 1, generation: sharedThreadId, seq: 0, status: "ready" };
const watchBytes = (value: unknown) => new TextEncoder().encode(`${encodeJson(value)}\n`);

describe("BridgetReader.watch", () => {
  it.live("distinguishes a real CLI transport exit from its closed binding refusal line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        for (const [exitCode, expected] of [
          [2, "binding_unavailable"],
          [3, "unavailable"],
          [null, "binding_unavailable"],
        ] as const) {
          const executable = path.join(directory, `human-watch-error-${exitCode}`);
          const finish =
            exitCode === null ? "setInterval(() => {}, 60000)" : `process.exit(${exitCode})`;
          yield* fs.writeFileString(
            executable,
            `#!${process.execPath}\nprocess.stdout.write('${JSON.stringify({ version: 1, status: "error", code: "binding_unavailable" })}\\n', () => ${finish});\n`,
          );
          yield* fs.chmod(executable, 0o700);
          const h = yield* harness({
            environment: { T3CODE_BRIDGET_EXECUTABLE: executable },
            watchSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          });
          const error = yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(
            Effect.timeout("1 second"),
            Effect.flip,
          );
          expect(isBridgetReadError(error) && error.code).toBe(expected);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.live("fails and releases a real child that closes stdout but stays alive after ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const executable = path.join(directory, "human-watch-eof");
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}\nprocess.stdout.end('${JSON.stringify(watchReady)}\\n');\nsetInterval(() => {}, 60000);\n`,
        );
        yield* fs.chmod(executable, 0o700);
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
        const h = yield* harness({
          environment: { T3CODE_BRIDGET_EXECUTABLE: executable },
          watchSpawner: ChildProcessSpawner.make((command) =>
            nativeSpawner.spawn(command).pipe(
              Effect.tap((child) =>
                Effect.sync(() => {
                  handle = child;
                }),
              ),
            ),
          ),
        });
        const error = yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new BridgetReadError({ code: "timeout" })),
          }),
          Effect.flip,
        );
        expect(error.code).toBe("command_failed");
        expect(handle).toBeDefined();
        expect(yield* handle!.isRunning).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("expires only the initial handshake after six seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const h = yield* harness({
          watchOutput: Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
        });
        const fiber = yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber).pipe(Effect.flip)).code).toBe("timeout");
        expect(h.activeChildren()).toBe(0);
      }),
    ),
  );
  it.effect(
    "decodes split lines and emits ready, changed and resync without collecting a final output",
    () =>
      Effect.gen(function* () {
        const events = [
          watchReady,
          { ...watchReady, seq: 1, status: "changed" },
          { ...watchReady, seq: 3, status: "resync" },
        ];
        const bytes = new TextEncoder().encode(
          events.map((event) => `${encodeJson(event)}\n`).join(""),
        );
        const h = yield* harness({
          watchOutput: Stream.make(bytes.subarray(0, 17), bytes.subarray(17)).pipe(
            Stream.concat(Stream.never),
          ),
        });
        expect(
          yield* h.reader.watch({ threadId, projectId }).pipe(Stream.take(3), Stream.runCollect),
        ).toEqual(events);
        expect(h.activeChildren()).toBe(0);
      }),
  );
  it.effect("terminates the real child it spawned when its stream consumer leaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const executable = path.join(directory, "human-watch");
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}\nprocess.stdout.write('${JSON.stringify(watchReady)}\\n');\nsetInterval(() => {}, 60000);\n`,
        );
        yield* fs.chmod(executable, 0o700);
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let handle: ChildProcessSpawner.ChildProcessHandle | undefined;
        const spawner = ChildProcessSpawner.make((command) =>
          nativeSpawner.spawn(command).pipe(
            Effect.tap((child) =>
              Effect.sync(() => {
                handle = child;
              }),
            ),
          ),
        );
        const h = yield* harness({
          environment: { T3CODE_BRIDGET_EXECUTABLE: executable },
          watchSpawner: spawner,
        });
        const ready = yield* Deferred.make<void>();
        const fiber = yield* h.reader.watch({ threadId, projectId }).pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        expect(handle).toBeDefined();
        expect(handle!.pid).not.toBe(process.pid);
        yield* Fiber.interrupt(fiber);
        expect(yield* handle!.isRunning).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect(
    "uses the server workspace and releases its child on cancellation without timing out accepted streams",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const h = yield* harness({
            watchOutput: Stream.make(watchBytes(watchReady)).pipe(Stream.concat(Stream.never)),
          });
          const fiber = yield* h.reader.watch({ threadId, projectId }).pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          yield* TestClock.adjust("1 minute");
          expect(h.activeChildren()).toBe(1);
          const command = h.watchCalls[0]!;
          expect(command._tag).toBe("StandardCommand");
          if (command._tag === "StandardCommand") {
            expect(command.args).toEqual([
              "thread",
              "watch",
              "--t3-thread",
              threadId,
              "--project-root",
              "/project with spaces/$(forged); é",
              "--json",
            ]);
            expect(command.options.shell).toBe(false);
          }
          expect(h.calls).toEqual([]);
          yield* Fiber.interrupt(fiber);
          expect(h.activeChildren()).toBe(0);
        }),
      ),
  );
  it.effect("checks context before spawning and never trusts a browser root", () =>
    Effect.gen(function* () {
      const h = yield* harness({ differentProject: true });
      expect(
        (yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(Effect.flip)).code,
      ).toBe("project_mismatch");
      expect(h.watchCalls).toEqual([]);
      const forged = { threadId, projectId, projectRoot: "/forged" };
      expect((yield* Stream.runDrain(h.reader.watch(forged)).pipe(Effect.flip)).code).toBe(
        "invalid_request",
      );
    }),
  );
  it.effect(
    "bounds partial JSONL and rejects invalid UTF8, leaked fields and invalid stream ordering",
    () =>
      Effect.gen(function* () {
        const cases = [
          { bytes: new TextEncoder().encode("x".repeat(4097)), code: "output_limit" },
          {
            bytes: new TextEncoder().encode(`${encodeJson(watchReady).padEnd(4096)}\n`),
            code: "output_limit",
          },
          { bytes: new Uint8Array([0xff, 10]), code: "invalid_output" },
          { bytes: watchBytes({ ...watchReady, body: "private" }), code: "invalid_output" },
          { bytes: watchBytes({ ...watchReady, status: "changed" }), code: "invalid_output" },
          { bytes: watchBytes({ ...watchReady, seq: 1 }), code: "invalid_output" },
          { bytes: watchBytes({ ...watchReady, version: 2 }), code: "unsupported_version" },
        ];
        for (const { bytes, code } of cases) {
          const h = yield* harness({ watchOutput: Stream.make(bytes) });
          expect(
            (yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(Effect.flip))
              .code,
          ).toBe(code);
          expect(h.activeChildren()).toBe(0);
        }
        for (const event of [
          watchReady,
          { ...watchReady, seq: 0, status: "changed" },
          { ...watchReady, seq: 1, status: "changed", generation: threadId },
        ]) {
          const h = yield* harness({
            watchOutput: Stream.make(watchBytes(watchReady), watchBytes(event)),
          });
          expect(
            (yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(Effect.flip))
              .code,
          ).toBe("invalid_output");
        }
      }),
  );
  it.effect("preserves closed refusal categories and stops the stream", () =>
    Effect.gen(function* () {
      for (const code of [
        "binding_unavailable",
        "thread_unavailable",
        "storage_unavailable",
        "response_too_large",
      ]) {
        const h = yield* harness({
          watchOutput: Stream.make(watchBytes({ version: 1, status: "error", code })),
        });
        expect(
          (yield* Stream.runDrain(h.reader.watch({ threadId, projectId })).pipe(Effect.flip)).code,
        ).toBe(code);
        expect(h.activeChildren()).toBe(0);
      }
    }),
  );
});

describe("BridgetReader", () => {
  it.effect("rejects recent history bounds unrelated to the requested immutable window", () =>
    Effect.gen(function* () {
      for (const result of [
        { snapshot_seq: 8, through_seq: 5 },
        { snapshot_seq: 9, through_seq: 2 },
        { snapshot_seq: 7, through_seq: 2 },
      ]) {
        const { reader } = yield* harness({
          result: output(
            encodeJson({
              ...envelope,
              result: {
                status: "history_recent",
                thread_id: sharedThreadId,
                entries: [],
                has_more: false,
                next_before_seq: null,
                ...result,
              },
            }),
          ),
        });
        expect(
          (yield* reader
            .read({ ...input, action: "history_recent", sharedThreadId, beforeSeq: 2, toSeq: 8 })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_output");
      }
    }),
  );
  it.effect("rejects recent list results that repeat the requested cursor position", () =>
    Effect.gen(function* () {
      const after = `1791331200:${sharedThreadId}`;
      const { reader } = yield* harness({
        result: output(
          encodeJson({
            ...envelope,
            result: {
              status: "listed_recent",
              threads: [
                {
                  thread_id: sharedThreadId,
                  title: "Recent",
                  creator_id: threadId,
                  state: "open",
                  last_seq: 0,
                  members: [],
                  last_activity_at: 1791331200,
                },
              ],
              next_after: null,
            },
          }),
        ),
      });
      expect(
        (yield* reader.read({ ...input, action: "list_recent", after }).pipe(Effect.flip)).code,
      ).toBe("invalid_output");
    }),
  );
  it.effect("passes recent list cursor as one fixed argument and refuses old listed output", () =>
    Effect.gen(function* () {
      const after = `1791331200:${sharedThreadId}`;
      const recentEnvelope = {
        ...envelope,
        result: { status: "listed_recent", threads: [], next_after: null },
      };
      const { reader, calls } = yield* harness({ result: output(encodeJson(recentEnvelope)) });
      expect(yield* reader.read({ ...input, action: "list_recent", after, limit: 20 })).toEqual(
        recentEnvelope,
      );
      expect(calls[0]?.args.slice(-4)).toEqual(["--limit", "20", "--after", after]);
      expect(calls[0]?.args).toContain("list_recent");
      const legacy = yield* harness();
      expect(
        (yield* legacy.reader.read({ ...input, action: "list_recent" }).pipe(Effect.flip)).code,
      ).toBe("invalid_output");
    }),
  );
  it.effect(
    "passes descending bounds without ASC flags and refuses a mismatched shared thread",
    () =>
      Effect.gen(function* () {
        const recentEnvelope = {
          ...envelope,
          result: {
            status: "history_recent",
            thread_id: sharedThreadId,
            entries: [],
            snapshot_seq: 8,
            through_seq: 5,
            has_more: false,
            next_before_seq: null,
          },
        };
        const { reader, calls } = yield* harness({ result: output(encodeJson(recentEnvelope)) });
        expect(
          yield* reader.read({
            ...input,
            action: "history_recent",
            sharedThreadId,
            limit: 20,
            beforeSeq: 5,
            toSeq: 8,
          }),
        ).toEqual(recentEnvelope);
        expect(calls[0]?.args.slice(-6)).toEqual([
          "--limit",
          "20",
          "--before-seq",
          "5",
          "--to-seq",
          "8",
        ]);
        expect(calls[0]?.args).not.toContain("--from-seq");
        const forged = yield* harness({
          result: output(
            encodeJson({
              ...recentEnvelope,
              result: { ...recentEnvelope.result, thread_id: threadId },
            }),
          ),
        });
        expect(
          (yield* forged.reader
            .read({ ...input, action: "history_recent", sharedThreadId })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_output");
      }),
  );
  it.effect("uses authoritative project root and fixed argv with bounded execution", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness();
      expect(yield* reader.read(input)).toEqual(envelope);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/usr/bin/true",
        args: [
          "thread",
          "inspect",
          "--t3-thread",
          threadId,
          "--project-root",
          "/project with spaces/$(forged); é",
          "--action",
          "list",
          "--json",
        ],
        timeout: "6 seconds",
        maxOutputBytes: 256 * 1024,
        outputMode: "error",
      });
    }),
  );
  it.effect("passes only action-specific paging options", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness({
        result: output(
          encodeJson({
            ...envelope,
            result: {
              status: "history",
              from_seq: 2,
              thread_id: sharedThreadId,
              entries: [],
              snapshot_seq: 8,
              through_seq: 8,
              has_more: false,
              next_from_seq: null,
            },
          }),
        ),
      });
      yield* reader.read({
        threadId,
        projectId,
        action: "history",
        sharedThreadId,
        limit: 20,
        fromSeq: 2,
        toSeq: 8,
      });
      expect(calls[0]?.args).toContain("--thread");
      expect(calls[0]?.args.slice(-6)).toEqual([
        "--limit",
        "20",
        "--from-seq",
        "2",
        "--to-seq",
        "8",
      ]);
    }),
  );
  it.effect.each([{ missingThread: true }, { missingProject: true }, { differentProject: true }])(
    "rejects missing or mismatched environment-local context %j before spawn",
    (scenario) =>
      Effect.gen(function* () {
        const { reader, calls } = yield* harness(scenario);
        const error = yield* reader.read(input).pipe(Effect.flip);
        expect(error.code).toBe(scenario.differentProject ? "project_mismatch" : "context_missing");
        expect(calls).toHaveLength(0);
      }),
  );
  it.effect("rejects injected authority even through a direct service call", () =>
    Effect.gen(function* () {
      const { reader, calls } = yield* harness();
      const error = yield* reader
        .read({ ...input, root: "/forged" } as typeof input)
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_request");
      expect(calls).toHaveLength(0);
    }),
  );
  it.effect("decodes functional refusal JSON on exit 2 without stderr", () =>
    Effect.gen(function* () {
      const refusal = {
        version: 1,
        subject: null,
        result: {
          status: "error",
          code: "binding_unavailable",
          detail: "Binding unavailable",
          retryable: false,
        },
      };
      const { reader } = yield* harness({ result: output(encodeJson(refusal), 2) });
      const view = yield* reader.read(input);
      expect(view).toMatchObject({
        version: 1,
        subject: null,
        result: { status: "error", code: "binding_unavailable", retryable: false },
      });
      expect(encodeJson(view)).not.toContain("private diagnostic");
    }),
  );
  it.effect.each([
    ["JSON", output("invalid json"), "invalid_output"],
    ["version", output(encodeJson({ ...envelope, version: 2 })), "unsupported_version"],
    ["UTF-8", { ...output(), stdoutInvalidUtf8: true }, "invalid_output"],
    ["truncated", { ...output(), stdoutTruncated: true }, "output_limit"],
    ["oversized projection", output(" ".repeat(128 * 1024 + 1)), "output_limit"],
    ["process exit", output("", 1), "command_failed"],
    ["absent daemon", output("", 3), "unavailable"],
  ] as const)("refuses %s and sanitizes diagnostics", ([_name, result, code]) =>
    Effect.gen(function* () {
      const { reader } = yield* harness({ result });
      const error = yield* reader.read(input).pipe(Effect.flip);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("private diagnostic");
      expect(encodeJson(error)).not.toContain("private diagnostic");
    }),
  );
  it.effect("maps timeout and process output limit to distinct fixed errors", () =>
    Effect.gen(function* () {
      for (const [error, code] of [
        [
          new ProcessRunner.ProcessTimeoutError({
            command: "bridget",
            argumentCount: 1,
            timeoutMs: 6000,
          }),
          "timeout",
        ],
        [
          new ProcessRunner.ProcessOutputLimitError({
            command: "bridget",
            argumentCount: 1,
            stream: "stdout",
            maxBytes: 256 * 1024,
            observedBytes: 256 * 1024 + 1,
          }),
          "output_limit",
        ],
      ] as const) {
        const { reader } = yield* harness({ error });
        expect((yield* reader.read(input).pipe(Effect.flip)).code).toBe(code);
      }
    }),
  );
  it.effect("prefers the user binary then falls back to PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(home, ".local/bin"), { recursive: true });
      yield* fs.symlink("/usr/bin/true", path.join(home, ".local/bin/bridget"));
      const user = yield* harness({ environment: { HOME: home, PATH: "/usr/bin" } });
      yield* user.reader.read(input);
      expect(user.calls[0]?.command).toBe(path.join(home, ".local/bin/bridget"));
      const bin = yield* fs.makeTempDirectoryScoped();
      yield* fs.symlink("/usr/bin/true", path.join(bin, "bridget"));
      const fallback = yield* harness({ environment: { HOME: "/absent", PATH: bin } });
      yield* fallback.reader.read(input);
      expect(fallback.calls[0]?.command).toBe(path.join(bin, "bridget"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects cmd and bat executables before starting a process", () =>
    Effect.gen(function* () {
      for (const command of ["/configured/bridget.cmd", "/configured/bridget.BAT"]) {
        const { reader, calls } = yield* harness({
          environment: { T3CODE_BRIDGET_EXECUTABLE: command },
        });
        expect((yield* reader.read(input).pipe(Effect.flip)).code).toBe("unavailable");
        expect(calls).toHaveLength(0);
      }
    }),
  );
  it.effect.each(["configured", "user", "PATH"] as const)(
    "rejects Windows PATHEXT cmd resolution from %s before starting a process",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const directory = source === "user" ? path.join(home, ".local", "bin") : home;
        yield* fs.makeDirectory(directory, { recursive: true });
        const command = path.join(directory, "bridget");
        yield* fs.symlink("/usr/bin/true", `${command}.CMD`);
        const environment = {
          PATHEXT: ".CMD",
          ...(source === "configured" ? { T3CODE_BRIDGET_EXECUTABLE: command } : {}),
          ...(source === "user" ? { HOME: home } : {}),
          ...(source === "PATH" ? { PATH: home } : {}),
        };
        expect(
          yield* resolveCommandPath(source === "PATH" ? "bridget" : command, {
            env: environment,
          }),
        ).toBe(`${command}.CMD`);
        const { reader, calls } = yield* harness({ environment });
        const outcome = yield* reader.read(input).pipe(
          Effect.match({
            onFailure: (error) => error.code,
            onSuccess: () => "success",
          }),
        );
        expect(calls).toHaveLength(0);
        expect(outcome).toBe("unavailable");
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provide(NodeServices.layer),
      ),
  );
});
