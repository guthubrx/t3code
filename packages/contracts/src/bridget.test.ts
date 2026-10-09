import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BridgetHumanView, BridgetReadInput } from "./bridget.ts";

const threadId = "8b09a229-dc14-4b38-91b5-2bf0e2a294ac";
const sharedThreadId = "3503a3ce-cb97-46eb-b17b-339377b0c1ce";
const base = { threadId, projectId: "project-1" };
const decodeInput = Schema.decodeUnknownSync(BridgetReadInput);
const decodeView = Schema.decodeUnknownSync(BridgetHumanView);

describe("Bridget human read contract", () => {
  it("accepts the three bounded read actions", () => {
    expect(decodeInput({ ...base, action: "list", limit: 100 })).toMatchObject({ action: "list" });
    expect(decodeInput({ ...base, action: "show", sharedThreadId })).toMatchObject({
      action: "show",
    });
    expect(
      decodeInput({ ...base, action: "history", sharedThreadId, limit: 200, fromSeq: 1, toSeq: 2 }),
    ).toMatchObject({ action: "history" });
  });

  it.each(["root", "agentId", "socket", "command", "credentials", "environmentId"])(
    "refuses browser-selected authority: %s",
    (field) => {
      expect(() => decodeInput({ ...base, action: "list", [field]: "/forged" })).toThrow();
    },
  );

  it.each([
    { action: "read" },
    { action: "list", limit: 0 },
    { action: "list", limit: 101 },
    { action: "list", fromSeq: 1 },
    { action: "show" },
    { action: "show", sharedThreadId: "forged" },
    { action: "history", sharedThreadId, limit: 201 },
    { action: "history", sharedThreadId, fromSeq: 0 },
    { action: "history", sharedThreadId, fromSeq: 3, toSeq: 2 },
  ])("refuses invalid or cross-action options %j", (input) => {
    expect(() => decodeInput({ ...base, ...input })).toThrow();
  });

  it("preserves exact Unicode bodies and legacy nullable fields", () => {
    const body = "  Ligne é🙂\n\tseconde ligne\n";
    const view = decodeView({
      version: 1,
      subject: { agent_id: threadId, name: null },
      result: {
        status: "history",
        from_seq: 1,
        thread_id: sharedThreadId,
        entries: [
          {
            seq: 1,
            message_id: sharedThreadId,
            author_id: threadId,
            author_name: null,
            created_at: 1791331200,
            body,
            notify: { mode: "all", targets: [] },
            reply_to_seq: null,
            kind: null,
            supersedes_seq: null,
            superseded_by_seq: null,
          },
        ],
        snapshot_seq: 1,
        through_seq: 1,
        has_more: false,
        next_from_seq: null,
      },
    });
    expect(view.result.status === "history" && view.result.entries[0]?.body).toBe(body);
  });

  it("rejects unsupported versions and agent-only projection fields", () => {
    const view = {
      version: 1,
      subject: null,
      result: {
        status: "error",
        code: "binding_unavailable",
        detail: "Unavailable",
        retryable: false,
      },
    };
    expect(decodeView(view).result.status).toBe("error");
    expect(() => decodeView({ ...view, version: 2 })).toThrow();
    expect(() => decodeView({ ...view, credentials: "secret" })).toThrow();
    expect(() => decodeView({ ...view, result: { ...view.result, own_acked_seq: 1 } })).toThrow();
    expect(() => decodeView({ ...view, result: { ...view.result, code: "unknown" } })).toThrow();
  });
});
