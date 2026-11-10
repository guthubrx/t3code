import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BridgetComposerState,
  type BridgetLineageComposeInput,
  type BridgetNativeTaskStatus,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useBridgetComposer } from "./useBridgetComposer";

const mocks = vi.hoisted(() => ({ compose: vi.fn(), allowed: true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.compose }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.allowed }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { bridgetLineageCompose: {} },
}));
const env = EnvironmentId.make("native-host");
const root = ThreadId.make("parent");
const taskA = "25000000-0000-4000-8000-000000000001";
const taskB = "25000000-0000-4000-8000-000000000002";
const viewRef = (task: string) => scopeThreadRef(env, ThreadId.make(`child-${task}`));
type Hook = ReturnType<typeof useBridgetComposer>;
type Call = { environmentId: EnvironmentId; input: BridgetLineageComposeInput };
const observed = (
  input: BridgetLineageComposeInput,
  outcome: BridgetComposerState["outcome"] = "observed",
): BridgetComposerState => ({
  version: 1,
  status: "ok",
  task_id: input.taskId,
  request_id: input.requestId,
  round: 3,
  state: "working",
  outcome,
  code: outcome === "refused" ? "target_unavailable" : null,
  message: "État natif",
  selection: null,
  models: [],
  capabilities: {
    send: true,
    steer: true,
    interrupt: true,
    select_runtime: false,
    attachments: false,
  },
});
function Harness({
  task = taskA,
  seq = 1,
  generation = task,
  status = "working",
  handle,
}: {
  task?: string;
  seq?: number;
  generation?: string;
  status?: BridgetNativeTaskStatus;
  handle: RefObject<Hook | null>;
}) {
  const composer = useBridgetComposer({
    environmentId: env,
    threadRef: viewRef(task),
    thread: {
      projectId: ProjectId.make("native-project"),
      runtimeMode: "full-access",
      bridgetTaskRef: {
        version: 1,
        taskId: task,
        rootThreadId: root,
        parentTaskId: null,
        generation,
        seq,
        status,
      },
    },
  });
  useImperativeHandle(handle, () => composer);
  return <div>{composer.state?.task_id ?? "loading"}</div>;
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  mocks.allowed = true;
  mocks.compose
    .mockReset()
    .mockImplementation(async ({ input }: Call) => ({ _tag: "Success", value: observed(input) }));
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  return {
    [Symbol.dispose]: () => {
      mocks.compose.mockReset();
    },
  };
}
describe("native child command lifetime", () => {
  it("refreshes a new lineage generation even when sequence and task state are unchanged", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(mocks.compose).toHaveBeenCalledTimes(1));
    await screen.rerender(<Harness handle={handle} generation={taskB} />);
    await vi.waitFor(() => expect(mocks.compose).toHaveBeenCalledTimes(2));
    expect((mocks.compose.mock.calls[1]![0] as Call).input.operation).toEqual({ kind: "read" });
  });
  it("never dispatches operations absent from the native capability response", async () => {
    using _setup = setup();
    mocks.compose.mockImplementation(async ({ input }: Call) => ({
      _tag: "Success",
      value: {
        ...observed(input),
        capabilities: {
          send: false,
          steer: false,
          interrupt: false,
          select_runtime: false,
          attachments: false,
        },
      },
    }));
    const handle = { current: null as Hook | null };
    await using _screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    await act(() => {
      handle.current!.send("Conserver");
      handle.current!.interrupt();
      handle.current!.selectModel("child-model");
      handle.current!.selectOptions([{ id: "reasoningEffort", value: "low" }]);
    });
    expect(mocks.compose).toHaveBeenCalledTimes(1);
  });

  it("rereads a changed binding after its old command settles instead of restoring old capabilities", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    const result = deferred();
    mocks.compose.mockImplementationOnce(() => result.promise);
    await act(() => handle.current!.interrupt());
    const old = (mocks.compose.mock.calls[1]![0] as Call).input;
    await screen.rerender(<Harness handle={handle} seq={2} status="result_available" />);
    mocks.compose.mockImplementationOnce(async ({ input }: Call) => ({
      _tag: "Success",
      value: {
        ...observed(input),
        state: "result_available",
        capabilities: {
          send: false,
          steer: false,
          interrupt: false,
          select_runtime: false,
          attachments: false,
        },
      },
    }));
    await act(() => result.resolve({ _tag: "Success", value: observed(old, "accepted") }));
    await vi.waitFor(() => expect(handle.current?.state?.state).toBe("result_available"));
    expect(handle.current?.state?.capabilities.send).toBe(false);
    expect(mocks.compose).toHaveBeenCalledTimes(3);
    expect((mocks.compose.mock.calls[2]![0] as Call).input.operation).toEqual({ kind: "read" });
  });

  it("settles a known command after unmount without starting another native read", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    const result = deferred();
    mocks.compose.mockImplementationOnce(() => result.promise);
    useComposerDraftStore.getState().setPrompt(viewRef(taskA), "Conserver jusqu'à acceptation");
    await act(() => handle.current!.send("Conserver jusqu'à acceptation"));
    const request = (mocks.compose.mock.calls[1]![0] as Call).input;
    await screen.unmount();
    await act(() => result.resolve({ _tag: "Success", value: observed(request, "accepted") }));
    expect(mocks.compose).toHaveBeenCalledTimes(2);
    expect(useComposerDraftStore.getState().getComposerDraft(viewRef(taskA))?.prompt ?? "").toBe(
      "",
    );
  });

  it("serializes double clicks and preserves text typed while the command is in flight", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using _screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state?.round).toBe(3));
    const result = deferred();
    mocks.compose.mockImplementationOnce(() => result.promise);
    useComposerDraftStore.getState().setPrompt(viewRef(taskA), "Message envoyé");
    await act(() => {
      handle.current!.send("Message envoyé");
      handle.current!.send("Message envoyé");
    });
    expect(mocks.compose).toHaveBeenCalledTimes(2); // one read, one send
    const request = (mocks.compose.mock.calls[1]![0] as Call).input;
    expect(request).toMatchObject({
      taskId: taskA,
      threadId: root,
      expectedRound: 3,
      operation: { kind: "send", intent: "queue" },
    });
    useComposerDraftStore.getState().setPrompt(viewRef(taskA), "Texte suivant");
    await act(() => result.resolve({ _tag: "Success", value: observed(request, "accepted") }));
    expect(useComposerDraftStore.getState().getComposerDraft(viewRef(taskA))?.prompt).toBe(
      "Texte suivant",
    );
    expect(handle.current?.pending).toBeUndefined();
  });

  it("never automatically resends an unknown command; explicit retry keeps its exact key", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using _screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    useComposerDraftStore.getState().setPrompt(viewRef(taskA), "Conserver");
    mocks.compose.mockRejectedValueOnce(new Error("transport lost"));
    await act(() => handle.current!.send("Conserver", true));
    await vi.waitFor(() => expect(handle.current?.busy).toBe(false));
    const request = (mocks.compose.mock.calls[1]![0] as Call).input;
    expect(handle.current?.pending).toEqual(request);
    await act(() => handle.current!.refresh());
    expect((mocks.compose.mock.calls[2]![0] as Call).input.operation).toEqual({ kind: "read" });
    expect(handle.current?.pending).toEqual(request);
    mocks.compose.mockImplementationOnce(async () => ({
      _tag: "Success",
      value: observed(request, "accepted"),
    }));
    await act(() => handle.current!.retry());
    expect((mocks.compose.mock.calls[3]![0] as Call).input).toEqual(request);
    expect(useComposerDraftStore.getState().getComposerDraft(viewRef(taskA))?.prompt ?? "").toBe(
      "",
    );
  });

  it("does not show another child's late response after navigation", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    const result = deferred();
    mocks.compose.mockImplementationOnce(() => result.promise);
    await act(() => handle.current!.interrupt());
    const request = (mocks.compose.mock.calls[1]![0] as Call).input;
    await screen.rerender(<Harness task={taskB} handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state?.task_id).toBe(taskB));
    await act(() => result.resolve({ _tag: "Success", value: observed(request, "accepted") }));
    expect(handle.current?.state?.task_id).toBe(taskB);
  });

  it("keeps a refused draft and releases only the resolved command", async () => {
    using _setup = setup();
    const handle = { current: null as Hook | null };
    await using _screen = await render(<Harness handle={handle} />);
    await vi.waitFor(() => expect(handle.current?.state).not.toBeNull());
    useComposerDraftStore.getState().setPrompt(viewRef(taskA), "Conserver après refus");
    mocks.compose.mockImplementationOnce(async ({ input }: Call) => ({
      _tag: "Success",
      value: observed(input, "refused"),
    }));
    await act(() => handle.current!.send("Conserver après refus"));
    expect(handle.current?.error).toBe("État natif");
    expect(handle.current?.pending).toBeUndefined();
    expect(useComposerDraftStore.getState().getComposerDraft(viewRef(taskA))?.prompt).toBe(
      "Conserver après refus",
    );
  });

  it("does not read or mutate without the operation scope", async () => {
    using _setup = setup();
    mocks.allowed = false;
    const handle = { current: null as Hook | null };
    await using _screen = await render(<Harness handle={handle} />);
    await act(() => {
      handle.current!.send("Interdit");
      handle.current!.refresh();
    });
    expect(mocks.compose).not.toHaveBeenCalled();
  });
});
