import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  applySidebarThreadDrop,
  executeSidebarThreadDrop,
  shouldReleaseSidebarThreadDrop,
  type SidebarThreadDrop,
  type SidebarSection,
} from "./Sidebar.logic";
import { makeThreadFixture } from "../test-fixtures";

const now = "2026-10-03T05:00:00.000Z";
const success = AsyncResult.success(undefined);
const error = new Error("Disconnected");
const refs = ["a", "b", "c"].map((id, index) => ({
  environmentId: EnvironmentId.make(index === 1 ? "remote" : "local"),
  threadId: ThreadId.make(id),
}));
const keys = refs.map(scopedThreadKey);

function fixture(
  section: SidebarThreadDrop["section"] = "settled",
  source: SidebarSection = "active",
) {
  const threads = new Map(
    refs.map((ref) => [
      scopedThreadKey(ref),
      source === "settled"
        ? applySidebarThreadDrop(
            makeThreadFixture({ id: ref.threadId, environmentId: ref.environmentId }),
            "settled",
            now,
          )
        : makeThreadFixture({ id: ref.threadId, environmentId: ref.environmentId }),
    ]),
  );
  const members = keys.map((key) => ({
    key,
    section: source,
    pinned: false,
    settled: source === "settled",
  }));
  const makeDrop = (): SidebarThreadDrop => ({
    sourceSections: new Map(keys.map((key) => [key, source])),
    writesPending: true,
    section,
    occurredAt: now,
    clearsSnooze: true,
    order: section === "settled" ? null : keys,
    keysAtDrop: new Map(),
    assignedKeys:
      section === "settled" ? new Map() : new Map(keys.map((key, i) => [key, ["g", "m", "t"][i]!])),
  });
  const drop = makeDrop();
  const state = {
    preview: drop as SidebarThreadDrop | null,
    settling: new Set<string>(),
    errors: [] as Array<{ title: string; error: unknown }>,
    calls: [] as Array<{ operation: string; ref: ScopedThreadRef }>,
    events: [] as Array<() => void>,
    deferEvents: false,
    completions: 0,
    respond: async (
      _operation: string,
      _key: string,
    ): Promise<AtomCommandResult<unknown, unknown>> => success,
  };
  const command = async (operation: string, ref: ScopedThreadRef, orderKey?: string) => {
    const key = scopedThreadKey(ref);
    state.calls.push({ operation, ref });
    const result = await state.respond(operation, key);
    if (result._tag !== "Success") return result;
    const commit = () => {
      const thread = threads.get(key)!;
      switch (operation) {
        case "settle":
          threads.set(key, applySidebarThreadDrop(thread, "settled", now));
          break;
        case "pin":
          threads.set(key, applySidebarThreadDrop(thread, "pinned", now, orderKey));
          break;
        case "unpin":
          threads.set(key, { ...thread, pinnedAt: null, pinOrderKey: null });
          break;
        case "unsettle":
          threads.set(key, {
            ...thread,
            settledOverride: "active",
            settledAt: null,
            unsettledAt: now,
          });
          break;
        case "unsnooze":
          threads.set(key, { ...thread, snoozedAt: null, snoozedUntil: null });
          break;
        case "reorder-active":
          threads.set(key, { ...thread, activeOrderKey: orderKey! });
          break;
        case "reorder-pinned":
          threads.set(key, { ...thread, pinOrderKey: orderKey! });
          break;
      }
    };
    if (state.deferEvents) state.events.push(commit);
    else commit();
    return result;
  };
  const execute = (currentDrop = drop) =>
    executeSidebarThreadDrop({
      drop: currentDrop,
      movingThreads: members,
      threadByKey: threads,
      assignments: [...currentDrop.assignedKeys].map(([id, orderKey]) => ({ id, orderKey })),
      settlingThreadKeys: state.settling,
      setOptimisticDrop: (update) => {
        state.preview = update(state.preview);
      },
      reportFailure: (title, failure) => {
        state.errors.push({ title, error: failure });
      },
      onSuccess: () => {
        state.completions += 1;
      },
      actions: {
        settleThread: (ref) => command("settle", ref),
        pinThread: (ref, options) => command("pin", ref, options.orderKey),
        unpinThread: (ref) => command("unpin", ref),
        unsettleThread: (ref) => command("unsettle", ref),
        unsnoozeThread: (ref) => command("unsnooze", ref),
        reorderActiveThread: (ref, key) => command("reorder-active", ref, key),
        reorderPinnedThread: (ref, key) => command("reorder-pinned", ref, key),
      },
    });
  const reconcile = (currentDrop = state.preview) =>
    currentDrop !== null &&
    shouldReleaseSidebarThreadDrop({
      drop: currentDrop,
      threadByKey: threads,
      pinnedKeys: section === "pinned" ? keys : [],
      activeKeys: section === "active" ? keys : [],
      now,
    });
  return { state, threads, members, drop, makeDrop, execute, reconcile };
}

describe("005 sidebar drop execution and confirmation", () => {
  it.each(["failure", "rejection", "interruption"] as const)(
    "keeps earlier confirmations, stops the batch and allows retry after %s",
    async (mode) => {
      const f = fixture();
      f.state.respond = async (_operation, key) => {
        if (key !== keys[1]) return success;
        if (mode === "rejection") throw error;
        return AsyncResult.failure(mode === "interruption" ? Cause.interrupt() : Cause.fail(error));
      };
      await f.execute();
      expect(keys.map((key) => f.threads.get(key)!.settledOverride)).toEqual([
        "settled",
        null,
        null,
      ]);
      expect(f.state.calls.map(({ ref }) => scopedThreadKey(ref))).toEqual(keys.slice(0, 2));
      expect(f.state.preview).toBeNull();
      expect(f.state.settling.size).toBe(0);
      expect(f.state.completions).toBe(0);
      expect(f.state.errors).toHaveLength(mode === "interruption" ? 0 : 1);

      f.state.respond = async () => success;
      const retry = f.makeDrop();
      f.state.preview = retry;
      await f.execute(retry);
      expect(keys.every((key) => f.threads.get(key)!.settledOverride === "settled")).toBe(true);
      expect(f.state.settling.size).toBe(0);
      expect(f.reconcile()).toBe(true);
    },
  );

  it("holds every member until delayed lifecycle confirmations arrive", async () => {
    const f = fixture();
    f.state.deferEvents = true;
    await f.execute();
    expect(f.state.preview?.writesPending).toBe(false);
    expect(f.reconcile()).toBe(false);
    f.state.events.shift()!();
    expect(f.reconcile()).toBe(false);
    f.state.events.shift()!();
    expect(f.reconcile()).toBe(false);
    f.state.events.shift()!();
    expect(f.reconcile()).toBe(true);
    expect(f.state.calls.map(({ ref }) => ref)).toEqual(refs);
  });

  it("holds a moved active block until the last order-key event arrives", async () => {
    const f = fixture("active", "settled");
    f.state.deferEvents = true;
    await f.execute();
    // Unsettle receipts and order receipts can precede the shell subscription.
    expect(f.state.events).toHaveLength(6);
    for (let index = 0; index < 5; index += 1) {
      f.state.events.shift()!();
      expect(f.reconcile()).toBe(false);
    }
    f.state.events.shift()!();
    expect(f.reconcile()).toBe(true);
    expect(keys.map((key) => f.threads.get(key)!.activeOrderKey)).toEqual(["g", "m", "t"]);
  });

  it("does not duplicate order writes for fresh pins with their assigned keys", async () => {
    const f = fixture("pinned");
    await f.execute();
    expect(keys.map((key) => f.threads.get(key)!.pinOrderKey)).toEqual(["g", "m", "t"]);
    expect(f.state.calls.map(({ operation }) => operation)).toEqual(["pin", "pin", "pin"]);
    expect(f.reconcile()).toBe(true);
  });

  it("stops an order-write failure and releases the projected placement", async () => {
    const f = fixture("active");
    f.state.respond = async (_operation, key) =>
      key === keys[1] ? AsyncResult.failure(Cause.fail(error)) : success;
    await f.execute();
    expect(keys.map((key) => f.threads.get(key)!.activeOrderKey)).toEqual(["g", null, null]);
    expect(f.state.preview).toBeNull();
    expect(f.state.errors).toHaveLength(1);
    expect(f.state.completions).toBe(0);
  });

  it("returns a mixed pinned, settled and snoozed selection to active", async () => {
    const f = fixture("active");
    f.members[0]!.section = "pinned";
    f.members[0]!.pinned = true;
    f.threads.set(keys[0]!, applySidebarThreadDrop(f.threads.get(keys[0]!)!, "pinned", now));
    f.members[1]!.section = "settled";
    f.members[1]!.settled = true;
    f.threads.set(keys[1]!, applySidebarThreadDrop(f.threads.get(keys[1]!)!, "settled", now));
    f.members[2]!.section = "snoozed";
    f.members[2]!.pinned = true;
    f.members[2]!.settled = true;
    f.threads.set(keys[2]!, {
      ...applySidebarThreadDrop(f.threads.get(keys[2]!)!, "settled", now),
      pinnedAt: now,
      snoozedAt: now,
      snoozedUntil: "2026-10-04T05:00:00.000Z",
    });
    const drop = {
      ...f.drop,
      sourceSections: new Map(f.members.map(({ key, section }) => [key, section])),
    };
    f.state.preview = drop;
    await f.execute(drop);
    expect(
      keys.map((key) => {
        const thread = f.threads.get(key)!;
        return [thread.pinnedAt, thread.snoozedUntil, thread.activeOrderKey];
      }),
    ).toEqual([
      [null, null, "g"],
      [null, null, "m"],
      [null, null, "t"],
    ]);
    expect(f.state.calls.map(({ operation }) => operation)).toEqual([
      "unpin",
      "unsettle",
      "unpin",
      "unsettle",
      "unsnooze",
      "reorder-active",
      "reorder-active",
      "reorder-active",
    ]);
    expect(f.reconcile()).toBe(true);
  });

  it("does not release a newer preview after an older batch succeeds", async () => {
    const f = fixture();
    let complete!: (result: AtomCommandResult<unknown, unknown>) => void;
    const receipt = new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
      complete = resolve;
    });
    f.state.respond = async (_operation, key) => (key === keys[0] ? receipt : success);
    const pending = f.execute();
    const newer = f.makeDrop();
    f.state.preview = newer;
    complete(success);
    await pending;
    expect(f.state.preview).toBe(newer);
    expect(f.state.preview?.writesPending).toBe(true);
  });

  it.each(["membership", "foreign-order"] as const)(
    "releases a confirmed placement on %s change",
    async (change) => {
      const f = fixture("pinned");
      await f.execute();
      const drop = f.state.preview!;
      if (change === "foreign-order") {
        f.threads.set(keys[1]!, { ...f.threads.get(keys[1]!)!, pinOrderKey: "z" });
        expect(f.reconcile()).toBe(true);
      } else {
        expect(
          shouldReleaseSidebarThreadDrop({
            drop,
            threadByKey: f.threads,
            pinnedKeys: keys.slice(0, 2),
            activeKeys: [],
            now,
          }),
        ).toBe(true);
      }
    },
  );

  it("waits for each receipt rather than dispatching the whole selection", async () => {
    const f = fixture();
    let complete!: (result: AtomCommandResult<unknown, unknown>) => void;
    const receipt = new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
      complete = resolve;
    });
    f.state.respond = async (_operation, key) => (key === keys[0] ? receipt : success);
    const pending = f.execute();
    expect(f.state.calls).toHaveLength(1);
    expect(f.reconcile()).toBe(false);
    complete(success);
    await pending;
    expect(f.state.calls).toHaveLength(3);
    expect(f.reconcile()).toBe(true);
  });

  it("cannot clear a newer projection when an old receipt fails", async () => {
    const f = fixture();
    let complete!: (result: AtomCommandResult<unknown, unknown>) => void;
    f.state.respond = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = f.execute();
    const newer = f.makeDrop();
    f.state.preview = newer;
    complete(AsyncResult.failure(Cause.fail(error)));
    await pending;
    expect(f.state.preview).toBe(newer);
    expect(f.state.settling.size).toBe(0);
  });

  it("clears an old cloned projection on a rejected promise", async () => {
    const f = fixture();
    let reject!: (reason: unknown) => void;
    f.state.respond = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const pending = f.execute();
    f.state.preview = { ...f.drop, writesPending: false };
    reject(error);
    await pending;
    expect(f.state.preview).toBeNull();
    expect(f.state.settling.size).toBe(0);
    expect(f.state.errors[0]?.error).toBe(error);
  });

  it.each(["missing", "archived", "foreign-section"] as const)(
    "releases the preview when a member is %s after the receipts",
    (change) => {
      const f = fixture("pinned");
      const completed = { ...f.drop, writesPending: false };
      if (change === "missing") f.threads.delete(keys[1]!);
      else if (change === "archived")
        f.threads.set(keys[1]!, { ...f.threads.get(keys[1]!)!, archivedAt: now });
      else
        f.threads.set(keys[1]!, applySidebarThreadDrop(f.threads.get(keys[1]!)!, "settled", now));
      expect(f.reconcile(completed)).toBe(true);
    },
  );
});
