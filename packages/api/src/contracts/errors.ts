// FROZEN cross-lane contract. Error model shared by the platform and every route module.
//
// Every error a client can see is an ApiError with a stable `code`. Messages are written for clients and must never
// contain secrets, stack traces, SQL, file paths, RPC URLs or upstream response bodies. toErrorResponse redacts every
// message it returns as defense in depth. Anything that is not an ApiError (or a branded Fastify validation error) is
// reported as INTERNAL with a generic message; the details go to the server log only, redacted.
// requestId is always server-generated (Fastify `requestIdHeader: false`), never taken from a client header.

import type { Redactor } from "./redact.js";

export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  STEP_UP_REQUIRED: 401,
  CSRF_REJECTED: 403,
  FORBIDDEN: 403,
  TERMS_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTEGRITY_FAILED: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 502,
  NOT_READY: 503,
  FEATURE_DISABLED: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorIssue {
  /** JSON path of the offending input field, e.g. ["claim", "requirement"]. */
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly issues: ErrorIssue[] | undefined;
  /** For RATE_LIMITED / QUOTA_EXCEEDED / NOT_READY: the platform sets the Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: { issues?: ErrorIssue[]; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.issues = options.issues;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Body of every non-2xx JSON response. */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    issues?: ErrorIssue[];
  };
}

export interface ErrorResponse {
  statusCode: number;
  body: ErrorResponseBody;
  /** Seconds for a Retry-After header, when applicable. */
  retryAfterSeconds?: number;
}

const MAX_ISSUES = 50;
const MAX_ISSUE_MESSAGE = 200;

/**
 * The single mapping from a thrown value to a client response. The platform's error handler and the test app both
 * use it, so module tests observe exactly what production clients observe.
 */
export function toErrorResponse(error: unknown, requestId: string, redact: Redactor): ErrorResponse {
  if (error instanceof ApiError) {
    const body: ErrorResponseBody = { error: { code: error.code, message: redact(error.message), requestId } };
    if (error.issues && error.issues.length > 0) {
      body.error.issues = error.issues.slice(0, MAX_ISSUES).map((issue) => ({
        path: issue.path.slice(0, 20).map((part) => (typeof part === "number" ? part : redact(String(part)).slice(0, 100))),
        message: redact(issue.message).slice(0, MAX_ISSUE_MESSAGE),
      }));
    }
    const response: ErrorResponse = { statusCode: error.statusCode, body };
    if (error.retryAfterSeconds !== undefined) response.retryAfterSeconds = error.retryAfterSeconds;
    return response;
  }
  if (isFastifyValidationError(error)) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          requestId,
          issues: error.validation.slice(0, MAX_ISSUES).map((item) => ({
            path: String(item.instancePath ?? "")
              .split("/")
              .filter((part) => part.length > 0)
              .slice(0, 20)
              .map((part) => redact(part).slice(0, 100)),
            message: typeof item.message === "string" ? redact(item.message).slice(0, MAX_ISSUE_MESSAGE) : "invalid",
          })),
        },
      },
    };
  }
  const statusCode = readStatusCode(error);
  const generic = (status: number, code: ErrorCode, message: string): ErrorResponse => ({ statusCode: status, body: { error: { code, message, requestId } } });
  switch (statusCode) {
    case 401:
      return generic(401, "UNAUTHENTICATED", "Authentication required");
    case 403:
      return generic(403, "FORBIDDEN", "Forbidden");
    case 404:
      return generic(404, "NOT_FOUND", "Not found");
    case 413:
      return generic(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    case 415:
      return generic(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported media type");
    case 429:
      return generic(429, "RATE_LIMITED", "Too many requests");
    default:
      if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return generic(400, "BAD_REQUEST", "Bad request");
      return generic(500, "INTERNAL", "Internal error");
  }
}

interface FastifyValidationErrorLike {
  code: "FST_ERR_VALIDATION";
  validation: { instancePath?: string; message?: unknown }[];
}

/** Only Fastify's own branded validation errors are reflected (fastify-type-provider-zod produces these). */
function isFastifyValidationError(error: unknown): error is FastifyValidationErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "FST_ERR_VALIDATION" &&
    Array.isArray((error as { validation?: unknown }).validation)
  );
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
