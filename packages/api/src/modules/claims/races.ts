// Mapping of the database errors a draft delete and a first publication can meet when they race (PRD-03 §8a/§8b).
// Both paths lock the draft row first (delete: FOR UPDATE, then its previews; publication: FOR SHARE before its insert),
// so on real Postgres they serialize; a deadlock or serialization failure that still happens is a 409, never a 500.
// drizzle wraps driver errors, so the SQLSTATE is read through the `cause` chain (sqlState).

import { ApiError } from "../../contracts/errors.js";
import { DEADLOCK_DETECTED, FOREIGN_KEY_VIOLATION, RESTRICT_VIOLATION, SERIALIZATION_FAILURE, sqlState } from "./db.js";

const CONCURRENCY_FAILURES: readonly string[] = [DEADLOCK_DETECTED, SERIALIZATION_FAILURE];

/**
 * DELETE /drafts/:id: a publication created concurrently references the draft or one of its previews (23503, or 23001
 * for the parent side of ON DELETE RESTRICT), or the transaction lost a deadlock/serialization race: 409. Null for
 * anything else (rethrown by the caller).
 */
export function draftDeleteRaceError(error: unknown): ApiError | null {
  const code = sqlState(error);
  if (code === FOREIGN_KEY_VIOLATION || code === RESTRICT_VIOLATION) return new ApiError("CONFLICT", "This draft has a publication and cannot be deleted");
  if (code !== null && CONCURRENCY_FAILURES.includes(code)) return new ApiError("CONFLICT", "The draft is being changed concurrently; try again");
  return null;
}

/**
 * First POST /publications insert: the draft and its previews were deleted after the preview was read (23503): the
 * preview is gone (NOT_FOUND); a deadlock/serialization failure against a concurrent delete or edit: 409. Null for
 * anything else.
 */
export function publicationInsertRaceError(error: unknown): ApiError | null {
  const code = sqlState(error);
  if (code === FOREIGN_KEY_VIOLATION) return new ApiError("NOT_FOUND", "Preview not found");
  if (code !== null && CONCURRENCY_FAILURES.includes(code)) return new ApiError("CONFLICT", "The draft is being changed concurrently; try again");
  return null;
}
