import type * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { observeWrittenMcpSession } from "./BridgetRustInterop.testkit.ts";

describe("SPEC148 passive HTTP session header observation", () => {
  const headers = { "Mcp-Session-Id": "synthetic-session" };
  const cases = [
    ["status and headers", [200, headers]],
    ["status, status text and headers", [200, "OK", headers]],
    ["status, undefined status text and headers", [200, undefined, headers]],
    ["status and raw alternating headers", [200, ["Mcp-Session-Id", "synthetic-session"]]],
  ] as const;
  it.each(cases)("captures %s and forwards the exact call", (_name, args) => {
    const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const response = {
      getHeader: () => undefined,
      writeHead: function (this: unknown, ...values: unknown[]) {
        calls.push({ receiver: this, args: values });
        return this;
      },
    } as unknown as NodeHttp.ServerResponse;
    const issued = observeWrittenMcpSession(response);
    assert.isUndefined(issued());
    const returned = Reflect.apply(response.writeHead, response, args);
    assert.equal(issued(), "synthetic-session");
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0]!.receiver, response);
    assert.strictEqual(returned, response);
    assert.equal(calls[0]!.args.length, args.length);
    for (let index = 0; index < args.length; index++) {
      assert.strictEqual(calls[0]!.args[index], args[index]);
    }
  });

  it("retains an existing session header when writeHead has no headers", () => {
    const response = {
      getHeader: () => "synthetic-session",
      writeHead: function (this: unknown) {
        return this;
      },
    } as unknown as NodeHttp.ServerResponse;
    const issued = observeWrittenMcpSession(response);
    response.writeHead(200);
    assert.equal(issued(), "synthetic-session");
  });
});
