import type { BridgetJournalEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BRIDGET_JOURNAL_MAX_GAPS,
  bridgetTurnDurationMs,
  isBridgetJournalLifecycle,
  mergeJournalEvents,
  projectBridgetConversation,
  projectBridgetJournal,
  retainBridgetJournalGaps,
  type BridgetJournalGapState,
} from "./bridgetJournalPresentation.ts";

const event = (
  seq: number,
  payload: BridgetJournalEvent["payload"],
  overrides: Partial<BridgetJournalEvent> = {},
): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts: `2026-10-13T21:38:${String(seq).padStart(2, "0")}Z`,
  session_id: "session-a",
  event: "update",
  payload,
  ...overrides,
});

describe("conversation Bridget", () => {
  const turns = (events: BridgetJournalEvent[]) =>
    projectBridgetConversation(projectBridgetJournal({ events }));

  it("présente la demande et la durée du vrai tour tout en conservant chaque événement", () => {
    const source = [
      event(
        1,
        { body: "Relire le correctif" },
        { event: "turn_start", ts: "2026-11-08T12:00:00Z" },
      ),
      event(2, { kind: "text", content: "Je vérifie les sources." }),
      event(3, { kind: "command", text: "git diff", detail: "item/started" }),
      event(4, { kind: "text", content: "Aucun défaut confirmé." }),
      event(5, { stop_reason: "completed" }, { event: "turn_end", ts: "2026-11-08T12:01:20Z" }),
    ];
    const [turn] = turns(source);
    expect(turn?.prompt).toBe("Relire le correctif");
    expect(turn?.outcome).toBe("completed");
    expect(bridgetTurnDurationMs(turn!)).toBe(80_000);
    expect(turn?.blocks.flatMap((block) => block.events)).toEqual(source);
    expect(
      turn?.blocks
        .filter(isBridgetJournalLifecycle)
        .flatMap((block) => block.events.map((entry) => entry.event)),
    ).toEqual(["turn_start", "turn_end"]);
  });

  it("ne fusionne pas les tours ni leurs durées même dans la même livraison", () => {
    const result = turns([
      event(1, {}, { event: "turn_start", ts: "2026-11-08T12:00:00Z" }),
      event(2, { stop_reason: "completed" }, { event: "turn_end", ts: "2026-11-08T12:01:00Z" }),
      event(3, {}, { event: "turn_start", ts: "2026-11-08T12:02:00Z" }),
      event(4, { stop_reason: "cancelled" }, { event: "turn_end", ts: "2026-11-08T12:02:10Z" }),
    ]);
    expect(result.map(bridgetTurnDurationMs)).toEqual([60_000, 10_000]);
    expect(result.map((turn) => turn.outcome)).toEqual(["completed", "cancelled"]);
  });

  it("ne donne aucune durée aux extraits, horodatages invalides, conflits et lacunes", () => {
    const start = event(1, {}, { event: "turn_start", ts: "2026-11-08T12:00:00Z" });
    const end = event(
      3,
      { stop_reason: "completed" },
      { event: "turn_end", ts: "2026-11-08T12:01:00Z" },
    );
    for (const projection of [
      projectBridgetJournal({ events: [end] }),
      projectBridgetJournal({ events: [start, end], beginsWithExcerpt: true }),
      projectBridgetJournal({
        events: [start, end],
        gaps: [{ from_seq: 2, to_seq: 2, reason: "transport" }],
      }),
      projectBridgetJournal({
        events: [start, end],
        continuityCut: { fromSeq: 2, toSeq: 2, reason: "gap-pressure" },
      }),
      projectBridgetJournal({ events: [{ ...start, ts: "unknown" }, end] }),
      projectBridgetJournal({ events: [start, { ...end, ts: "2026-11-08T11:59:59Z" }] }),
      projectBridgetJournal({
        events: [start, end],
        conflicts: [
          {
            seq: 1,
            first: start,
            conflicting: { ...start, payload: { body: "autre" } },
            additionalConflicts: 0,
          },
        ],
      }),
    ]) {
      expect(
        projectBridgetConversation(projection).every(
          (turn) => bridgetTurnDurationMs(turn) === null,
        ),
      ).toBe(true);
    }
  });

  it("conserve les inconnus et ne termine pas un tour pour une erreur sans marqueur terminal", () => {
    const [turn] = turns([
      event(1, {}, { event: "turn_start" }),
      event(2, { diagnostic: "read failed" }, { event: "error" }),
      event(3, { kind: "future_tool", detail: "future" }),
    ]);
    expect(turn?.outcome).toBeNull();
    expect(turn?.endedAt).toBeNull();
    expect(turn?.blocks.filter((block) => !isBridgetJournalLifecycle(block))).toHaveLength(2);
  });

  it("distingue la fin en échec du succès et d'un tour toujours actif", () => {
    const [turn] = turns([
      event(1, {}, { event: "turn_start" }),
      event(2, { terminal_kind: "turn_failed" }, { event: "error" }),
    ]);
    expect(turn?.outcome).toBe("failed");
    expect(turn?.endedAt).not.toBeNull();
  });
});

describe("projection du journal Bridget", () => {
  it("concatène les fragments Unicode exacts sans séparateur inventé", () => {
    const projection = projectBridgetJournal({
      events: [
        event(1, { kind: "text", content: "workflow" }),
        event(2, { kind: "text", content: " Spec" }),
        event(3, { kind: "text", content: "Kit" }),
        event(4, { kind: "text", content: " et 你好\n`code`" }),
      ],
    });
    expect(projection.blocks).toMatchObject([
      { kind: "text", key: "text:1", content: "workflow SpecKit et 你好\n`code`" },
    ]);
  });

  it("ferme un segment à une session, livraison, activité ou lacune", () => {
    const projection = projectBridgetJournal({
      events: [
        event(1, { kind: "text", content: "A" }, { message_id: "delivery-a" }),
        event(2, { kind: "text", content: "B" }, { message_id: "delivery-b" }),
        event(3, { kind: "command", detail: "item/started", text: "pwd" }),
        event(6, { kind: "text", content: "C" }, { session_id: "session-b" }),
      ],
      gaps: [{ from_seq: 4, to_seq: 5, reason: "transport" }],
    });
    expect(projection.blocks.map((block) => [block.kind, block.key])).toEqual([
      ["text", "text:1"],
      ["text", "text:2"],
      ["activity", "activity:3"],
      ["text", "text:6"],
    ]);
  });

  it("distingue les frontières de livraison et session des extraits réellement coupés", () => {
    const grouped = projectBridgetJournal({
      events: [
        event(1, { kind: "text", content: "A" }, { message_id: "delivery-a" }),
        event(2, { kind: "text", content: "B" }, { message_id: "delivery-b" }),
        event(3, { kind: "text", content: "C" }, { session_id: "session-b" }),
      ],
    });
    expect(grouped.blocks).toMatchObject([
      { kind: "text", key: "text:1", content: "A", excerpt: false },
      { kind: "text", key: "text:2", content: "B", excerpt: false },
      { kind: "text", key: "text:3", content: "C", excerpt: false },
    ]);

    const cut = projectBridgetJournal({
      events: [
        event(1, { kind: "text", content: "tête" }),
        event(3, { kind: "text", content: "gap" }),
        event(5, { kind: "text", content: "coupe" }),
      ],
      beginsWithExcerpt: true,
      gaps: [{ from_seq: 2, to_seq: 2, reason: "transport" }],
      continuityCut: { fromSeq: 4, toSeq: 4, reason: "gap-pressure" },
    });
    expect(cut.blocks).toMatchObject([
      { kind: "text", key: "text:1", excerpt: true },
      { kind: "text", key: "text:3", excerpt: true },
      { kind: "text", key: "text:5", excerpt: true },
    ]);
  });

  it("ne corrèle pas started et completed et n'invente aucun succès", () => {
    const projection = projectBridgetJournal({
      events: [
        event(1, { kind: "command", detail: "item/started", text: "pwd" }),
        event(2, {
          kind: "command",
          detail: "item/completed",
          text: "pwd",
          item_id: "exec-1",
          exit_code: 0,
          state: "completed",
          status: "completed",
          output_tail: "workspace",
        }),
        event(3, { kind: "tool", text: "Claude only", tool_call_id: "acp-call-1" }),
        event(4, { kind: "refusal", attributed_to: "Bridget" }),
      ],
    });
    expect(projection.blocks).toMatchObject([
      { kind: "activity", label: "Commande commencée", exitCode: null, status: null },
      {
        kind: "activity",
        label: "Commande terminée",
        exitCode: 0,
        status: "completed",
        outputTail: "workspace",
      },
      { kind: "activity", label: "Appel d’outil", status: null, toolCallId: "acp-call-1" },
      { kind: "activity", label: "Refus attribué à Bridget" },
    ]);
  });

  it("conserve une forme inconnue comme détail technique sans la supprimer", () => {
    for (const kind of [
      "nouvelle_forme",
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ]) {
      const source = event(8, { kind, nested: { proof: true } });
      const projection = projectBridgetJournal({ events: [source] });
      expect(projection.blocks).toMatchObject([
        { kind: "technical", key: "technical:8", events: [source] },
      ]);
    }
  });

  it("garde le premier rejeu, expose un conflit et réemploie les blocs clos", () => {
    const first = event(1, { kind: "text", content: "premier" });
    const merged = mergeJournalEvents([first], [event(1, { kind: "text", content: "autre" })]);
    expect(merged.events).toEqual([first]);
    expect(merged.conflicts).toHaveLength(1);
    const replayed = mergeJournalEvents(
      merged.events,
      [event(1, { kind: "text", content: "autre" })],
      merged.conflicts,
    );
    expect(replayed.conflicts[0]).toBe(merged.conflicts[0]);
    expect(replayed.conflicts[0]?.additionalConflicts).toBe(0);
    const another = mergeJournalEvents(
      replayed.events,
      [event(1, { kind: "text", content: "autre encore" })],
      replayed.conflicts,
    );
    expect(another.conflicts).toHaveLength(1);
    expect(another.conflicts[0]).toMatchObject({
      first,
      conflicting: merged.conflicts[0]?.conflicting,
      additionalConflicts: 1,
    });
    const initial = projectBridgetJournal({
      events: [first, event(2, { kind: "text", content: " fermé" })],
    });
    const appended = projectBridgetJournal(
      { events: [...initial.sourceEvents, event(3, { kind: "command", detail: "item/started" })] },
      initial,
    );
    expect(appended.blocks[0]).toBe(initial.blocks[0]);
    const withClosed = projectBridgetJournal({
      events: [
        event(1, { kind: "text", content: "fermé" }),
        event(2, { kind: "command", detail: "item/started" }),
      ],
    });
    const withTail = projectBridgetJournal(
      { events: [...withClosed.sourceEvents, event(3, { kind: "text", content: "queue" })] },
      withClosed,
    );
    expect(withTail.blocks[0]).toBe(withClosed.blocks[0]);
  });

  it("déduplique les gaps sticky et garde une coupe conservative sous pression", () => {
    let state: BridgetJournalGapState = { gaps: [], continuityCut: null };
    state = retainBridgetJournalGaps(
      state,
      [
        { from_seq: 2, to_seq: 2, reason: "transport" },
        { from_seq: 4, to_seq: 4, reason: "transport" },
      ],
      1,
      { fromSeq: 4, toSeq: 4, reason: "gap-pressure" },
    );
    state = retainBridgetJournalGaps(state, [{ from_seq: 4, to_seq: 4, reason: "transport" }], 1);
    expect(state).toMatchObject({
      gaps: [
        { from_seq: 2, to_seq: 2, reason: "transport" },
        { from_seq: 4, to_seq: 4, reason: "transport" },
      ],
      continuityCut: { fromSeq: 4, toSeq: 4, reason: "gap-pressure" },
    });
    state = retainBridgetJournalGaps(state, [], 5);
    expect(state).toEqual({ gaps: [], continuityCut: null });
    state = retainBridgetJournalGaps(state, { from_seq: 4, to_seq: 5, reason: "transport" }, 1);
    state = retainBridgetJournalGaps(state, { from_seq: 4, to_seq: 5, reason: "transport" }, 1);
    expect(state.gaps).toHaveLength(1);
    for (let index = 0; index < BRIDGET_JOURNAL_MAX_GAPS + 2; index += 1) {
      state = retainBridgetJournalGaps(
        state,
        { from_seq: index * 3 + 10, to_seq: index * 3 + 11, reason: "transport" },
        1,
      );
    }
    expect(state.gaps).toHaveLength(BRIDGET_JOURNAL_MAX_GAPS);
    expect(state.continuityCut).toMatchObject({ reason: "gap-pressure" });
  });
});
