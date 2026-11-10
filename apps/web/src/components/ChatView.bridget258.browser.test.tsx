import { createMemoryHistory } from "@tanstack/react-router";
import {
  ThreadId,
  WS_METHODS,
  type BridgetComposerState,
  type BridgetLineageComposeInput,
  type BridgetLineageTask,
  type BridgetJournalEvent,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import "~/index.css";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const taskId = "25000000-0000-4000-8000-000000000001";
const rootId = ThreadId.make("native-parent");
const childId = ThreadId.make("native-child");
const task: BridgetLineageTask = {
  task_id: taskId,
  parent_task_id: null,
  parent_agent_id: "25000000-0000-4000-8000-000000000002",
  child_agent_id: "25000000-0000-4000-8000-000000000003",
  child_instance_id: "native-instance",
  created_at: 1794290000,
  updated_at: 1794290000,
  started_at: 1794290000,
  completed_at: null,
  agent_type: "codex",
  execution_protocol: "codex_app_server",
  model: "native-model",
  effort: "high",
  cwd: "/workspace/render",
  posture: "development",
  title: "Enfant de vérification",
  status: "working",
  error: null,
  result_available: false,
  journal_available: true,
};
const child: FakeThread = {
  id: childId,
  title: task.title,
  runs: [],
  items: [],
  native: {
    bridgetTask: task,
    bridgetTaskRef: {
      version: 1,
      taskId,
      rootThreadId: rootId,
      parentTaskId: null,
      generation: "25000000-0000-4000-8000-000000000004",
      seq: 1,
      status: "working",
    },
  },
};
const event = (
  seq: number,
  type: string,
  payload: BridgetJournalEvent["payload"],
): BridgetJournalEvent => ({
  v: 1,
  seq,
  ts: `2026-11-10T06:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}Z`,
  session_id: "native-test",
  event: type,
  payload,
});

it.each([true, false])(
  "the complete child page uses the common composer and follows native journal updates (runtime selection %s)",
  async (selectRuntime) => {
    await page.viewport(1400, 900);
    const commands: BridgetLineageComposeInput[] = [];
    let publishJournal: ((value: unknown) => void) | null = null;
    const events = [
      event(1, "turn_start", { body: "Vérifier les sources natives." }),
      event(2, "update", {
        kind: "text",
        content: "Début du contrôle.\n\n" + "Une ligne de résultat conservée.\n\n".repeat(80),
      }),
      event(3, "update", {
        kind: "command",
        detail: "item/completed",
        text: "git diff --check",
        exit_code: 0,
        state: "completed",
        output_tail: "Vérification terminée.",
      }),
    ];
    using _environment = installFakeEnvironment(
      [{ id: rootId, title: "Parent natif", runs: [], items: [] }, child],
      {
        [WS_METHODS.bridgetLineageCompose]: (input: BridgetLineageComposeInput) => {
          commands.push(input);
          return Effect.succeed({
            version: 1,
            status: "ok",
            task_id: input.taskId,
            request_id: input.requestId,
            round: 3,
            state: "working",
            outcome: input.operation.kind === "read" ? "observed" : "accepted",
            code: null,
            message: "Réglage confirmé pour les prochains tours.",
            selection: { model: "native-model", effort: "high" },
            models: [{ id: "native-model", name: "Modèle de l’enfant", efforts: ["low", "high"] }],
            capabilities: {
              send: true,
              steer: true,
              interrupt: true,
              select_runtime: selectRuntime,
              attachments: false,
            },
          } satisfies BridgetComposerState);
        },
        [WS_METHODS.bridgetLineageJournal]: () =>
          Stream.concat(
            Stream.make({
              version: 1,
              status: "ok",
              task_id: taskId,
              events,
              next_seq: 3,
              caught_up: true,
              gap: null,
            }),
            Stream.callback<unknown>((queue) =>
              Effect.sync(() => {
                publishJournal = (value) => {
                  Queue.offerUnsafe(queue, value);
                };
              }),
            ),
          ),
        [WS_METHODS.bridgetLineageWatch]: () => Stream.make({ version: 1, seq: 1 }),
        [WS_METHODS.bridgetLineageRead]: () =>
          Effect.succeed({
            version: 1,
            status: "ok",
            generation: child.native!.bridgetTaskRef!.generation,
            seq: 1,
            root_owner_agent_id: task.parent_agent_id,
            tasks: [task],
          }),
      },
    );
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${childId}`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    await using _screen = await render(<AppRoot router={router} />, { container, router: false });
    const editor = page.getByTestId("composer-editor");
    try {
      await expect.element(editor, { timeout: 5000 }).toBeVisible();
    } catch (error) {
      console.log("native-page-state", commands, document.body.innerText.slice(-7000));
      throw error;
    }
    await vi.waitFor(() =>
      expect(commands.filter((command) => command.operation.kind === "read")).toHaveLength(1),
    );
    await expect
      .element(page.getByText("Modèle de l’enfant", { exact: true }).first(), { timeout: 3000 })
      .toBeVisible();
    if (selectRuntime) {
      await userEvent.click(
        page.getByRole("button", { name: "Modèle de l’enfant, high", exact: true }),
      );
      await expect
        .element(page.getByRole("button", { name: /Permissions:/ }))
        .not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
    } else {
      await expect
        .element(page.getByRole("button", { name: "Modèle de l’enfant, high", exact: true }))
        .toBeDisabled();
    }
    await userEvent.click(editor);
    await userEvent.type(editor, "Poursuivre la vérification");
    await userEvent.click(page.getByRole("button", { name: "Steer message", exact: true }));
    await vi.waitFor(() =>
      expect(commands.filter((command) => command.operation.kind === "send")).toHaveLength(1),
    );
    const send = commands.find((command) => command.operation.kind === "send")!;
    expect(send).toMatchObject({
      projectId: PROJECT_ID,
      threadId: rootId,
      taskId,
      expectedRound: 3,
      operation: { kind: "send", body: "Poursuivre la vérification", intent: "steer" },
    });
    await expect.element(editor).not.toHaveTextContent("Poursuivre la vérification");
    await act(() =>
      publishJournal!({
        version: 1,
        status: "ok",
        task_id: taskId,
        events: [
          event(4, "update", {
            kind: "text",
            content: "Dernière ligne native visible après mise à jour.",
          }),
        ],
        next_seq: 4,
        caught_up: true,
        gap: null,
      }),
    );
    await expect
      .element(page.getByText("Dernière ligne native visible après mise à jour.", { exact: false }))
      .toBeVisible();
    const lastLine = () =>
      Array.from(_screen.container.querySelectorAll("p")).find(
        (paragraph) => paragraph.textContent === "Dernière ligne native visible après mise à jour.",
      );
    await vi.waitFor(() => {
      const line = lastLine();
      expect(line).toBeDefined();
      const bounds = line!.getBoundingClientRect();
      const composer = _screen.container
        .querySelector('[data-chat-composer-overlay="true"]')!
        .getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(composer.top + 1);
    });
    await userEvent.click(editor);
    await userEvent.keyboard("{PageUp}");
    await expect
      .element(page.getByRole("button", { name: /Scroll to end/ }), { timeout: 3000 })
      .toBeVisible();
    await act(() =>
      publishJournal!({
        version: 1,
        status: "ok",
        task_id: taskId,
        events: [
          event(5, "update", {
            kind: "text",
            content: "\n\nNouvelle fin pendant la lecture du début.",
          }),
        ],
        next_seq: 5,
        caught_up: true,
        gap: null,
      }),
    );
    await expect.element(page.getByRole("button", { name: /Scroll to end/ })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /Scroll to end/ }));
    await vi.waitFor(() => {
      const line = Array.from(_screen.container.querySelectorAll("p")).find(
        (paragraph) => paragraph.textContent === "Nouvelle fin pendant la lecture du début.",
      );
      expect(line).toBeDefined();
      const composer = _screen.container
        .querySelector('[data-chat-composer-overlay="true"]')!
        .getBoundingClientRect();
      expect(line!.getBoundingClientRect().bottom).toBeLessThanOrEqual(composer.top + 1);
    });
    await expect
      .element(page.getByRole("button", { name: "Stop generation", exact: true }))
      .toBeVisible();
  },
);
