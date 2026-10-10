import {
  BridgetLineageError,
  EnvironmentId,
  isBridgetSubagentThread,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type BridgetJournalEvent,
  type BridgetLineageJournal,
  type BridgetLineageTask,
  type BridgetTaskRef,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { deriveProviderSubagentStatus, deriveRunlessWorkStartedAt } from "./threadExecution.ts";
import { canDetachThreadProviderSession } from "./threadWorkflows.ts";

// Session 149 — descendance native Bridget : couche état client
// (contracts/lineage.md §Journal, §Statut natif ; test-strategy.md S149-16).

const TASK_ID = "25000000-0000-4000-8000-000000000001";

// `instanceof` est interdit sur un type Effect Schema : passer par le garde runtime.
const isLineageError = Schema.is(BridgetLineageError);

const makeLineageRuntime = Effect.fn("LineageRuntimeTest.make")(function* (
  client: RpcSession["client"],
) {
  const environmentId = EnvironmentId.make("lineage-test-environment");
  const session = yield* SubscriptionRef.make(Option.some({ client } as RpcSession));
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Lineage test",
      httpBaseUrl: "https://lineage.test",
      wsBaseUrl: "wss://lineage.test",
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
  return { registry, atoms, session, target: { environmentId, input, visitId: "lineage-visit" } };
});

const makeBridgetTask = (
  status: BridgetLineageTask["status"],
  overrides: Partial<BridgetLineageTask> = {},
): BridgetLineageTask => ({
  task_id: TASK_ID,
  parent_task_id: null,
  parent_agent_id: "25000000-0000-4000-8000-000000000002",
  child_agent_id: "25000000-0000-4000-8000-000000000003",
  child_instance_id: null,
  created_at: 1700000000,
  updated_at: 1700000000,
  started_at: 1700000000,
  completed_at: null,
  agent_type: "general",
  execution_protocol: "codex_app_server",
  model: "test-model",
  effort: null,
  cwd: "/tmp/bridget",
  posture: "development",
  title: "Tâche Bridget",
  status,
  error: null,
  result_available: false,
  journal_available: true,
  ...overrides,
});

const journalEvent = (seq: number): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts: `2026-10-10T10:00:${String(seq % 60).padStart(2, "0")}Z`,
  session_id: "journal-session",
  event: "log",
  payload: `ligne ${seq}`,
});

const journalEnvelope = (
  events: ReadonlyArray<BridgetJournalEvent>,
  next_seq: number,
  caught_up: boolean,
  gap: BridgetLineageJournal["gap"] = null,
): BridgetLineageJournal => ({
  version: 1,
  status: "ok",
  task_id: TASK_ID,
  events: [...events],
  next_seq,
  caught_up,
  gap,
});

const projectionWithBridgetTask = (
  status: BridgetLineageTask["status"],
  overrides: Partial<BridgetLineageTask> = {},
): OrchestrationV2ThreadProjection => ({
  ...v2Projection,
  thread: { ...v2Projection.thread, bridgetTask: makeBridgetTask(status, overrides) },
});

const fakeRootTurnNode = (status: string) =>
  ({
    kind: "root_turn",
    runId: null,
    status,
    startedAt: null,
    completedAt: null,
  }) as unknown as OrchestrationV2ThreadProjection["nodes"][number];

it.effect(
  "accumule les pages du journal Bridget, garde le dernier gap et la fraîcheur caught_up sans dédupliquer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const journalInputs: Array<unknown> = [];
        const emitted = yield* Deferred.make<void>();
        const envelopes = [
          journalEnvelope([journalEvent(42), journalEvent(43)], 43, false),
          journalEnvelope([journalEvent(46)], 46, true, {
            from_seq: 44,
            to_seq: 45,
            reason: "transport",
          }),
          journalEnvelope([journalEvent(46), journalEvent(47)], 47, false),
        ];
        const h = yield* makeLineageRuntime({
          [WS_METHODS.bridgetLineageJournal]: (payload: unknown) => {
            journalInputs.push(structuredClone(payload));
            return Stream.make(...envelopes).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            );
          },
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetLineageJournal({
          environmentId: h.target.environmentId,
          input: {
            context: { ...h.target.input, taskId: TASK_ID, afterSeq: 41 },
            visitId: "visit-j1",
          },
        });
        const unmount = h.registry.mount(atom);
        // Le commit des valeurs pliées suit l'émission de quelques ticks :
        // attendre l'état final committé plutôt que lire tout de suite.
        const settled = Latch.makeUnsafe();
        const stopSettling = h.registry.subscribe(atom, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.events.length === 5) {
            settled.openUnsafe();
          }
        });
        yield* Deferred.await(emitted);
        yield* settled.await;
        stopSettling();
        // getResult renvoie la valeur pliée directement (et échoue sur Failure).
        const state = yield* AtomRegistry.getResult(h.registry, atom);
        // La reprise demandée au serveur porte bien l'afterSeq du client.
        expect(JSON.stringify(journalInputs[0])).toContain('"afterSeq":41');
        // Chaque enveloppe est pliée : aucun dédoublonnage au niveau état
        // (le seq 46 dupliqué reste ; la fusion est le travail du composant).
        expect(state.events.map((event) => event.seq)).toEqual([42, 43, 46, 46, 47]);
        expect(state.nextSeq).toBe(47);
        // Le gap explicite du contrat (lineage.md §Journal) reste affiché tant
        // qu'aucune enveloppe neuve n'en apporte un autre.
        expect(state.gap).toEqual({ from_seq: 44, to_seq: 45, reason: "transport" });
        expect(state.caughtUp).toBe(false);
        expect(state.evicted).toBe(0);
        unmount();
      }),
    ),
);

it.effect("évince le début du journal au-delà de 4096 lignes et compte les lignes perdues", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const emitted = yield* Deferred.make<void>();
      const bigEnvelope = journalEnvelope(
        Array.from({ length: 4100 }, (_, index) => journalEvent(index + 1)),
        4100,
        true,
      );
      const h = yield* makeLineageRuntime({
        [WS_METHODS.bridgetLineageJournal]: () =>
          Stream.make(bigEnvelope).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(emitted, undefined)).pipe(Stream.drain),
            ),
            Stream.concat(Stream.never),
          ),
      } as unknown as RpcSession["client"]);
      const atom = h.atoms.bridgetLineageJournal({
        environmentId: h.target.environmentId,
        input: { context: { ...h.target.input, taskId: TASK_ID }, visitId: "visit-j2" },
      });
      const unmount = h.registry.mount(atom);
      const settled = Latch.makeUnsafe();
      const stopSettling = h.registry.subscribe(atom, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.events.length === 4096) {
          settled.openUnsafe();
        }
      });
      yield* Deferred.await(emitted);
      yield* settled.await;
      stopSettling();
      const state = yield* AtomRegistry.getResult(h.registry, atom);
      expect(state.events.length).toBe(4096);
      expect(state.events[0]!.seq).toBe(5);
      expect(state.evicted).toBe(4);
      expect(state.nextSeq).toBe(4100);
      unmount();
    }),
  ),
);

it.effect(
  "relance un watch lineage uniquement sur erreur technique, au plus trois relances par visite",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let opens = 0;
        const h = yield* makeLineageRuntime({
          [WS_METHODS.bridgetLineageWatch]: () =>
            Stream.unwrap(
              Effect.sync(() => {
                opens += 1;
                return Stream.make({ version: 1 as const, seq: opens }).pipe(
                  Stream.concat(
                    Stream.fail(new BridgetLineageError({ code: "store_unavailable" })),
                  ),
                );
              }),
            ),
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetLineageWatch({
          environmentId: h.target.environmentId,
          input: { context: h.target.input, visitId: "visit-w1" },
        });
        const unmount = h.registry.mount(atom);
        // La fin de l'échec s'observe sur l'AsyncResult du callback d'abonnement.
        const failed = Latch.makeUnsafe();
        const unsubscribe = h.registry.subscribe(atom, (result) => {
          if (AsyncResult.isFailure(result)) failed.openUnsafe();
        });
        for (let second = 0; second < 6; second++) yield* TestClock.adjust("1 second");
        yield* failed.await;
        const error = yield* AtomRegistry.getResult(h.registry, atom).pipe(Effect.flip);
        expect(isLineageError(error) && error.code).toBe("store_unavailable");
        // 1 ouverture initiale + 3 relances maximum : budget par visite.
        expect(opens).toBe(4);
        unsubscribe();
        unmount();
      }),
    ),
);

it.effect("règle un refus d'autorité lineage sans aucune relance automatique", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const code of [
        "unsupported_version",
        "invalid_request",
        "binding_unavailable",
        "project_mismatch",
        "task_unavailable",
        "snapshot_changed",
        "journal_unavailable",
        "result_offset_invalid",
        "envelope_mismatch",
        "resource_limit",
      ] as const) {
        let calls = 0;
        const h = yield* makeLineageRuntime({
          [WS_METHODS.bridgetLineageWatch]: () => {
            calls += 1;
            return Stream.fail(new BridgetLineageError({ code }));
          },
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetLineageWatch({
          environmentId: h.target.environmentId,
          input: { context: h.target.input, visitId: `visit-w2-${code}` },
        });
        const unmount = h.registry.mount(atom);
        yield* TestClock.adjust("1 minute");
        const error = yield* AtomRegistry.getResult(h.registry, atom).pipe(Effect.flip);
        expect(isLineageError(error) && error.code).toBe(code);
        expect(calls).toBe(1);
        unmount();
      }
    }),
  ),
);

it.effect(
  "ne relance jamais le journal : la reprise appartient au client via afterSeq et une nouvelle visite",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* makeLineageRuntime({
          [WS_METHODS.bridgetLineageJournal]: () => {
            calls += 1;
            return Stream.fail(new BridgetLineageError({ code: "store_unavailable" }));
          },
        } as unknown as RpcSession["client"]);
        const atom = h.atoms.bridgetLineageJournal({
          environmentId: h.target.environmentId,
          input: { context: { ...h.target.input, taskId: TASK_ID }, visitId: "visit-j3" },
        });
        const unmount = h.registry.mount(atom);
        yield* TestClock.adjust("1 minute");
        const error = yield* AtomRegistry.getResult(h.registry, atom).pipe(Effect.flip);
        expect(isLineageError(error) && error.code).toBe("store_unavailable");
        expect(calls).toBe(1);
        unmount();
      }),
    ),
);

const NATIVE_TO_PRESENTATION = {
  queued: "pending",
  starting: "pending",
  mission_pending: "pending",
  working: "running",
  waiting_for_children: "waiting",
  cancelling: "waiting",
  result_available: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

it.effect(
  "dérive les 9 statuts natifs vers la présentation sans aucun run ni tour fournisseur",
  () =>
    Effect.sync(() => {
      for (const [native, presentation] of Object.entries(NATIVE_TO_PRESENTATION)) {
        const status = deriveProviderSubagentStatus(
          projectionWithBridgetTask(native as BridgetLineageTask["status"]),
        );
        // Forme publique préservée : exactement trois champs, aucun identifiant
        // de run/turn inventé (activeTurnId reste un champ serveur, toujours null).
        expect(Object.keys(status!).sort()).toEqual(["completedAt", "startedAt", "status"]);
        expect(status!.status).toBe(presentation);
      }
    }),
);

it.effect(
  "convertit les secondes Unix en ISO, garde les absences à null et privilégie la tâche Bridget au tour racine",
  () =>
    Effect.sync(() => {
      const status = deriveProviderSubagentStatus(
        projectionWithBridgetTask("working", {
          completed_at: 1700000100,
          result_available: true,
        }),
      );
      expect(status!.startedAt).toBe("2023-11-14T22:13:20.000Z");
      expect(status!.completedAt).toBe("2023-11-14T22:15:00.000Z");

      const withoutTimes = deriveProviderSubagentStatus(
        projectionWithBridgetTask("queued", {
          started_at: null,
        }),
      );
      expect(withoutTimes!.startedAt).toBeNull();
      expect(withoutTimes!.completedAt).toBeNull();

      // Un tour racine provider-native concurrent ne masque pas l'état Bridget.
      const withCompetingNode = {
        ...projectionWithBridgetTask("working"),
        nodes: [fakeRootTurnNode("waiting")],
      };
      expect(deriveProviderSubagentStatus(withCompetingNode)!.status).toBe("running");

      // Sans tâche Bridget, la branche provider-native reste intacte.
      const providerNative = {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          lineage: { ...v2Projection.thread.lineage, relationshipToParent: "subagent" as const },
          creationSource: "provider" as const,
        },
        nodes: [fakeRootTurnNode("waiting")],
      };
      const fallback = deriveProviderSubagentStatus(providerNative);
      expect(fallback!.status).toBe("waiting");

      // Tout autre fil reste sans statut dérivé.
      expect(deriveProviderSubagentStatus(v2Projection)).toBeNull();
    }),
);

it.effect("n'expose une heure de démarrage runless que pour un travail Bridget actif", () =>
  Effect.sync(() => {
    for (const active of ["mission_pending", "working", "waiting_for_children"] as const) {
      expect(deriveRunlessWorkStartedAt(projectionWithBridgetTask(active))).toBe(
        "2023-11-14T22:13:20.000Z",
      );
    }
    for (const terminal of ["result_available", "failed", "cancelled"] as const) {
      expect(deriveRunlessWorkStartedAt(projectionWithBridgetTask(terminal))).toBeNull();
    }
  }),
);

it.effect(
  "ferme le détachement de session pour un fil de tâche Bridget et le marque comme sous-agent",
  () =>
    Effect.sync(() => {
      const taskRef: BridgetTaskRef = {
        version: 1,
        taskId: TASK_ID,
        rootThreadId: v2Projection.thread.id,
        parentTaskId: null,
        generation: "3503a3ce-cb97-46eb-b17b-339377b0c1ce",
        seq: 1,
        status: "working",
      };
      const bridgetProjection = {
        ...v2Projection,
        thread: { ...v2Projection.thread, bridgetTaskRef: taskRef },
      };
      expect(isBridgetSubagentThread(bridgetProjection.thread)).toBe(true);
      // Le type du shell modélise bridgetTaskRef comme `X | undefined` requis ;
      // à l'exécution la fixture omet la clé : retype la forme structurelle.
      const threadWithoutTaskRef = v2Projection.thread as Parameters<
        typeof isBridgetSubagentThread
      >[0];
      expect(isBridgetSubagentThread(threadWithoutTaskRef)).toBe(false);
      // La session vivante est ignorée : la vie du fil appartient à Bridget.
      const liveSessions = [
        { status: "running" },
      ] as unknown as OrchestrationV2ThreadProjection["providerSessions"];
      expect(canDetachThreadProviderSession(bridgetProjection)).toBe(false);
      expect(
        canDetachThreadProviderSession({ ...v2Projection, providerSessions: liveSessions }),
      ).toBe(true);
      const stoppedSessions = [
        { status: "stopped" },
      ] as unknown as OrchestrationV2ThreadProjection["providerSessions"];
      expect(
        canDetachThreadProviderSession({ ...v2Projection, providerSessions: stoppedSessions }),
      ).toBe(false);
    }),
);
