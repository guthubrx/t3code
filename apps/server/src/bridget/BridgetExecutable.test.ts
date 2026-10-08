import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveBridgetExecutable } from "./BridgetExecutable.ts";

describe("SPEC147 Bridget executable", () => {
  it.effect("shares explicit > user binary > PATH priority and refuses cmd/bat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const userDir = path.join(home, ".local", "bin");
        const pathDir = path.join(home, "path");
        yield* fs.makeDirectory(userDir, { recursive: true });
        yield* fs.makeDirectory(pathDir);
        for (const file of [
          path.join(userDir, "bridget"),
          path.join(pathDir, "bridget"),
          path.join(home, "bridget.cmd"),
          path.join(home, "bridget.bat"),
        ]) {
          yield* fs.writeFileString(file, "fixture");
          yield* fs.chmod(file, 0o700);
        }
        const environment = { HOME: home, PATH: pathDir };
        assert.equal(
          yield* resolveBridgetExecutable({
            ...environment,
            T3CODE_BRIDGET_EXECUTABLE: "/usr/bin/true",
          }),
          "/usr/bin/true",
        );
        assert.equal(yield* resolveBridgetExecutable(environment), path.join(userDir, "bridget"));
        assert.equal(
          yield* resolveBridgetExecutable({ PATH: pathDir }),
          path.join(pathDir, "bridget"),
        );
        for (const extension of ["cmd", "bat"])
          assert.equal(
            (yield* resolveBridgetExecutable({
              ...environment,
              T3CODE_BRIDGET_EXECUTABLE: path.join(home, `bridget.${extension}`),
            }).pipe(Effect.result))._tag,
            "Failure",
          );
        assert.equal(
          (yield* resolveBridgetExecutable({
            ...environment,
            T3CODE_BRIDGET_EXECUTABLE: path.join(home, "absent"),
          }).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
