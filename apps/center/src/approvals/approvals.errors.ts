/** `approval.request` rad etildi (qayta yuborish foydasiz): agent kanalida `nack(invalid_payload, retriable=false)`. */
export class ApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRejectedError';
  }
}

/** Mashinada juda ko'p pending approval: agent kanalida `nack(rate_limited, retriable=true)`. */
export class ApprovalOverloadError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'ApprovalOverloadError';
  }
}
