import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
  t3OrchestrationInstructions,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects the current mode initially and skips an unchanged known policy", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({
        prompt,
        runOrdinal: 2,
        hasT3Mcp: true,
        previousPreference: "off",
      }),
      prompt,
    );
    assert.include(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      "preference is off for this turn",
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
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
      const resumed = t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 8, hasT3Mcp });
      assert.include(
        resumed,
        hasT3Mcp ? "Prefer native subagent tools" : "preference is off for this turn",
      );
      assert.equal(
        t3OrchestrationPromptForFirstRun({ prompt: "/compact", runOrdinal: 8, hasT3Mcp }),
        "/compact",
      );
      const acp = t3AcpPromptWithInstructions({
        prompt,
        state: { interactionMode: "default", hasT3Mcp },
      });
      assert.include(
        acp,
        hasT3Mcp ? "Prefer native subagent tools" : "preference is off for this turn",
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
      "Use `delegate_task` with that provider",
      "For every T3 delegated review round",
      "you delegate or dedupe",
      "before reporting that the capability is absent",
      "acp-mcp-call delegate_task",
    ])
      assert.notInclude(preferred, obsolete);
    for (const retained of [
      "ordinary top-level T3 conversations",
      "schedule_task",
      "request_secret",
      "Showing visuals",
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
      "Prefer native subagent tools",
    );
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "/compact", state: on, previousState: off }),
      "/compact",
    );
    assert.include(
      t3OrchestrationPromptForFirstRun({
        prompt: "Continue",
        runOrdinal: 2,
        hasT3Mcp: true,
        previousPreference: "off",
        bridgetDelegationPreference: "prefer",
      }),
      "preference: blocked",
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({
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
