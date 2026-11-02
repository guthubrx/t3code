import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureCommandProjectionReadIndexes } from "./CommandProjectionReadIndexes.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const setupLocalDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 64 });
  yield* ensureCommandProjectionReadIndexes;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    VALUES (65, 'CommandProjectionReadIndexes', '2026-11-02 00:00:00')`;
});

describe("local command-read migration compatibility", () => {
  it.effect("upgrades the installed local history without skipping upstream migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setupLocalDatabase;
      yield* runMigrations();
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      const timestamps = yield* sql<{
        readonly created_at: string;
      }>`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 65`;
      assert.strictEqual(timestamps[0]?.created_at, "2026-11-02 00:00:00");
      const indexes = yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
        'orchestration_v2_projection_turn_items_command_idx',
        'orchestration_v2_projection_nodes_command_idx',
        'orchestration_v2_projection_turn_items_message_order_idx',
        'orchestration_v2_provider_turns_codex_native_id_idx')`;
      assert.strictEqual(indexes.length, 4);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back the upstream index if normalizing local history fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setupLocalDatabase;
      yield* sql`CREATE TRIGGER fail_local_upgrade BEFORE UPDATE ON effect_sql_migrations
        WHEN OLD.migration_id = 65 BEGIN SELECT RAISE(ABORT, 'simulated upgrade failure'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      const legacy = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 65`;
      assert.strictEqual(legacy[0]?.name, "CommandProjectionReadIndexes");
      const indexes =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_provider_turns_codex_native_id_idx'`;
      assert.strictEqual(indexes.length, 0);
      yield* sql`DROP TRIGGER fail_local_upgrade`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves an unrecognized later history unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setupLocalDatabase;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (66, 'OtherLocalMigration')`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
