// CSRF policy for cookie-authenticated JSON APIs (SEC-AUTH-14, PRD-02 2.2/2.5a). Runs in onRequest, before body
// parsing, so every failure is CSRF_REJECTED: exact Origin, Sec-Fetch-Site not cross-site, `x-pine-csrf: 1`, and a JSON
// body (multipart/form-data only on flagged routes). Requests without a body need no content type.

import type { IncomingHttpHeaders } from "node:http";

export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-pine-csrf";

export type CsrfFailure = "missing_origin" | "origin_mismatch" | "cross_site" | "missing_header" | "content_type";

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

/** The media type of a Content-Type header value (parameters dropped, lowercased). */
export function mediaType(value: string | undefined): string | null {
  if (value === undefined) return null;
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.length > 0 ? type : null;
}

export function hasBody(headers: IncomingHttpHeaders): boolean {
  if (headers["transfer-encoding"] !== undefined) return true;
  const length = single(headers["content-length"]);
  if (length === undefined) return false;
  return !/^0+$/.test(length.trim());
}

/** Returns null when the request passes, else the (server-side) reason. Only call for unsafe methods. */
export function checkCsrf(headers: IncomingHttpHeaders, options: { publicOrigin: string; multipart: boolean }): CsrfFailure | null {
  const origin = single(headers.origin);
  if (origin === undefined || origin === "" || origin === "null") return "missing_origin";
  if (origin !== options.publicOrigin) return "origin_mismatch";
  const site = single(headers["sec-fetch-site"]);
  if (site !== undefined && site.trim().toLowerCase() === "cross-site") return "cross_site";
  if (single(headers[CSRF_HEADER]) !== "1") return "missing_header";
  if (hasBody(headers)) {
    const type = mediaType(single(headers["content-type"]));
    const expected = options.multipart ? "multipart/form-data" : "application/json";
    if (type !== expected) return "content_type";
  }
  return null;
}
