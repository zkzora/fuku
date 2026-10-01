/** The caller is authenticated but may not act on this resource (HTTP 403). */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** A precondition the caller can fix (HTTP 400/401/409), with a machine-readable code. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 422 = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
