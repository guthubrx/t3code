import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import CodexUsageNativeTurnIndex from "./Migrations/065_CodexUsageNativeTurnIndex.ts";

export const ensureCommandProjectionReadIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Command reads select types and live node metadata before fetching bodies.
  // Only matching bodies are loaded; the multi-type item read still sorts them.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_command_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, type, ordinal, turn_item_id, status, run_id
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_command_idx
    ON orchestration_v2_projection_nodes(
      thread_id, COALESCE(started_at, ''), node_id, kind, status, run_id
    )
  `;
  // The message-order lookup must not decode every historical message body.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_message_order_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message')
  `;
});

// This local build used id 65 before upstream assigned it to Codex usage.
// Apply upstream's migration before normalizing that one known history entry.
export const reconcileLocalCommandReadMigration = Effect.fn("reconcileLocalCommandReadMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
    if (tables.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 65`;
        if (
          !history.some(
            (row) => row.migration_id === 65 && row.name === "CommandProjectionReadIndexes",
          )
        )
          return;
        if (history.length !== 1) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot upgrade local command-read migration 65 with unexpected later migrations.",
          });
        }
        yield* CodexUsageNativeTurnIndex;
        yield* sql`UPDATE effect_sql_migrations SET name = 'CodexUsageNativeTurnIndex' WHERE migration_id = 65 AND name = 'CommandProjectionReadIndexes'`;
      }),
    );
  },
);
