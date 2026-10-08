import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  } = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const snapshots = ProjectionSnapshotQuery.of({
    getThreadShellById: () =>
      Effect.succeed(
        options.missingThread
          ? Option.none()
          : Option.some({
              id: threadId,
              projectId: options.differentProject ? ProjectId.make("another-project") : projectId,
            } as OrchestrationThreadShell),
      ),
    getProjectShellById: () =>
      Effect.succeed(
        options.missingProject
          ? Option.none()
          : Option.some({
              id: projectId,
              workspaceRoot: "/project with spaces/$(forged); é",
            } as OrchestrationProjectShell),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"]);
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
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshots)),
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
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
  return { reader, calls };
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
  for (const scenario of [
    { missingThread: true },
    { missingProject: true },
    { differentProject: true },
  ]) {
    it.effect(
      `rejects missing or mismatched environment-local context ${JSON.stringify(scenario)} before spawn`,
      () =>
        Effect.gen(function* () {
          const { reader, calls } = yield* harness(scenario);
          const error = yield* reader.read(input).pipe(Effect.flip);
          expect(error.code).toBe(
            scenario.differentProject ? "project_mismatch" : "context_missing",
          );
          expect(calls).toHaveLength(0);
        }),
    );
  }
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
  for (const [name, result, code] of [
    ["JSON", output("invalid json"), "invalid_output"],
    ["version", output(encodeJson({ ...envelope, version: 2 })), "unsupported_version"],
    ["UTF-8", { ...output(), stdoutInvalidUtf8: true }, "invalid_output"],
    ["truncated", { ...output(), stdoutTruncated: true }, "output_limit"],
    ["oversized projection", output(" ".repeat(128 * 1024 + 1)), "output_limit"],
    ["process exit", output("", 1), "command_failed"],
    ["absent daemon", output("", 3), "unavailable"],
  ] as const) {
    it.effect(`refuses ${name} and sanitizes diagnostics`, () =>
      Effect.gen(function* () {
        const { reader } = yield* harness({ result });
        const error = yield* reader.read(input).pipe(Effect.flip);
        expect(error.code).toBe(code);
        expect(error.message).not.toContain("private diagnostic");
        expect(encodeJson(error)).not.toContain("private diagnostic");
      }),
    );
  }
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
  for (const source of ["configured", "user", "PATH"] as const) {
    it.effect(
      `rejects Windows PATHEXT cmd resolution from ${source} before starting a process`,
      () =>
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
  }
});
