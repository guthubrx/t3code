import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { claudeSettingsPaths, findRepositoryRoot } from "./ClaudeSettingsPaths.ts";

describe("SPEC147 Claude settings paths", () => {
  it.effect("shares user/project/local/root sources without consulting root plain settings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.deepEqual(
        claudeSettingsPaths(path, "/home/profile", "/repo/nested", "darwin", {}, "/repo"),
        [
          "/home/profile/settings.json",
          "/repo/nested/.claude/settings.json",
          "/repo/nested/.claude/settings.local.json",
          "/repo/.claude/settings.local.json",
          "/Library/Application Support/ClaudeCode/managed-settings.json",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("accepts NotFound as no repository, not an error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        assert.equal(yield* findRepositoryRoot(home, "strict"), undefined);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  it.effect("fails closed for MCP but retains Skills fail-open on .git permission error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const restricted = FileSystem.FileSystem.of({
        ...fs,
        stat: () => Effect.fail(denied),
        exists: () => Effect.fail(denied),
      });
      const closed = yield* findRepositoryRoot("/repo", "strict").pipe(
        Effect.provideService(FileSystem.FileSystem, restricted),
        Effect.result,
      );
      assert.equal(closed._tag, "Failure");
      assert.equal(
        yield* findRepositoryRoot("/repo", "lenient").pipe(
          Effect.provideService(FileSystem.FileSystem, restricted),
        ),
        undefined,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
