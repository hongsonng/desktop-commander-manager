import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { UpstreamCallError } from "@dc-manager/router";
import type { WorkerProcessHandle } from "@dc-manager/worker-manager";

class ExistingStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private readonly readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;

  constructor(private readonly handle: WorkerProcessHandle) {}

  private readonly onData = (chunk: Buffer | string) => {
    try {
      this.readBuffer.append(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
      while (true) {
        const message = this.readBuffer.readMessage();
        if (!message) break;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly onStreamError = (error: Error) => this.onerror?.(error);

  async start(): Promise<void> {
    if (this.started)
      throw new Error("Existing stdio transport already started");
    this.started = true;
    this.handle.stdout.on("data", this.onData);
    this.handle.stdout.on("error", this.onStreamError);
    void this.handle.exited.then(() => this.remoteClosed());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed)
      throw new UpstreamCallError(
        "PRE_DISPATCH",
        "Worker transport is not writable",
      );
    const payload = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.handle.stdin.write(payload, (error?: Error | null) => {
        if (error)
          reject(
            new UpstreamCallError("PRE_DISPATCH", error.message, {
              cause: error,
            }),
          );
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.stdout.off("data", this.onData);
    this.handle.stdout.off("error", this.onStreamError);
    this.readBuffer.clear();
    this.onclose?.();
  }

  private remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle.stdout.off("data", this.onData);
    this.handle.stdout.off("error", this.onStreamError);
    this.onclose?.();
  }
}

export type WorkerToolResult = Awaited<ReturnType<Client["callTool"]>>;
export type WorkerToolsResult = Awaited<ReturnType<Client["listTools"]>>;

export interface ProxyWorkerClient {
  listTools(meta?: Record<string, unknown>): Promise<WorkerToolsResult>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<WorkerToolResult>;
  close(): Promise<void>;
}

export class WorkerClient implements ProxyWorkerClient {
  private constructor(private readonly client: Client) {}

  static async connect(handle: WorkerProcessHandle): Promise<WorkerClient> {
    const client = new Client({
      name: "desktop-commander-manager",
      version: "0.1.0",
    });
    try {
      await client.connect(new ExistingStdioTransport(handle));
      return new WorkerClient(client);
    } catch (error) {
      throw new UpstreamCallError(
        "PRE_DISPATCH",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async listTools(meta?: Record<string, unknown>): Promise<WorkerToolsResult> {
    try {
      return await this.client.listTools(meta ? { _meta: meta } : undefined);
    } catch (error) {
      if (error instanceof UpstreamCallError) throw error;
      throw new UpstreamCallError(
        "ACK_UNKNOWN",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<WorkerToolResult> {
    try {
      return await this.client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      });
    } catch (error) {
      if (error instanceof UpstreamCallError) throw error;
      throw new UpstreamCallError(
        "ACK_UNKNOWN",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
