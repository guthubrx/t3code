import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BridgetHumanView, BridgetReadInput } from "./bridget.ts";

const threadId = "8b09a229-dc14-4b38-91b5-2bf0e2a294ac";
const sharedThreadId = "3503a3ce-cb97-46eb-b17b-339377b0c1ce";
const base = { threadId, projectId: "project-1" };
const decodeInput = Schema.decodeUnknownSync(BridgetReadInput);
const decodeView = Schema.decodeUnknownSync(BridgetHumanView);

describe("Bridget human read contract", () => {
  const recentCursor = `1791331200:${sharedThreadId}`;
  const recentThread = {
    thread_id: sharedThreadId,
    title: "Recent",
    creator_id: threadId,
    state: "open",
    last_seq: 3,
    members: [],
    last_activity_at: 1791331200,
  };
  const recentEntry = (seq: number) => ({
    seq,
    message_id: sharedThreadId,
    author_id: threadId,
    author_name: "Agent",
    created_at: 1791331200,
    body: "  é🙂\nexact body\n",
    notify: { mode: "none", targets: [] },
    reply_to_seq: null,
  });
  const recentHistory = {
    status: "history_recent",
    thread_id: sharedThreadId,
    entries: [recentEntry(3), recentEntry(2)],
    snapshot_seq: 3,
    through_seq: 3,
    has_more: true,
    next_before_seq: 1,
  };
  it("accepts independent recent variants and keeps their exact bodies", () => {
    expect(
      decodeInput({ ...base, action: "list_recent", after: recentCursor, limit: 100 }).action,
    ).toBe("list_recent");
    expect(
      decodeInput({ ...base, action: "history_recent", sharedThreadId, beforeSeq: 0, toSeq: 3 })
        .action,
    ).toBe("history_recent");
    expect(
      decodeView({
        version: 1,
        subject: null,
        result: {
          status: "listed_recent",
          threads: [recentThread],
          next_after: recentCursor,
        },
      }).result.status,
    ).toBe("listed_recent");
    const result = decodeView({ version: 1, subject: null, result: recentHistory }).result;
    expect(result.status === "history_recent" && result.entries[0]?.body).toBe(recentEntry(3).body);
  });
  it.each(["01791331200", "+1791331200", "-1", "9007199254740992", "1791331200 "])(
    "rejects noncanonical or unsafe cursor timestamp %s",
    (timestamp) => {
      expect(() =>
        decodeInput({ ...base, action: "list_recent", after: `${timestamp}:${sharedThreadId}` }),
      ).toThrow();
    },
  );
  it.each([
    { action: "list_recent", after: `${recentCursor}:extra` },
    { action: "list_recent", after: recentCursor.toUpperCase() },
    { action: "list_recent", beforeSeq: 1 },
    { action: "list", after: recentCursor },
    { action: "history_recent", sharedThreadId, fromSeq: 1 },
    { action: "history_recent", sharedThreadId, beforeSeq: -1 },
    { action: "history_recent", sharedThreadId, toSeq: Number.MAX_SAFE_INTEGER + 1 },
    { action: "history_recent", sharedThreadId, socket: "/forged" },
  ])("rejects recent cross-action or injected options %j", (input) => {
    expect(() => decodeInput({ ...base, ...input })).toThrow();
  });
  it.each([
    { entries: [recentEntry(2), recentEntry(3)] },
    { entries: [recentEntry(3), recentEntry(3)] },
    { through_seq: 2 },
    { through_seq: 4 },
    { next_before_seq: 2 },
    { next_before_seq: null },
    { has_more: false },
    { entries: [] },
    { entries: [recentEntry(1)], next_before_seq: 0 },
  ])("rejects incoherent recent pagination %j", (change) => {
    expect(() =>
      decodeView({ version: 1, subject: null, result: { ...recentHistory, ...change } }),
    ).toThrow();
  });
  it("accepts terminal sequence one and an empty zero-bound page without continuation", () => {
    for (const change of [
      { entries: [recentEntry(1)] },
      { entries: [], snapshot_seq: 0, through_seq: 0 },
    ])
      expect(
        decodeView({
          version: 1,
          subject: null,
          result: {
            ...recentHistory,
            ...change,
            has_more: false,
            next_before_seq: null,
          },
        }).result.status,
      ).toBe("history_recent");
  });
  it("accepts an exhausted sparse history without inventing older rows", () => {
    expect(
      decodeView({
        version: 1,
        subject: null,
        result: {
          ...recentHistory,
          entries: [recentEntry(5)],
          snapshot_seq: 5,
          through_seq: 5,
          has_more: false,
          next_before_seq: null,
        },
      }).result.status,
    ).toBe("history_recent");
  });
  it("rejects missing activity, out-of-order lists and a cursor unrelated to the emitted page", () => {
    for (const change of [
      { threads: [{ ...recentThread, last_activity_at: undefined }] },
      { threads: [{ ...recentThread, last_activity_at: Number.MAX_SAFE_INTEGER + 1 }] },
      {
        threads: [
          recentThread,
          { ...recentThread, thread_id: threadId, last_activity_at: 1791331201 },
        ],
      },
      { threads: [recentThread, recentThread] },
      { next_after: `1791331201:${sharedThreadId}` },
      { threads: [] },
    ])
      expect(() =>
        decodeView({
          version: 1,
          subject: null,
          result: {
            status: "listed_recent",
            threads: [recentThread],
            next_after: recentCursor,
            ...change,
          },
        }),
      ).toThrow();
  });
  it("accepts equal activity UUID ASC and rejects UUID DESC", () => {
    const second = { ...recentThread, thread_id: threadId };
    const result = {
      status: "listed_recent",
      threads: [recentThread, second],
      next_after: `1791331200:${threadId}`,
    };
    expect(decodeView({ version: 1, subject: null, result }).result.status).toBe("listed_recent");
    expect(() =>
      decodeView({
        version: 1,
        subject: null,
        result: { ...result, threads: [second, recentThread], next_after: null },
      }),
    ).toThrow();
  });
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
