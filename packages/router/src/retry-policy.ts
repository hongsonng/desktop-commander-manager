export type UpstreamFailureKind = 'PRE_DISPATCH' | 'ACK_UNKNOWN' | 'UPSTREAM_ERROR' | 'POST_DISPATCH'

export interface UpstreamFailure {
  kind: UpstreamFailureKind
  message?: string
}

export class RetryPolicy {
  canReplay(failure: UpstreamFailure): boolean {
    return failure?.kind === 'PRE_DISPATCH'
  }
}
