import type { BridgetJournalEvent, BridgetLineageJournal } from "@t3tools/contracts";

/** The native stream is bounded before it reaches this pure presentation layer. */
export const BRIDGET_JOURNAL_WINDOW = 4_096;
export const BRIDGET_JOURNAL_MAX_GAPS = 64;

export type BridgetJournalGap = NonNullable<BridgetLineageJournal["gap"]>;

export interface BridgetJournalConflict {
  readonly seq: number;
  readonly first: BridgetJournalEvent;
  readonly conflicting: BridgetJournalEvent;
  readonly additionalConflicts: number;
}

export interface BridgetJournalContinuityCut {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: "gap-pressure";
}

export interface BridgetJournalGapState {
  readonly gaps: ReadonlyArray<BridgetJournalGap>;
  readonly continuityCut: BridgetJournalContinuityCut | null;
}

export interface BridgetJournalMergeResult {
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
  /** Number of source events dropped by the local 4,096-event window. */
  readonly evicted: number;
}

type JournalPayload = Record<string, unknown>;

function isPayloadRecord(value: unknown): value is JournalPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]))
    );
  }
  if (!isPayloadRecord(left) || !isPayloadRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = new Set(Object.keys(right));
  return (
    leftKeys.length === rightKeys.size &&
    leftKeys.every((key) => rightKeys.has(key) && sameJsonValue(left[key], right[key]))
  );
}

export function sameBridgetJournalEvent(
  left: BridgetJournalEvent,
  right: BridgetJournalEvent,
): boolean {
  return (
    left === right ||
    (left.v === right.v &&
      left.seq === right.seq &&
      left.ts === right.ts &&
      left.session_id === right.session_id &&
      left.event === right.event &&
      left.message_id === right.message_id &&
      sameJsonValue(left.payload, right.payload))
  );
}

function addConflict(
  conflicts: Map<number, BridgetJournalConflict>,
  first: BridgetJournalEvent,
  conflicting: BridgetJournalEvent,
) {
  const current = conflicts.get(first.seq);
  if (current) {
    if (sameBridgetJournalEvent(current.conflicting, conflicting)) return;
    conflicts.set(first.seq, { ...current, additionalConflicts: current.additionalConflicts + 1 });
    return;
  }
  conflicts.set(first.seq, { seq: first.seq, first, conflicting, additionalConflicts: 0 });
}

/**
 * Keeps the first proof for every sequence and records one bounded conflicting
 * witness before a container can silently collapse it into a Map. The one sort
 * restores the native sequence order; all lookups are O(1), so merging is
 * O((n + m) log(n + m)) only because the input stream may arrive out of order.
 */
export function mergeJournalEvents(
  existing: ReadonlyArray<BridgetJournalEvent>,
  incoming: ReadonlyArray<BridgetJournalEvent>,
  previousConflicts: ReadonlyArray<BridgetJournalConflict> = [],
): BridgetJournalMergeResult {
  const firstBySeq = new Map<number, BridgetJournalEvent>();
  const conflicts = new Map<number, BridgetJournalConflict>();
  for (const conflict of previousConflicts) conflicts.set(conflict.seq, conflict);
  for (const event of [...existing, ...incoming]) {
    const first = firstBySeq.get(event.seq);
    if (first === undefined) {
      firstBySeq.set(event.seq, event);
    } else if (!sameBridgetJournalEvent(first, event)) {
      addConflict(conflicts, first, event);
    }
  }
  const ordered = [...firstBySeq.values()].sort((left, right) => left.seq - right.seq);
  const evicted = Math.max(0, ordered.length - BRIDGET_JOURNAL_WINDOW);
  const events = evicted === 0 ? ordered : ordered.slice(evicted);
  const retainedSequences = new Set(events.map((event) => event.seq));
  const retainedConflicts = [...conflicts.values()]
    .filter((conflict) => retainedSequences.has(conflict.seq))
    .sort((left, right) => left.seq - right.seq);
  return { events, conflicts: retainedConflicts, evicted };
}

function sameGap(left: BridgetJournalGap, right: BridgetJournalGap): boolean {
  return (
    left.from_seq === right.from_seq && left.to_seq === right.to_seq && left.reason === right.reason
  );
}

/**
 * Gap markers are ephemeral client state. When more than 64 still intersect
 * the live window, one conservative interval keeps the projection from joining
 * text across an unknown boundary instead of silently forgetting it. Partial
 * reconnect snapshots merge with retained continuity rather than replacing it.
 * Scanning and copying k incoming markers costs O(k * (64 + k)) before pruning;
 * the retained history never exceeds 64 markers.
 */
export function retainBridgetJournalGaps(
  previous: BridgetJournalGapState,
  incoming: BridgetJournalGap | ReadonlyArray<BridgetJournalGap> | null,
  firstRetainedSeq: number | null,
  incomingContinuityCut: BridgetJournalContinuityCut | null = null,
): BridgetJournalGapState {
  const incomingGaps = incoming === null ? [] : "from_seq" in incoming ? [incoming] : incoming;
  const withIncoming = incomingGaps.reduce<ReadonlyArray<BridgetJournalGap>>(
    (gaps, gap) => (gaps.some((current) => sameGap(current, gap)) ? gaps : [...gaps, gap]),
    previous.gaps,
  );
  const gaps =
    firstRetainedSeq === null
      ? withIncoming
      : withIncoming.filter((gap) => gap.to_seq >= firstRetainedSeq);
  const currentCut =
    previous.continuityCut !== null &&
    (firstRetainedSeq === null || previous.continuityCut.toSeq >= firstRetainedSeq)
      ? previous.continuityCut
      : null;
  const retainedIncomingCut =
    incomingContinuityCut !== null &&
    (firstRetainedSeq === null || incomingContinuityCut.toSeq >= firstRetainedSeq)
      ? incomingContinuityCut
      : null;
  const continuityCut =
    currentCut === null
      ? retainedIncomingCut
      : retainedIncomingCut === null
        ? currentCut
        : {
            fromSeq: Math.min(currentCut.fromSeq, retainedIncomingCut.fromSeq),
            toSeq: Math.max(currentCut.toSeq, retainedIncomingCut.toSeq),
            reason: "gap-pressure" as const,
          };
  if (gaps.length <= BRIDGET_JOURNAL_MAX_GAPS) {
    return { gaps, continuityCut };
  }
  const removed = gaps.slice(0, gaps.length - BRIDGET_JOURNAL_MAX_GAPS);
  const fromSeq = Math.min(
    continuityCut?.fromSeq ?? Number.POSITIVE_INFINITY,
    ...removed.map((gap) => gap.from_seq),
  );
  const toSeq = Math.max(
    continuityCut?.toSeq ?? Number.NEGATIVE_INFINITY,
    ...removed.map((gap) => gap.to_seq),
  );
  return {
    gaps: gaps.slice(-BRIDGET_JOURNAL_MAX_GAPS),
    continuityCut: { fromSeq, toSeq, reason: "gap-pressure" },
  };
}

export interface BridgetJournalTextBlock {
  readonly kind: "text";
  readonly key: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly sessionId: string;
  readonly content: string;
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
  readonly excerpt: boolean;
}

export interface BridgetJournalActivityBlock {
  readonly kind: "activity";
  readonly key: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly label: string;
  readonly text: string | null;
  readonly detail: string | null;
  readonly toolCallId: string | null;
  readonly exitCode: number | null;
  readonly status: string | null;
  readonly state: string | null;
  readonly outputTail: string | null;
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
  readonly excerpt: boolean;
}

export interface BridgetJournalTechnicalBlock {
  readonly kind: "technical";
  readonly key: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly label: string;
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly conflicts: ReadonlyArray<BridgetJournalConflict>;
  readonly excerpt: boolean;
}

export type BridgetJournalBlock =
  | BridgetJournalTextBlock
  | BridgetJournalActivityBlock
  | BridgetJournalTechnicalBlock;

export interface BridgetJournalProjectionInput {
  readonly events: ReadonlyArray<BridgetJournalEvent>;
  readonly gaps?: ReadonlyArray<BridgetJournalGap>;
  readonly continuityCut?: BridgetJournalContinuityCut | null;
  readonly conflicts?: ReadonlyArray<BridgetJournalConflict>;
  readonly beginsWithExcerpt?: boolean;
}

export interface BridgetJournalProjection {
  readonly blocks: ReadonlyArray<BridgetJournalBlock>;
  readonly sourceEvents: ReadonlyArray<BridgetJournalEvent>;
  readonly tailBlockIndex: number;
  readonly tailStartIndex: number;
  readonly input: BridgetJournalProjectionInput;
}

function knownActivity(
  event: BridgetJournalEvent,
): Omit<
  BridgetJournalActivityBlock,
  "key" | "firstSeq" | "lastSeq" | "events" | "conflicts" | "excerpt"
> | null {
  if (event.event !== "update" || !isPayloadRecord(event.payload)) return null;
  const kind = event.payload.kind;
  if (typeof kind !== "string" || kind === "text") return null;
  const text = typeof event.payload.text === "string" ? event.payload.text : null;
  const detail = typeof event.payload.detail === "string" ? event.payload.detail : null;
  const completed = kind === "command" && detail === "item/completed";
  const labels: Record<string, string> = {
    command:
      detail === "item/started"
        ? "Commande commencée"
        : completed
          ? "Commande terminée"
          : "Commande",
    tool: "Appel d’outil",
    tool_call: "Appel d’outil",
    file:
      event.payload.write_confirmed === true ? "Écriture de fichier confirmée" : "Activité fichier",
    artifact: "Artefact",
    plan: "Plan",
    approval: "Approbation",
    refusal: event.payload.attributed_to === "Bridget" ? "Refus attribué à Bridget" : "Refus",
  };
  if (!Object.prototype.hasOwnProperty.call(labels, kind)) return null;
  const label = labels[kind];
  if (label === undefined) return null;
  return {
    kind: "activity",
    label,
    text,
    detail,
    toolCallId: typeof event.payload.tool_call_id === "string" ? event.payload.tool_call_id : null,
    exitCode:
      completed && typeof event.payload.exit_code === "number" ? event.payload.exit_code : null,
    status: completed && typeof event.payload.status === "string" ? event.payload.status : null,
    state: completed && typeof event.payload.state === "string" ? event.payload.state : null,
    outputTail:
      completed && typeof event.payload.output_tail === "string" ? event.payload.output_tail : null,
  };
}

function textContent(event: BridgetJournalEvent): string | null {
  if (event.event !== "update" || !isPayloadRecord(event.payload) || event.payload.kind !== "text")
    return null;
  return typeof event.payload.content === "string" ? event.payload.content : null;
}

interface BridgetJournalBoundary {
  readonly separates: boolean;
  readonly excerpt: boolean;
}

function boundaryBefore(
  left: BridgetJournalEvent | undefined,
  right: BridgetJournalEvent,
  input: BridgetJournalProjectionInput,
): BridgetJournalBoundary {
  if (left === undefined) {
    const excerpt = input.beginsWithExcerpt === true;
    return { separates: excerpt, excerpt };
  }
  const deliveryChanged =
    left.message_id !== undefined &&
    right.message_id !== undefined &&
    left.message_id !== right.message_id;
  // A pressure cut may cover several forgotten gaps. Treat every transition
  // through that conservative interval as a boundary rather than merging one
  // of its hidden zones by accident.
  const crosses = (fromSeq: number, toSeq: number) => fromSeq <= right.seq && toSeq >= left.seq;
  const gapCrossed = (input.gaps ?? []).some((gap) => crosses(gap.from_seq, gap.to_seq));
  const cut = input.continuityCut;
  const cutCrossed = cut !== null && cut !== undefined && crosses(cut.fromSeq, cut.toSeq);
  const excerpt = gapCrossed || cutCrossed;
  return {
    separates: left.session_id !== right.session_id || deliveryChanged || excerpt,
    excerpt,
  };
}

function sameGaps(
  left: ReadonlyArray<BridgetJournalGap> | undefined,
  right: ReadonlyArray<BridgetJournalGap> | undefined,
) {
  return (
    left?.length === right?.length &&
    (left ?? []).every((gap, index) => {
      const other = right?.[index];
      return other !== undefined && sameGap(gap, other);
    })
  );
}

function sameConflicts(
  left: ReadonlyArray<BridgetJournalConflict> | undefined,
  right: ReadonlyArray<BridgetJournalConflict> | undefined,
) {
  return (
    left?.length === right?.length &&
    (left ?? []).every((conflict, index) => {
      const other = right?.[index];
      return (
        conflict === other ||
        (other !== undefined &&
          conflict.seq === other.seq &&
          conflict.first === other.first &&
          conflict.conflicting === other.conflicting &&
          conflict.additionalConflicts === other.additionalConflicts)
      );
    })
  );
}

function sameProjectionContext(
  left: BridgetJournalProjectionInput,
  right: BridgetJournalProjectionInput,
) {
  return (
    left.beginsWithExcerpt === right.beginsWithExcerpt &&
    left.continuityCut?.fromSeq === right.continuityCut?.fromSeq &&
    left.continuityCut?.toSeq === right.continuityCut?.toSeq &&
    sameGaps(left.gaps, right.gaps) &&
    sameConflicts(left.conflicts, right.conflicts)
  );
}

function buildProjection(
  input: BridgetJournalProjectionInput,
  startIndex: number,
  prefix: ReadonlyArray<BridgetJournalBlock>,
): BridgetJournalProjection {
  const conflictsBySeq = new Map(
    (input.conflicts ?? []).map((conflict) => [conflict.seq, conflict]),
  );
  const blocks = [...prefix];
  let textEvents: BridgetJournalEvent[] = [];
  let textParts: string[] = [];
  let textExcerpt = false;
  let tailStartIndex = startIndex;
  let tailBlockIndex = blocks.length;
  const closeText = () => {
    if (textEvents.length === 0) return;
    const first = textEvents[0]!;
    const last = textEvents[textEvents.length - 1]!;
    blocks.push({
      kind: "text",
      key: `text:${first.seq}`,
      firstSeq: first.seq,
      lastSeq: last.seq,
      sessionId: first.session_id,
      content: textParts.join(""),
      events: textEvents,
      conflicts: textEvents.flatMap((event) => {
        const conflict = conflictsBySeq.get(event.seq);
        return conflict ? [conflict] : [];
      }),
      excerpt: textExcerpt,
    });
    tailBlockIndex = blocks.length - 1;
    textEvents = [];
    textParts = [];
  };
  for (let index = startIndex; index < input.events.length; index += 1) {
    const event = input.events[index]!;
    const previous = index === 0 ? undefined : input.events[index - 1];
    const boundary = boundaryBefore(previous, event, input);
    const text = textContent(event);
    if (text !== null && !boundary.separates) {
      if (textEvents.length === 0) {
        tailStartIndex = index;
        textExcerpt = boundary.excerpt;
      }
      textEvents.push(event);
      textParts.push(text);
      continue;
    }
    closeText();
    if (text !== null) {
      tailStartIndex = index;
      textEvents = [event];
      textParts = [text];
      textExcerpt = boundary.excerpt;
      continue;
    }
    tailStartIndex = index;
    const conflict = conflictsBySeq.get(event.seq);
    const activity = knownActivity(event);
    if (activity) {
      blocks.push({
        ...activity,
        key: `activity:${event.seq}`,
        firstSeq: event.seq,
        lastSeq: event.seq,
        events: [event],
        conflicts: conflict ? [conflict] : [],
        excerpt: boundary.excerpt,
      });
    } else {
      blocks.push({
        kind: "technical",
        key: `technical:${event.seq}`,
        firstSeq: event.seq,
        lastSeq: event.seq,
        label: "Événement technique non interprété",
        events: [event],
        conflicts: conflict ? [conflict] : [],
        excerpt: boundary.excerpt,
      });
    }
    tailBlockIndex = blocks.length - 1;
  }
  closeText();
  return { blocks, sourceEvents: input.events, tailBlockIndex, tailStartIndex, input };
}

/**
 * Pure O(n + c) projection of the already bounded window, where c is the text
 * rendered. Appending to an unchanged input prefix preserves all closed block
 * identities and only rebuilds the current tail.
 */
export function projectBridgetJournal(
  input: BridgetJournalProjectionInput,
  previous?: BridgetJournalProjection,
): BridgetJournalProjection {
  if (previous && sameProjectionContext(previous.input, input)) {
    if (
      previous.sourceEvents.length === input.events.length &&
      previous.sourceEvents.every((event, index) => event === input.events[index])
    )
      return previous;
    const keepsPrefix =
      input.events.length >= previous.sourceEvents.length &&
      previous.sourceEvents.every((event, index) => event === input.events[index]);
    if (keepsPrefix) {
      const firstNew = input.events[previous.sourceEvents.length];
      const tail = previous.blocks[previous.tailBlockIndex];
      const canExtendTextTail =
        tail?.kind === "text" &&
        firstNew !== undefined &&
        textContent(firstNew) !== null &&
        !boundaryBefore(previous.sourceEvents.at(-1), firstNew, input).separates;
      if (!canExtendTextTail) {
        return buildProjection(input, previous.sourceEvents.length, previous.blocks);
      }
      return buildProjection(
        input,
        previous.tailStartIndex,
        previous.blocks.slice(0, previous.tailBlockIndex),
      );
    }
  }
  return buildProjection(input, 0, []);
}
