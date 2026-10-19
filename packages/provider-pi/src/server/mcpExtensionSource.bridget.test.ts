import { assert, describe, it } from "@effect/vitest";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

describe("SPEC169 private Pi policy control", () => {
  it("keeps ON blocked without advertising a missing T3 mount", async () => {
    const bridge = await loadMcpBridge({ hasT3Mcp: false, initialPolicy: "blocked" });
    const render = async () =>
      (
        await bridge.handlers.get("before_agent_start")!(
          { systemPrompt: "Pi" },
          { ui: { notify: () => undefined } },
        )
      ).systemPrompt;
    assert.include(await render(), "preference: blocked");
    assert.notInclude(await render(), "orchestrator_capabilities");
    await bridge.setPolicy("off 0123456789abcdef");
    assert.equal(await render(), "Pi");
    await bridge.setPolicy("blocked fedcba9876543210");
    assert.include(await render(), "preference: blocked");
    assert.notInclude(await render(), "orchestrator_capabilities");
    assert.equal(bridge.tools.length, 0);
    assert.equal(bridge.requests.length, 0);
  });
  it("starts blocked, acknowledges only valid correlated assignments and restores OFF", async () => {
    const bridge = await loadMcpBridge({ initialPolicy: "blocked" });
    const render = async () =>
      (
        await bridge.handlers.get("before_agent_start")!(
          { systemPrompt: "Pi" },
          { ui: { notify: () => undefined } },
        )
      ).systemPrompt;
    assert.include(await render(), "preference: blocked");
    assert.equal(bridge.receipts.length, 0);
    await bridge.setPolicy("off 0123456789abcdef");
    assert.include(await render(), "Prefer native subagent tools");
    assert.deepEqual(bridge.receipts.at(-1), ["t3-bridget-policy:0123456789abcdef", "off"]);
    for (const invalid of [
      "prefer",
      "off x",
      "blocked 0123456789abcdef extra",
      "untrusted 0123456789abcdef",
      "prefer 0123456789abcdeG",
    ]) {
      let rejected = false;
      try {
        await bridge.setPolicy(invalid);
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected);
      assert.include(await render(), "Prefer native subagent tools");
      assert.equal(bridge.receipts.length, 1);
    }
    await bridge.setPolicy("prefer fedcba9876543210");
    assert.include(await render(), "preference: blocked");
    assert.notInclude(await render(), "Prefer native subagent tools");
    assert.deepEqual(bridge.receipts.at(-1), ["t3-bridget-policy:fedcba9876543210", "prefer"]);
  });
});
