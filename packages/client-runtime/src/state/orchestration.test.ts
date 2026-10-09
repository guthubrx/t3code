import {
  BridgetReadError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type BridgetHumanView,
  type BridgetReadInput,
  type BridgetWatchEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/rpc";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
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
import { executeAtomQuery, isAtomCommandInterrupted } from "./runtime.ts";

const isBridgetReadError = Schema.is(BridgetReadError);

const makeHumanRuntime = Effect.fn("HumanRuntimeTest.make")(function* (
  client: RpcSession["client"],
) {
  const environmentId = EnvironmentId.make("human-watch-environment");
  const session = yield* SubscriptionRef.make(Option.some({ client } as RpcSession));
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Human watch",
      httpBaseUrl: "https://human.test",
      wsBaseUrl: "wss://human.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const service = EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
  } as unknown as EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createOrchestrationEnvironmentAtoms(
    Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry, service),
        Layer.succeed(Clock.Clock, yield* Clock.Clock),
      ),
    ),
  );
  const input = {
    threadId: ThreadId.make("8b09a229-dc14-4b38-91b5-2bf0e2a294ac"),
    projectId: ProjectId.make("project"),
  };
  return { registry, atoms, session, target: { environmentId, input, visitId: "test-visit" } };
});

it.effect(
  "keeps handshake proof when ready and changed arrive before the consumer sees the latest atom value",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emitted = yield* Deferred.make<void>();
        const ready: BridgetWatchEvent = {
          version: 1,
          generation: "10000000-0000-4000-8000-000000000001",
          seq: 0,
          status: "ready",
        };
        const changed: BridgetWatchEvent = { ...ready, status: "changed", seq: 1 };
        const h = yield* makeHumanRuntime({
          [WS_METHODS.bridgetWatch]: () =>
            Stream.make(ready, changed).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
        } as unknown as RpcSession["client"]);
        const first = h.atoms.bridgetWatch({ ...h.target, visitId: "visit-a-1" });
        const unmount = h.registry.mount(first);
        yield* Deferred.await(emitted);
        const state = yield* AtomRegistry.getResult(h.registry, first);
        expect(state.event).toEqual(changed);
        expect(state.readyGeneration).toBe(ready.generation);
        expect(typeof state.subscriptionId).toBe("symbol");
        expect(h.atoms.bridgetWatch({ ...h.target, visitId: "visit-a-2" })).not.toBe(first);
        unmount();
      }),
    ),
);

it.effect("cancels an imperative read on abort and starts a fresh read on returning to A", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let calls = 0;
      const view: BridgetHumanView = {
        version: 1,
        subject: null,
        result: { status: "listed", threads: [], next_after: null },
      };
      const h = yield* makeHumanRuntime({
        [WS_METHODS.bridgetRead]: () =>
          Effect.suspend(() => {
            calls += 1;
            return calls === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                )
              : Effect.succeed(view);
          }),
      } as unknown as RpcSession["client"]);
      const target = { ...h.target, input: { ...h.target.input, action: "list" as const } };
      const controller = new AbortController();
      const pending = executeAtomQuery(h.registry, h.atoms.bridgetRead(target), {
        refresh: true,
        signal: controller.signal,
        reportFailure: false,
      });
      yield* Deferred.await(started);
      controller.abort();
      expect(isAtomCommandInterrupted(yield* Effect.promise(() => pending))).toBe(true);
      // Wait on the read's release receipt; a warm idle cache would retain the RPC.
      yield* Deferred.await(stopped);
      expect(
        (yield* Effect.promise(() =>
          executeAtomQuery(h.registry, h.atoms.bridgetRead(target), { refresh: true }),
        ))._tag,
      ).toBe("Success");
      expect(calls).toBe(2);
    }),
  ),
);

it.effect("performs one fresh RPC per consecutive zero-idle human read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* makeHumanRuntime({
        [WS_METHODS.bridgetRead]: () =>
          Effect.sync(() => {
            calls += 1;
            return {
              version: 1,
              subject: null,
              result: { status: "listed", threads: [], next_after: null },
            } satisfies BridgetHumanView;
          }),
      } as unknown as RpcSession["client"]);
      const target = { ...h.target, input: { ...h.target.input, action: "list" as const } };
      for (let read = 0; read < 10; read++) {
        const result = yield* Effect.promise(() =>
          executeAtomQuery(h.registry, h.atoms.bridgetRead(target), { refresh: true }),
        );
        expect(result._tag).toBe("Success");
        expect(calls).toBe(read + 1);
      }
    }),
  ),
);

it.effect(
  "releases human streams over ten visits and starts new ready generations after reconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let active = 0;
        let opened = 0;
        const releaseReceipts: Array<Deferred.Deferred<void>> = [];
        const ready: BridgetWatchEvent = {
          version: 1,
          generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce",
          seq: 0,
          status: "ready",
        };
        const client = {
          [WS_METHODS.bridgetWatch]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const released = yield* Deferred.make<void>();
                releaseReceipts.push(released);
                opened += 1;
                active += 1;
                return Stream.make(ready).pipe(
                  Stream.concat(Stream.never),
                  Stream.ensuring(
                    Effect.sync(() => {
                      active -= 1;
                    }).pipe(Effect.andThen(Deferred.succeed(released, undefined))),
                  ),
                );
              }),
            ),
        } as unknown as RpcSession["client"];
        const h = yield* makeHumanRuntime(client);
        for (let visit = 0; visit < 10; visit++) {
          const atom = h.atoms.bridgetWatch(h.target);
          const unmount = h.registry.mount(atom);
          expect((yield* AtomRegistry.getResult(h.registry, atom)).event).toEqual(ready);
          unmount();
          yield* Deferred.await(releaseReceipts[visit]!);
          expect(active).toBe(0);
        }
        expect(opened).toBe(10);
        const atom = h.atoms.bridgetWatch(h.target);
        const unmount = h.registry.mount(atom);
        yield* AtomRegistry.getResult(h.registry, atom);
        yield* SubscriptionRef.set(h.session, Option.none());
        yield* Deferred.await(releaseReceipts[10]!);
        const replacementReady = { ...ready, generation: "10000000-0000-4000-8000-000000000001" };
        const resumed = Latch.makeUnsafe();
        const unsubscribe = h.registry.subscribe(atom, (result) => {
          if (
            AsyncResult.isSuccess(result) &&
            result.value.event?.generation === replacementReady.generation
          )
            resumed.openUnsafe();
        });
        yield* SubscriptionRef.set(
          h.session,
          Option.some({
            client: {
              [WS_METHODS.bridgetWatch]: () =>
                Stream.make(replacementReady).pipe(Stream.concat(Stream.never)),
            },
          } as unknown as RpcSession),
        );
        yield* resumed.await;
        expect((yield* AtomRegistry.getResult(h.registry, atom)).event?.generation).toBe(
          replacementReady.generation,
        );
        unsubscribe();
        unmount();
      }),
    ),
);

it.effect("settles a closed watch refusal without automatic retries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const code of [
        "binding_unavailable",
        "thread_unavailable",
        "project_mismatch",
        "storage_unavailable",
        "response_too_large",
        "invalid_request",
        "invalid_output",
        "unsupported_version",
      ] as const) {
        let calls = 0;
        const h = yield* makeHumanRuntime({
          [WS_METHODS.bridgetWatch]: () => {
            calls += 1;
            return Stream.fail(new BridgetReadError({ code }));
          },
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetWatch(h.target);
        const unmount = h.registry.mount(atom);
        const error = yield* AtomRegistry.getResult(h.registry, atom).pipe(Effect.flip);
        expect(isBridgetReadError(error) && error.code).toBe(code);
        yield* TestClock.adjust("1 minute");
        expect(calls).toBe(1);
        unmount();
      }
    }),
  ),
);

it.effect("follows the supervisor's replacement session after a watch transport failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const h = yield* makeHumanRuntime({
        [WS_METHODS.bridgetWatch]: () =>
          Stream.fromEffect(Deferred.succeed(failed, undefined)).pipe(
            Stream.drain,
            Stream.concat(
              Stream.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "socket closed",
                    cause: new Error("socket closed"),
                  }),
                }),
              ),
            ),
          ),
      } as unknown as RpcSession["client"]);
      const atom = h.atoms.bridgetWatch(h.target);
      const unmount = h.registry.mount(atom);
      yield* Deferred.await(failed);
      const ready: BridgetWatchEvent = {
        version: 1,
        generation: "10000000-0000-4000-8000-000000000001",
        seq: 0,
        status: "ready",
      };
      yield* SubscriptionRef.set(
        h.session,
        Option.some({
          client: {
            [WS_METHODS.bridgetWatch]: () => Stream.make(ready).pipe(Stream.concat(Stream.never)),
          },
        } as unknown as RpcSession),
      );
      expect((yield* AtomRegistry.getResult(h.registry, atom)).event).toEqual(ready);
      unmount();
    }),
  ),
);

it.effect("masks a technical failure and reopens Bridget on the same websocket session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened = 0;
      const ready: BridgetWatchEvent = {
        version: 1,
        generation: "10000000-0000-4000-8000-000000000001",
        seq: 0,
        status: "ready",
      };
      const resumed = Latch.makeUnsafe();
      const h = yield* makeHumanRuntime({
        [WS_METHODS.bridgetWatch]: () =>
          Stream.suspend(() => {
            opened += 1;
            return opened <= 2
              ? Stream.fail(new BridgetReadError({ code: "unavailable" }))
              : Stream.make(ready).pipe(Stream.concat(Stream.never));
          }),
      } as unknown as RpcSession["client"]);
      const atom = h.atoms.bridgetWatch(h.target);
      const unmount = h.registry.mount(atom);
      const unsubscribe = h.registry.subscribe(atom, (state) => {
        if (AsyncResult.isSuccess(state) && state.value.readyGeneration === ready.generation)
          resumed.openUnsafe();
      });
      const masked = yield* AtomRegistry.getResult(h.registry, atom);
      expect(masked.event).toBeNull();
      expect(masked.readyGeneration).toBeNull();
      yield* TestClock.adjust("2 seconds");
      yield* resumed.await;
      expect(opened).toBe(3);
      expect((yield* AtomRegistry.getResult(h.registry, atom)).event).toEqual(ready);
      unsubscribe();
      unmount();
    }),
  ),
);

it.effect(
  "caps technical reopenings at four even when each child emitted ready before failing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opened = 0;
        const ready: BridgetWatchEvent = {
          version: 1,
          generation: "10000000-0000-4000-8000-000000000001",
          seq: 0,
          status: "ready",
        };
        const h = yield* makeHumanRuntime({
          [WS_METHODS.bridgetWatch]: () =>
            Stream.suspend(() => {
              opened += 1;
              return Stream.make(ready).pipe(
                Stream.concat(Stream.fail(new BridgetReadError({ code: "command_failed" }))),
              );
            }),
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetWatch(h.target);
        const unmount = h.registry.mount(atom);
        const masked = Latch.makeUnsafe();
        const failed = Latch.makeUnsafe();
        const unsubscribe = h.registry.subscribe(
          atom,
          (state) => {
            if (AsyncResult.isSuccess(state) && state.value.event === null) masked.openUnsafe();
            if (AsyncResult.isFailure(state)) failed.openUnsafe();
          },
          { immediate: true },
        );
        yield* masked.await;
        yield* TestClock.adjust("1 minute");
        yield* failed.await;
        const error = yield* AtomRegistry.getResult(h.registry, atom).pipe(Effect.flip);
        expect(isBridgetReadError(error) && error.code).toBe("command_failed");
        expect(opened).toBe(4);
        unsubscribe();
        unmount();
      }),
    ),
);

it.effect("cancels scheduled technical reopening when the watch consumer leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opened = 0;
      const h = yield* makeHumanRuntime({
        [WS_METHODS.bridgetWatch]: () => {
          opened += 1;
          return Stream.fail(new BridgetReadError({ code: "timeout" }));
        },
      } as unknown as RpcSession["client"]);
      const atom = h.atoms.bridgetWatch(h.target);
      const unmount = h.registry.mount(atom);
      expect((yield* AtomRegistry.getResult(h.registry, atom)).readyGeneration).toBeNull();
      unmount();
      yield* TestClock.adjust("1 minute");
      expect(opened).toBe(1);
    }),
  ),
);

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
