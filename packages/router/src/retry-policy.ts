export type UpstreamFailureKind =
  | "PRE_DISPATCH"
  | "ACK_UNKNOWN"
  | "UPSTREAM_ERROR"
  | "POST_DISPATCH";

export interface UpstreamFailure {
  kind: UpstreamFailureKind;
  message?: string;
}

export class UpstreamCallError extends Error implements UpstreamFailure {
  constructor(
    readonly kind: UpstreamFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpstreamCallError";
  }
}

export class RetryPolicy {
  canReplay(failure: UpstreamFailure): boolean {
    return failure?.kind === "PRE_DISPATCH";
  }
}
