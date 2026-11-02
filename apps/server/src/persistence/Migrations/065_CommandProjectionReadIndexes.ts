import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Command reads select types and live node metadata before fetching bodies.
  // Only matching bodies are loaded; the multi-type item read still sorts them.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_command_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, type, ordinal, turn_item_id, status, run_id
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_command_idx
    ON orchestration_v2_projection_nodes(
      thread_id, COALESCE(started_at, ''), node_id, kind, status, run_id
    )
  `;
  // The message-order lookup must not decode every historical message body.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_message_order_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message')
  `;
});
