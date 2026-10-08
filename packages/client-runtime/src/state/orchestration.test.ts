import {
  BridgetReadError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type BridgetHumanView,
  type BridgetReadInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";

const isBridgetReadError = Schema.is(BridgetReadError);

it.effect("routes human reads by environment and refreshes only the selected atom", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<{ environmentId: string; input: BridgetReadInput }> = [];
      let refusal = false;
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      for (const id of ["environment-a", "environment-b"]) {
        const environmentId = EnvironmentId.make(id);
        const session = {
          client: {
            [WS_METHODS.bridgetRead]: (input: BridgetReadInput) =>
              Effect.suspend(() => {
                calls.push({ environmentId, input });
                return refusal
                  ? Effect.fail(new BridgetReadError({ code: "context_missing" }))
                  : Effect.succeed({
                      version: 1,
                      subject: null,
                      result: { status: "listed", threads: [], next_after: null },
                    } satisfies BridgetHumanView);
              }),
          },
        } as unknown as RpcSession;
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: id,
              httpBaseUrl: `https://${id}.test`,
              wsBaseUrl: `wss://${id}.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const run: EnvironmentRegistry["Service"]["run"] = (id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisors.get(id)!);
      const followStream: EnvironmentRegistry["Service"]["followStream"] = (id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(id)!);
      const stateChanges: EnvironmentRegistry["Service"]["stateChanges"] = (id) =>
        SubscriptionRef.changes(supervisors.get(id)!.state);
      const registryService = EnvironmentRegistry.of({
        run,
        followStream,
        stateChanges,
      } as unknown as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));
      const family = createOrchestrationEnvironmentAtoms(runtime).bridgetRead;
      const input = {
        threadId: ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac"),
        projectId: ProjectId.make("project"),
        action: "list",
      } as const;
      const atomA = family({ environmentId: EnvironmentId.make("environment-a"), input });
      const atomB = family({ environmentId: EnvironmentId.make("environment-b"), input });
      const registry = AtomRegistry.make();
      const unmountA = registry.mount(atomA);
      const unmountB = registry.mount(atomB);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unmountA();
          unmountB();
          registry.dispose();
        }),
      );
      yield* AtomRegistry.getResult(registry, atomA, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, atomB, { suspendOnWaiting: true });
      expect(calls.map((call) => call.environmentId).sort()).toEqual([
        "environment-a",
        "environment-b",
      ]);
      for (const call of calls) expect(call.input).toEqual(input);
      registry.refresh(atomA);
      yield* AtomRegistry.getResult(registry, atomA, { suspendOnWaiting: true });
      expect(calls.filter((call) => call.environmentId === "environment-a")).toHaveLength(2);
      expect(calls.filter((call) => call.environmentId === "environment-b")).toHaveLength(1);
      refusal = true;
      registry.refresh(atomA);
      const error = yield* AtomRegistry.getResult(registry, atomA, { suspendOnWaiting: true }).pipe(
        Effect.flip,
      );
      expect(isBridgetReadError(error)).toBe(true);
    }),
  ),
);

it.effect(
  "refreshes a pending native query after A to B to A and discards its late old response",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("pending-refresh-environment");
        const threadA = ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac");
        const threadB = ThreadId.make("3503a3ce-cb97-46eb-b17b-339377b0c1ce");
        const oldResponse = yield* Deferred.make<BridgetHumanView>();
        const newResponse = yield* Deferred.make<BridgetHumanView>();
        const oldStarted = yield* Deferred.make<void>();
        const newStarted = yield* Deferred.make<void>();
        const oldSettled = yield* Deferred.make<void>();
        const calls: ThreadId[] = [];
        const view = (name: string): BridgetHumanView => ({
          version: 1,
          subject: { agent_id: threadA, name },
          result: { status: "listed", threads: [], next_after: null },
        });
        let aCalls = 0;
        const session = {
          client: {
            [WS_METHODS.bridgetRead]: (input: BridgetReadInput) =>
              Effect.gen(function* () {
                calls.push(input.threadId);
                if (input.threadId === threadB) return view("B");
                aCalls += 1;
                if (aCalls === 1) {
                  yield* Deferred.succeed(oldStarted, undefined);
                  // Simulate an RPC response that can complete after its caller was cancelled.
                  return yield* Deferred.await(oldResponse).pipe(
                    Effect.uninterruptible,
                    Effect.ensuring(Deferred.succeed(oldSettled, undefined)),
                  );
                }
                yield* Deferred.succeed(newStarted, undefined);
                return yield* Deferred.await(newResponse);
              }),
          },
        } as unknown as RpcSession;
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Pending refresh",
            httpBaseUrl: "https://pending.test",
            wsBaseUrl: "wss://pending.test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor);
        const stateChanges: EnvironmentRegistry["Service"]["stateChanges"] = () =>
          SubscriptionRef.changes(supervisor.state);
        const registryService = EnvironmentRegistry.of({
          run,
          followStream,
          stateChanges,
        } as unknown as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));
        const family = createOrchestrationEnvironmentAtoms(runtime).bridgetRead;
        const inputA = {
          threadId: threadA,
          projectId: ProjectId.make("project"),
          action: "list",
        } as const;
        const inputB = { ...inputA, threadId: threadB };
        const atomA = family({ environmentId, input: inputA });
        const atomB = family({ environmentId, input: inputB });
        const registry = AtomRegistry.make();
        const publishedA: Array<string | null | undefined> = [];
        const unsubscribe = registry.subscribe(
          atomA,
          (result) => {
            if (AsyncResult.isSuccess(result)) publishedA.push(result.value.subject?.name);
          },
          { immediate: true },
        );
        let unmount = registry.mount(atomA);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unmount();
            unsubscribe();
            registry.dispose();
          }),
        );
        yield* Deferred.await(oldStarted);
        unmount();
        unmount = registry.mount(atomB);
        expect(
          (yield* AtomRegistry.getResult(registry, atomB, { suspendOnWaiting: true })).subject
            ?.name,
        ).toBe("B");
        unmount();
        unmount = registry.mount(atomA);
        registry.refresh(atomA);
        yield* Deferred.await(newStarted);
        yield* Deferred.succeed(newResponse, view("new A"));
        expect(
          (yield* AtomRegistry.getResult(registry, atomA, { suspendOnWaiting: true })).subject
            ?.name,
        ).toBe("new A");
        yield* Deferred.succeed(oldResponse, view("old A"));
        yield* Deferred.await(oldSettled);
        expect(
          (yield* AtomRegistry.getResult(registry, atomA, { suspendOnWaiting: true })).subject
            ?.name,
        ).toBe("new A");
        expect(publishedA).not.toContain("old A");
        expect(publishedA).toContain("new A");
        expect(calls).toEqual([threadA, threadB, threadA]);
      }),
    ),
);
