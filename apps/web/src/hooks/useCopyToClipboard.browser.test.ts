import { describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import { writeTextToClipboard } from "./useCopyToClipboard";

function browserStubs() {
  return {
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}

describe("writeTextToClipboard", () => {
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    using _cleanup = browserStubs();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    using _cleanup = browserStubs();
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });
});

it.each(["plain", "custom flavors"] as const)(
  "preserves CRLF, Unicode and spaces in the HTTP fallback with %s",
  async (format) => {
    using _cleanup = browserStubs();
    const value = "  début\r\n```ts\r\nconst café = '雪 🦋';  \r\n```\r\n\tfin  ";
    const flavors = format === "plain" ? undefined : { "text/html": "<pre>rich</pre>" };
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const previouslyFocused = document.createElement("button");
    document.body.appendChild(previouslyFocused);
    previouslyFocused.focus();
    const data = new Map<string, string>();
    const setData = vi.fn((type: string, contents: string) => data.set(type, contents));
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    let textarea: HTMLTextAreaElement | undefined;
    const execCommand = vi.fn(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLTextAreaElement)) throw new Error("No copy selection");
      textarea = active;
      // A real textarea normalizes CRLF. Only the copy event can preserve the source.
      expect(active.value).toBe(value.replaceAll("\r\n", "\n"));
      active.dispatchEvent(event);
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    vi.stubGlobal("navigator", {});

    try {
      await expect(writeTextToClipboard(value, "message Bridget", flavors)).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(data.get("text/plain")).toBe(value);
      expect(event.defaultPrevented).toBe(true);
      expect(data.get("text/html")).toBe(flavors?.["text/html"]);
      expect(document.activeElement).toBe(previouslyFocused);
      expect(textarea?.isConnected).toBe(false);
      setData.mockClear();
      textarea?.dispatchEvent(event);
      expect(setData).not.toHaveBeenCalled();
    } finally {
      textarea?.remove();
      previouslyFocused.remove();
      if (previousExecCommand) {
        Object.defineProperty(document, "execCommand", previousExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  },
);
