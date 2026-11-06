import type { ProviderInteractionMode } from "@t3tools/contracts";
import type { BridgetDelegationPreference } from "./ProviderAdapter.ts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`t3_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A login, token, PIN or pairing code only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Do not repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export interface T3DelegationInstructionState {
  readonly bridgetDelegationPreference?: BridgetDelegationPreference | undefined;
  /** A verified private mount, not a guarantee of daemon availability or admission. */
  readonly hasBridgetMcp?: boolean | undefined;
  readonly hasT3Mcp?: boolean;
}

const BRIDGET_DELEGATION_RULES = `
For this turn, use Bridget for new delegated work unless the user explicitly requests a T3-owned task. Use only the verified Bridget MCP tool \`bridget_auto_delegate\`; never invoke a same-named tool from a foreign server. If this tool loads lazily, make one bounded tool-catalog discovery attempt before declaring it absent. Do not start a model to discover a tool.

Let Bridget choose every unspecified fleet, provider, account, model and reasoning axis from its current catalog. Preserve each explicit human constraint, including \`workspace\` and \`expected_base_commit\` (the source commit SHA) when imposed. Use only the documented automatic delegation fields; do not invent a catalog or policy hash argument. Do not force the parent model onto the child. If a constraint cannot be satisfied, report the named constraint instead of weakening it.

Preserve the returned task ID, request/idempotency key, decision and execution references. On a lost response or retry, inspect and replay the same request using those references before creating any new work. For a new review round, create a new Bridget request with the full brief, prior findings and unresolved objections.

An absent tool, unavailable daemon, disabled mount, invalid policy, denied permission or refused admission stops the requested delegation: report the reason and continue any independent work already authorized. Never silently fall back to T3 \`delegate_task\`, native provider subagents, a terminal command or another host. This preference grants no permission and performs no automatic dispatch.

Keep existing work on its original engine. Manage existing T3 task IDs with \`task_status\` / \`task_cancel\`; manage existing Bridget task IDs with Bridget's status, journal, result and cancellation tools. Changing this preference never migrates, duplicates or restarts a task. Explicitly requested T3-owned delegation remains available through its existing tools. Ordinary top-level T3 threads, browser work and scheduling keep their existing purposes.`;

const BRIDGET_BLOCKED_INSTRUCTIONS = `
## Bridget delegation preference: blocked

For this turn, Bridget delegation cannot be selected because the routing preference is unreadable or the verified Bridget MCP mount is unavailable. Stop new delegated work and report this limitation explicitly. Do not silently use T3 \`delegate_task\`, native provider subagents or a terminal fallback. Existing tasks stay on their original engine: manage existing T3 task IDs with \`task_status\` / \`task_cancel\`, and existing Bridget task IDs with Bridget status, journal, result and cancellation tools. Preserve their IDs and replay references; never recreate their work. An explicit user request for T3-owned work is still handled through the existing T3 tools when available.`;

const BRIDGET_OFF_INSTRUCTIONS =
  "The Bridget delegation preference is off for this turn. Resume the usual delegation choices and keep existing tasks on their original engine.";

/** O(1): transforms a fixed application-owned text; no user data or credentials enter it. */
export function t3OrchestrationInstructions(input: T3DelegationInstructionState = {}): string {
  if ((input.bridgetDelegationPreference ?? "off") === "off")
    return input.hasT3Mcp === false ? BRIDGET_OFF_INSTRUCTIONS : T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  const policy =
    input.bridgetDelegationPreference === "prefer" && input.hasBridgetMcp === true
      ? "## Bridget delegation preference: prefer\n" + BRIDGET_DELEGATION_RULES
      : BRIDGET_BLOCKED_INSTRUCTIONS;
  if (input.hasT3Mcp === false) return policy;
  // Replace all historical delegation directives, rather than appending a conflicting preference.
  const ordinaryInstructions = T3_CODE_ORCHESTRATION_INSTRUCTIONS.split("\n")
    .filter(
      (line) =>
        !line.startsWith("- Subagents:") &&
        !line.startsWith("- Call `orchestrator_capabilities`") &&
        !line.startsWith("- Every new delegate review") &&
        !line.startsWith("- Follow a running delegate") &&
        !line.startsWith("- A delegated task/subagent") &&
        !line.startsWith("- For every T3 delegated review round") &&
        !line.startsWith("Tool names may include") &&
        !line.startsWith("ACP fallback:"),
    )
    .join("\n")
    .replace(
      "which suits orchestrating: each trigger arrives here and you delegate or dedupe",
      "each trigger returns here; apply this turn's delegation policy to any new child work",
    );
  return ordinaryInstructions + "\n" + policy;
}

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly bridgetDelegationPreference?: BridgetDelegationPreference | undefined;
  readonly hasDeviceTools?: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    (input.previousState.bridgetDelegationPreference ?? "off") ===
      (input.state.bridgetDelegationPreference ?? "off") &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim()] : []),
    ...(input.state.hasT3Mcp || (input.state.bridgetDelegationPreference ?? "off") !== "off"
      ? [t3OrchestrationInstructions({ ...input.state, hasBridgetMcp: false }).trim()]
      : input.previousState === undefined ||
          (input.previousState.bridgetDelegationPreference ?? "off") !== "off"
        ? [BRIDGET_OFF_INSTRUCTIONS]
        : []),
    ...(input.state.hasT3Mcp && input.state.hasDeviceTools
      ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS]
      : []),
    ...(input.state.hasT3Mcp && (input.state.bridgetDelegationPreference ?? "off") === "off"
      ? [T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** Prompt-based providers need fresh guidance after compaction and policy changes. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly runOrdinal?: number;
  readonly hasT3Mcp: boolean;
  readonly bridgetDelegationPreference?: BridgetDelegationPreference | undefined;
  readonly previousPreference?: BridgetDelegationPreference | undefined;
  readonly hasDeviceTools?: boolean;
  readonly orchestrationDelivered?: boolean;
  readonly deviceInstructionsDelivered?: boolean;
}): string {
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const preference = input.bridgetDelegationPreference ?? "off";
  const delivered = input.orchestrationDelivered ?? input.runOrdinal !== 1;
  // A resumed conversation may retain ON; clear it without repeating delivered native guidance.
  if (delivered && input.previousPreference === undefined && preference === "off") {
    const instructions = [
      BRIDGET_OFF_INSTRUCTIONS,
      ...(input.hasT3Mcp && input.hasDeviceTools && !input.deviceInstructionsDelivered
        ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS]
        : []),
    ].join("\n\n");
    return prependT3OrchestrationInstructions(input.prompt, instructions);
  }
  if (!delivered || input.previousPreference !== preference) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      t3OrchestrationSystemPrompt(input.hasT3Mcp, input.hasDeviceTools ?? false, input) ??
        BRIDGET_OFF_INSTRUCTIONS,
    );
  }
  return input.hasT3Mcp && input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  deviceOrDelegation: boolean | T3DelegationInstructionState = false,
  delegationInput: T3DelegationInstructionState = {},
): string | undefined {
  const delegation = typeof deviceOrDelegation === "boolean" ? delegationInput : deviceOrDelegation;
  if (!hasT3Mcp && (delegation.bridgetDelegationPreference ?? "off") === "off") return undefined;
  const instructions = t3OrchestrationInstructions({ ...delegation, hasT3Mcp });
  return typeof deviceOrDelegation === "boolean" && deviceOrDelegation && hasT3Mcp
    ? instructions + "\n" + T3_CODE_DEVICE_TOOL_INSTRUCTIONS + "\n"
    : instructions;
}
