import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import type * as NodeHttp from "node:http";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Observe only the session header actually passed to Node's writeHead overloads.
 * Direct writeHead headers are sent on the wire but are absent from getHeader(). */
export function observeWrittenMcpSession(
  response: NodeHttp.ServerResponse,
): () => string | undefined {
  const writeHead = response.writeHead;
  let issued: string | undefined;
  response.writeHead = function (
    statusCode: number,
    statusOrHeaders?: string | NodeHttp.OutgoingHttpHeaders | NodeHttp.OutgoingHttpHeader[],
    headers?: NodeHttp.OutgoingHttpHeaders | NodeHttp.OutgoingHttpHeader[],
  ) {
    // Effect passes (status, undefined, headers) when statusText is absent.
    const outgoing = arguments.length >= 3 ? headers : statusOrHeaders;
    issued = this.getHeader("mcp-session-id")?.toString();
    if (Array.isArray(outgoing)) {
      for (let index = 0; index < outgoing.length; index += 2) {
        if (String(outgoing[index]).toLowerCase() === "mcp-session-id") {
          issued = outgoing[index + 1]?.toString();
        }
      }
    } else if (outgoing && typeof outgoing === "object") {
      for (const name of Object.keys(outgoing)) {
        if (name.toLowerCase() === "mcp-session-id") issued = outgoing[name]?.toString();
      }
    }
    // Forward the exact receiver and arguments. No header or body is changed.
    return Reflect.apply(writeHead, this, arguments);
  };
  return () => issued;
}

/** Matches the existing Rust t3code::stable_uuid mapping, including its v4 presentation. */
export const bridgetThreadUuid = (name: string): string => {
  const namespace = Buffer.from("098b71d3c0de4a119b1d73636f646501", "hex");
  const bytes = NodeCrypto.createHash("sha1")
    .update(namespace)
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

class JsonLines {
  readonly values: Array<Record<string, any>> = [];
  private error: Error | undefined;
  constructor(stream: NodeJS.ReadableStream) {
    NodeReadline.createInterface({ input: stream }).on("line", (line) => {
      try {
        this.values.push(JSON.parse(line));
      } catch {
        this.error = new Error("fixture received a non-JSON protocol line");
      }
    });
  }
  async next(): Promise<Record<string, any>> {
    const until = Date.now() + 15_000;
    while (this.values.length === 0) {
      if (this.error) throw this.error;
      if (Date.now() >= until) throw new Error("isolated protocol response timed out");
      await pause(10);
    }
    return this.values.shift()!;
  }
}

/** Only real daemon-issued credentials are written; no PID marker or forged credential. */
export class BridgetRustFixture {
  readonly executable: string;
  readonly root: string;
  readonly state: string;
  readonly socket: string;
  readonly t3Home: string;
  private readonly children: NodeChildProcess.ChildProcessWithoutNullStreams[] = [];
  private readonly connections: NodeNet.Socket[] = [];
  private constructor(executable: string, root: string) {
    this.executable = executable;
    this.root = root;
    this.state = NodePath.join(root, "state");
    this.socket = NodePath.join(this.state, "bridget.sock");
    this.t3Home = NodePath.join(root, "t3");
  }
  static async create(executable: string): Promise<BridgetRustFixture> {
    await NodeFSP.access(executable);
    const fixture = new BridgetRustFixture(executable, await NodeFSP.mkdtemp("/tmp/i148-"));
    for (const path of [
      fixture.state,
      NodePath.join(fixture.root, "provider"),
      NodePath.join(fixture.t3Home, "userdata"),
    ]) {
      await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
    }
    return fixture;
  }
  private env(): NodeJS.ProcessEnv {
    return {
      HOME: NodePath.join(this.root, "provider"),
      BRIDGET_HOME: this.state,
      BRIDGET_SOCKET: this.socket,
      TMPDIR: "/tmp",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOSTNAME: "interop148-isolated",
      XDG_CACHE_HOME: NodePath.join(this.root, "provider/.cache"),
      XDG_CONFIG_HOME: NodePath.join(this.root, "provider/.config"),
      XDG_DATA_HOME: NodePath.join(this.root, "provider/.local/share"),
      XDG_STATE_HOME: NodePath.join(this.root, "provider/.local/state"),
    };
  }
  private start(args: string[], env = this.env()): NodeChildProcess.ChildProcessWithoutNullStreams {
    const child = NodeChildProcess.spawn(this.executable, args, {
      env,
      cwd: this.root,
      stdio: "pipe",
    });
    // Drain bounded process output without displaying credentials or provider prompts.
    child.stderr.resume();
    child.on("error", () => undefined);
    this.children.push(child);
    return child;
  }
  async startDaemon(): Promise<void> {
    const daemon = this.start(["daemon"]);
    daemon.stdout.resume();
    const until = Date.now() + 10_000;
    while (true) {
      const ready = await new Promise<boolean>((resolve) => {
        const connection = NodeNet.connect(this.socket);
        connection.once("connect", () => {
          connection.destroy();
          resolve(true);
        });
        connection.once("error", () => resolve(false));
      });
      if (ready) return;
      if (daemon.exitCode !== null || Date.now() >= until)
        throw new Error("isolated Bridget daemon unavailable");
      await pause(20);
    }
  }
  async publishRuntime(endpoint: string): Promise<void> {
    await NodeFSP.writeFile(
      NodePath.join(this.t3Home, "userdata/server-runtime.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: Number(new URL(endpoint).port),
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
  }
  async registerThread(threadId: string): Promise<string> {
    const agentId = bridgetThreadUuid(threadId);
    const instanceId = bridgetThreadUuid(`instance:${threadId}`);
    const connection = NodeNet.connect(this.socket);
    this.connections.push(connection);
    const lines = new JsonLines(connection);
    connection.write(
      `${JSON.stringify({
        type: "Register",
        identity_version: 2,
        agent_type: "fixture",
        agent_id: agentId,
        instance_id: instanceId,
        host: "isolated",
        transport: "unix",
        os: "test",
        turn_in_progress: false,
      })}\n`,
    );
    const registered = await lines.next();
    if (
      registered.type !== "Registered" ||
      registered.agent_id !== agentId ||
      !registered.credential
    ) {
      throw new Error("real daemon registration did not issue a credential");
    }
    await NodeFSP.mkdir(NodePath.join(this.state, "agent-names"), { recursive: true, mode: 0o700 });
    const hash = NodeCrypto.createHash("sha256").update(instanceId).digest("hex");
    await NodeFSP.writeFile(
      NodePath.join(this.state, `agent-names/proof-${hash}.json`),
      JSON.stringify({
        agent_id: agentId,
        instance_id: instanceId,
        credential: registered.credential,
      }),
      { mode: 0o600 },
    );
    return agentId;
  }
  async mcp(endpoint: string, authorization: string) {
    const child = this.start(["mcp"], {
      ...this.env(),
      T3CODE_HOME: this.t3Home,
      BRIDGET_T3_MCP_ENDPOINT: endpoint,
      BRIDGET_T3_MCP_AUTHORIZATION: authorization,
    });
    const lines = new JsonLines(child.stdout);
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "interop148", version: "1" },
      },
    });
    const initialized = await lines.next();
    if (!initialized.result) throw new Error("Rust MCP initialization failed");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      call: async (id: number) => {
        send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "bridget_who",
            arguments: { scope: "global" },
          },
        });
        return lines.next();
      },
    };
  }
  async close(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    for (const child of this.children.toReversed()) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      const observed = await exec("/bin/ps", [
        "-p",
        String(child.pid),
        "-o",
        "ppid=",
        "-o",
        "command=",
      ]);
      if (
        Number(observed.stdout.trim().split(/\s+/)[0]) !== process.pid ||
        !observed.stdout.includes(this.executable) ||
        /firefox/i.test(observed.stdout)
      ) {
        throw new Error("refusing to stop an unverified fixture process");
      }
      child.kill("SIGTERM");
      const until = Date.now() + 10_000;
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() >= until) throw new Error("isolated fixture did not stop after SIGTERM");
        await pause(20);
      }
    }
    await NodeFSP.rm(this.root, { recursive: true, force: true });
  }
}
