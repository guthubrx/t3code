import { describe, expect, it } from "vite-plus/test";
import type { BridgetComposerState } from "@t3tools/contracts";
import { bridgetComposerProvider, bridgetComposerSelection } from "./BridgetComposer.logic";

const task = {
  task_id: "25000000-0000-4000-8000-000000000001",
  execution_protocol: "codex_app_server" as const,
};
const state: BridgetComposerState = {
  version: 1,
  status: "ok",
  task_id: task.task_id,
  request_id: "25000000-0000-4000-8000-000000000002",
  round: 3,
  state: "working",
  outcome: "observed",
  code: null,
  message: "Réglage confirmé pour les prochains tours.",
  selection: { model: "child-model", effort: "high" },
  models: [{ id: "child-model", name: "Child model", efforts: ["low", "high"] }],
  capabilities: {
    send: true,
    steer: true,
    interrupt: true,
    select_runtime: true,
    attachments: false,
  },
};

describe("native child composer presentation", () => {
  it("shows only the child's confirmed catalogue and effort", () => {
    const provider = bridgetComposerProvider(task, state, "full-access");
    expect(provider.models).toEqual([
      {
        slug: "child-model",
        name: "Child model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "low" },
                { id: "high", label: "high" },
              ],
              currentValue: "high",
            },
          ],
        },
      },
    ]);
    expect(bridgetComposerSelection(provider, state)).toEqual({
      instanceId: provider.instanceId,
      model: "child-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(provider.auth.status).toBe("unknown");
    expect(provider.supportedRuntimeModes).toEqual(["full-access"]);
  });

  it("does not invent a catalogue or selection while the child is unavailable", () => {
    const unavailable: BridgetComposerState = {
      ...state,
      models: [],
      selection: null,
      capabilities: { ...state.capabilities, send: false, select_runtime: false },
    };
    const provider = bridgetComposerProvider(task, unavailable);
    expect(provider.models).toEqual([]);
    expect(provider.status).toBe("warning");
    expect(bridgetComposerSelection(provider, unavailable)).toBeNull();
  });

  it("supports a confirmed model without an effort control", () => {
    const simple: BridgetComposerState = {
      ...state,
      selection: { model: "simple", effort: null },
      models: [{ id: "simple", name: "Simple", efforts: [] }],
    };
    const provider = bridgetComposerProvider(task, simple);
    expect(provider.models[0]?.capabilities?.optionDescriptors).toEqual([]);
    expect(bridgetComposerSelection(provider, simple)).not.toHaveProperty("options");
  });
});
