// Secret-leak assertions over everything the e2e suite captured: every response (body and headers) and every log line
// of the API logger, the gateways' sink and the jobs.

import { expect } from "vitest";
import type { E2e } from "./app.js";

export interface LeakScan {
  responses: number;
  logLines: number;
}

/**
 * No configured secret, database URL, RPC key, GitHub token or OAuth code appears in any response or log line; no
 * session token, cookie header or query string (OAuth code/state travel in one) appears in any log line.
 */
export function assertNoSecretLeaks(e2e: E2e, sessionTokens: readonly string[] = []): LeakScan {
  const secrets = e2e.secretStrings().filter((value) => value.length >= 8);
  expect(secrets.length).toBeGreaterThan(8);
  for (const response of e2e.responses) {
    const text = `${response.body}\n${JSON.stringify(response.headers)}`;
    for (const secret of secrets) expect(text.includes(secret), `${response.method} ${response.url} leaks a secret`).toBe(false);
  }
  for (const line of e2e.logs) {
    for (const secret of [...secrets, ...sessionTokens.filter((token) => token.length >= 8)]) expect(line.includes(secret), `log line leaks a secret: ${line.slice(0, 120)}`).toBe(false);
    expect(line).not.toMatch(/__Host-pine_(?:session|presession)=/);
    expect(line).not.toMatch(/"(?:url|path)":"[^"]*\?/);
  }
  return { responses: e2e.responses.length, logLines: e2e.logs.length };
}

/** Strings the backend persisted for operators and auditors: audit details and the stored error columns. */
export async function assertNoSecretsPersisted(e2e: E2e, sessionTokens: readonly string[] = []): Promise<number> {
  const secrets = [...e2e.secretStrings(), ...sessionTokens].filter((value) => value.length >= 8);
  const rows = await e2e.db.api.sql.query<{ text: string | null }>(
    `SELECT details::text AS text FROM audit_log
     UNION ALL SELECT last_error FROM claims_index
     UNION ALL SELECT last_error FROM content_pins`,
  );
  for (const row of rows) for (const secret of secrets) expect((row.text ?? "").includes(secret), `persisted text leaks a secret: ${(row.text ?? "").slice(0, 120)}`).toBe(false);
  expect(rows.length).toBeGreaterThan(0);
  return rows.length;
}
