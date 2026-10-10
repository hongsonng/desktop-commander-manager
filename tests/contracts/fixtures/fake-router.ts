import type { RouteContext, WorkerDescriptor } from "@dc-manager/shared";

export function createDescriptor(id: string): WorkerDescriptor {
  return {
    id,
    name: id,
    enabled: true,
    status: "READY",
    pid: 1,
    failureCount: 0,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeSessionCount: 0,
  };
}

export class FakeContractRouter {
  contexts: RouteContext[] = [];
  failoverCalls: Array<[string, string]> = [];
  failResolve = false;

  async resolve(context: RouteContext): Promise<WorkerDescriptor> {
    this.contexts.push(context);
    if (this.failResolve) {
      throw Object.assign(new Error("No healthy Desktop Commander worker is available"), {
        code: "NO_HEALTHY_WORKER",
      });
    }
    return createDescriptor("worker-1");
  }

  async failover(sessionId: string, workerId: string): Promise<WorkerDescriptor> {
    this.failoverCalls.push([sessionId, workerId]);
    return createDescriptor("worker-2");
  }
}
