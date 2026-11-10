import {
  ProviderDriverKind,
  ProviderInstanceId,
  type BridgetComposerState,
  type BridgetLineageTask,
  type ModelSelection,
  type ServerProvider,
  type RuntimeMode,
} from "@t3tools/contracts";

/** Presentation adapter only: every choice comes from the native child's response. */
export function bridgetComposerProvider(
  task: Pick<BridgetLineageTask, "task_id" | "execution_protocol">,
  state: BridgetComposerState,
  runtimeMode?: RuntimeMode,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`bridget-${task.task_id}`),
    driver: ProviderDriverKind.make(
      task.execution_protocol === "codex_app_server" ? "codex" : "claude",
    ),
    displayName: "Agent Bridget",
    enabled: true,
    installed: true,
    version: null,
    status: state.capabilities.send ? "ready" : "warning",
    auth: { status: "unknown" },
    checkedAt: new Date().toISOString(),
    showInteractionModeToggle: false,
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    ...(runtimeMode ? { supportedRuntimeModes: [runtimeMode] } : {}),
    models: state.models.map((model) => ({
      slug: model.id,
      name: model.name,
      isCustom: false,
      capabilities: {
        optionDescriptors:
          model.efforts.length === 0
            ? []
            : [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  role: "reasoning",
                  options: model.efforts.map((id) => ({ id, label: id })),
                  ...(state.selection?.model === model.id && state.selection.effort
                    ? { currentValue: state.selection.effort }
                    : {}),
                },
              ],
      },
    })),
    slashCommands: [],
    skills: [],
  };
}

export function bridgetComposerSelection(
  provider: ServerProvider,
  state: BridgetComposerState,
): ModelSelection | null {
  if (!state.selection) return null;
  return {
    instanceId: provider.instanceId,
    model: state.selection.model,
    ...(state.selection.effort
      ? { options: [{ id: "reasoningEffort", value: state.selection.effort }] }
      : {}),
  };
}
