import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Native Skills scopes, including root local but not root plain settings.
 * MCP may add conservative opt-out sources without changing Skills behavior.
 */
export function claudeSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : platform === "win32"
        ? environment.PROGRAMDATA?.trim()
          ? path.join(environment.PROGRAMDATA.trim(), "ClaudeCode", "managed-settings.json")
          : undefined
        : "/etc/claude-code/managed-settings.json";
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/** NotFound is normal. MCP must not treat an inaccessible .git as absent. */
export const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
  policy: "strict" | "lenient" = "lenient",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot =
      policy === "lenient"
        ? yield* fs.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))
        : yield* fs.stat(path.join(current, ".git")).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
    if (isRoot) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});
