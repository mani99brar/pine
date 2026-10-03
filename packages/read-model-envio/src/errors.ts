// Errors of the Envio read model. Messages are built ONLY from fixed text and safe fields (an operation name from this
// package, an HTTP status number, a count). Never from a fetch/viem/zod error, a response body or the request: the
// GraphQL URL may embed credentials and the admin secret travels in a header.

export type EnvioReadModelErrorCode =
  | "configuration"
  | "network"
  | "timeout"
  | "http"
  | "too_large"
  | "too_many_rows"
  | "invalid_json"
  | "graphql"
  | "invalid_response";

export class EnvioReadModelError extends Error {
  constructor(
    readonly code: EnvioReadModelErrorCode,
    readonly operation: string,
    detail: string,
  ) {
    super(`Envio read model ${operation}: ${detail}`);
    this.name = "EnvioReadModelError";
  }
}
