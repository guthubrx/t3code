import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
  t3OrchestrationInstructions,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        previousPreference: "off",
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

describe("SPEC169 delegation guidance", () => {
  it("R2 resets unknown persisted policies without inventing missing MCP tools", () => {
    const prompt = "Resume existing work";
    const off = t3OrchestrationInstructions({
      bridgetDelegationPreference: "off",
      hasT3Mcp: false,
    });
    assert.include(off, "preference is off for this turn");
    assert.notInclude(off, "orchestrator_capabilities");
    for (const hasT3Mcp of [false, true]) {
      const resumed = t3OrchestrationPrompt({ prompt, runOrdinal: 8, hasT3Mcp });
      assert.include(
        resumed,
        hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim() : "preference is off for this turn",
      );
      assert.equal(
        t3OrchestrationPrompt({ prompt: "/compact", runOrdinal: 8, hasT3Mcp }),
        "/compact",
      );
      const acp = t3AcpPromptWithInstructions({
        prompt,
        state: { interactionMode: "default", hasT3Mcp },
      });
      assert.include(
        acp,
        hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim() : "preference is off for this turn",
      );
    }
  });
  it("keeps the legacy OFF text byte-identical and removes conflicting ON routes", () => {
    assert.strictEqual(t3OrchestrationInstructions(), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    const preferred = t3OrchestrationInstructions({
      bridgetDelegationPreference: "prefer",
      hasBridgetMcp: true,
    });
    assert.include(preferred, "bridget_auto_delegate");
    for (const obsolete of [
      "Prefer native subagent tools",
      "Subagents: use your native tool",
      "`spawn_agent`",
      "Call `orchestrator_capabilities`",
      "Every new delegate review",
      "Follow a running delegate",
      "Use `delegate_task` with that provider",
      "For every T3 delegated review round",
      "you delegate or dedupe",
      "before reporting that the capability is absent",
      "acp-mcp-call delegate_task",
    ])
      assert.notInclude(preferred, obsolete);
    for (const retained of [
      "t3_thread_launch",
      "create_threads",
      "schedule_task",
      "request_secret",
      "Visuals and preview",
    ])
      assert.include(preferred, retained);
    for (const constraint of [
      "every unspecified fleet",
      "explicit human constraint",
      "expected_base_commit",
      "parent model",
      "idempotency key",
      "original engine",
    ])
      assert.include(preferred, constraint);
    assert.include(preferred, "one bounded tool-catalog discovery attempt");
    assert.include(preferred, "Never silently fall back");
  });
  it("blocks an unavailable or untrusted route without inventing a T3 mount", () => {
    for (const preference of ["prefer", "blocked"] as const) {
      const text = t3OrchestrationSystemPrompt(false, { bridgetDelegationPreference: preference });
      assert.include(text!, "preference: blocked");
      assert.include(text!, "Stop new delegated work");
      assert.include(text!, "task_status");
      assert.include(text!, "task_cancel");
      assert.notInclude(text!, "The `t3-code` MCP server provides");
    }
  });
  it("reinjects ACP and first-prompt guidance after each policy transition, preserving slash commands", () => {
    const off = {
      interactionMode: "default",
      hasT3Mcp: true,
      bridgetDelegationPreference: "off",
    } as const;
    const on = { ...off, bridgetDelegationPreference: "prefer" } as const;
    assert.include(
      t3AcpPromptWithInstructions({ prompt: "Continue", state: on, previousState: off }),
      "preference: blocked",
    );
    assert.include(
      t3AcpPromptWithInstructions({ prompt: "Continue", state: off, previousState: on }),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    );
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "/compact", state: on, previousState: off }),
      "/compact",
    );
    assert.include(
      t3OrchestrationPrompt({
        prompt: "Continue",
        runOrdinal: 2,
        hasT3Mcp: true,
        previousPreference: "off",
        bridgetDelegationPreference: "prefer",
      }),
      "preference: blocked",
    );
    assert.equal(
      t3OrchestrationPrompt({
        prompt: "/model example",
        runOrdinal: 2,
        hasT3Mcp: true,
        previousPreference: "off",
        bridgetDelegationPreference: "prefer",
      }),
      "/model example",
    );
  });
});
