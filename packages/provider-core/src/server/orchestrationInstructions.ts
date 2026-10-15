import type { ProviderInteractionMode } from "@t3tools/contracts";
import type { BridgetDelegationPreference } from "./ProviderAdapter.ts";

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. Use \`orchestrator_capabilities\` to discover the current provider/model IDs from the same live catalog as the composer, including configured custom models. Do not treat a native tool's model list as the full list of available subagent models. Prefer native subagent tools for same-provider work only when they support the chosen model. Use \`delegate_task\` with that provider instance and model when native tools cannot, including for same-provider work. Also use \`delegate_task\` for cross-provider or explicitly T3-owned child tasks. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent, not the target for starting another delegated review round.
- \`t3_thread_launch\` and \`create_threads\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- For every T3 delegated review round, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule, or \`{"type":"webhook"}\` to run on each request to the returned \`webhookUrl\` (the run sees the request only through \`{{body.path}}\`-style placeholders in the prompt). By default runs return to the current thread, which suits orchestrating: each trigger arrives here and you delegate or dedupe; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling a timer, report the returned cadence and next run time; for a webhook, report its \`webhookUrl\`, or say T3 Connect remote access is needed if it is missing.
- When you need a secret from the user (a token, API key, or webhook signing secret), call \`request_secret\` so they enter it privately, then pass the returned \`secretRef\` to the tool that needs it, e.g. \`signature.secretRef\` on a webhook task for a sender that signs requests such as GitHub. A \`secretRef\` works once. Never ask for a secret in chat, never invent one, and never repeat one.
- To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.

### Choose the workspace before starting a new thread

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\`. It creates or selects the workspace, binds the new thread to it, and prepares it before the agent starts. Put the task in \`message\`, not \`prompt\`:

- New worktree: \`{"title":"UI cleanup","workspaceStrategy":{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup","startFromOrigin":false},"message":"Implement the cleanup and open a PR against feature/base."}\`
- Existing worktree: \`{"title":"Continue cleanup","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/absolute/path/to/worktree","branch":"feature/ui-cleanup"},"message":"Continue the cleanup."}\`
- Project's main checkout: \`workspaceStrategy:{"type":"root"}\`. Omitting workspaceStrategy also selects root; it does not inherit the caller's worktree.

For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Use \`startFromOrigin:true\` when you intend to fetch and start from origin. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths. Project, model selection, and modes inherit unless supplied; a launched thread may not run with broader modes than yours.

\`t3_thread_launch\` is the single-thread launch tool. Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree and has no workspace override. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.

\`t3_thread_launch\` has no idempotency key. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.

Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.
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

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly bridgetDelegationPreference?: BridgetDelegationPreference | undefined;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
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
      (input.state.bridgetDelegationPreference ?? "off")
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
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
  readonly bridgetDelegationPreference?: BridgetDelegationPreference | undefined;
  readonly previousPreference?: BridgetDelegationPreference | undefined;
}): string {
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const preference = input.bridgetDelegationPreference ?? "off";
  if (input.runOrdinal !== 1 && input.previousPreference === preference) return input.prompt;
  // A resumed native conversation can retain ON while this process has no prior state.
  // Send the current OFF explicitly before its first ordinary prompt, even without MCP.
  return prependT3OrchestrationInstructions(
    input.prompt,
    t3OrchestrationSystemPrompt(input.hasT3Mcp, input) ?? BRIDGET_OFF_INSTRUCTIONS,
  );
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  delegation: T3DelegationInstructionState = {},
): string | undefined {
  return hasT3Mcp || (delegation.bridgetDelegationPreference ?? "off") !== "off"
    ? t3OrchestrationInstructions({ ...delegation, hasT3Mcp })
    : undefined;
}
