import { BridgetReadError } from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** One executable policy for human read, watch and native provider MCP. */
export const resolveBridgetExecutable = Effect.fn("resolveBridgetExecutable")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const configured = environment.T3CODE_BRIDGET_EXECUTABLE?.trim();
  const executable = yield* Effect.gen(function* () {
    if (configured) return yield* resolveCommandPath(configured, { env: environment });
    if (environment.HOME) {
      const userBinary = yield* resolveCommandPath(
        path.join(environment.HOME, ".local", "bin", "bridget"),
        { env: environment },
      ).pipe(Effect.option);
      if (Option.isSome(userBinary)) return userBinary.value;
    }
    return yield* resolveCommandPath("bridget", { env: environment });
  }).pipe(Effect.mapError(() => new BridgetReadError({ code: "unavailable" })));
  if (/\.(cmd|bat)$/i.test(executable)) return yield* new BridgetReadError({ code: "unavailable" });
  return executable;
});
