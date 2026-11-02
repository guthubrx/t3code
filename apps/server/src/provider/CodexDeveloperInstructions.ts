import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  t3OrchestrationInstructions,
  type T3DelegationInstructionState,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** O(n), over the fixed application text. Keep routing guidance within Codex's byte cap. */
function orchestrationSections(delegation: T3DelegationInstructionState): readonly string[] {
  if ((delegation.bridgetDelegationPreference ?? "off") === "off" && delegation.hasT3Mcp !== false)
    return T3_CODE_ORCHESTRATION_SECTIONS;
  const encoder = new TextEncoder();
  const sections: string[] = [];
  let current = "";
  let bytes = 0;
  for (const word of t3OrchestrationInstructions(delegation)
    .trim()
    .match(/\S+\s*/g) ?? []) {
    const wordBytes = encoder.encode(word).length;
    if (bytes + wordBytes > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES && current.length > 0) {
      sections.push(current.trimEnd());
      current = "";
      bytes = 0;
    }
    current += word;
    bytes += wordBytes;
  }
  if (current.length > 0) sections.push(current.trimEnd());
  return sections;
}

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  delegation: T3DelegationInstructionState = {},
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      orchestrationSections(delegation).map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
