// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { identify, rawCidFromBytes } from "@pine/shared/canonical";
import type { AppContext } from "../../contracts/app.js";
import type { Gateways } from "../../contracts/platform.js";
import { JOB_NAMES } from "./index.js";
import { appGrant, createHarness, insertUser, KUBO_URL, linkUser, observedDatabase, testSecrets, USER_A, USER_B, type Harness } from "./testing/harness.js";

// PRD-02 section 3a: every gateway job (pin outbox, token re-encryption, OAuth-state purge) stops when its signal is
// aborted before or during a batch. There is no token-refresh job: refresh happens on demand, single-flight per user
// (SEC-GH-09, github-tokens.test.ts), so the first test pins the complete job list these tests have to cover.

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const noCtx = undefined as unknown as AppContext;
const BLOCK_PUT = `${KUBO_URL}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=false`;

function jobOf(gateways: Gateways, name: string) {
  const job = gateways.jobs.find((item) => item.name === name);
  if (!job) throw new Error(`job ${name} missing`);
  return job;
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/** A second process on the same database that records each statement and runs `onStatement` before it executes. */
async function observed(onStatement: (text: string) => void = () => undefined) {
  const statements: string[] = [];
  const gateways = await h.sibling({
    db: observedDatabase(h.database.db, (text) => {
      statements.push(text);
      onStatement(text);
    }),
  });
  return { gateways, statements };
}

async function count(table: string, where = "true"): Promise<number> {
  const rows = await h.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return rows[0]?.n ?? 0;
}

it("the gateways run exactly three jobs, all covered below (no background token-refresh job exists)", () => {
  expect(h.gateways.jobs.map((job) => job.name).sort()).toEqual([
    "gateways.content-pin-outbox",
    "gateways.github-oauth-state-purge",
    "gateways.github-token-reencrypt",
  ]);
  expect(Object.values(JOB_NAMES).sort()).toEqual(h.gateways.jobs.map((job) => job.name).sort());
});

describe("pin outbox job", () => {
  const first = new TextEncoder().encode("abort evidence one");
  const second = new TextEncoder().encode("abort evidence two");

  async function pinRows() {
    return h.database.sql.query<{ sha256: string; status: string; kubo_done: boolean; attempts: number }>(
      "SELECT sha256, status, kubo_done, attempts FROM content_pins ORDER BY sha256",
    );
  }

  it("aborted before the batch: no statement, no request, items unchanged", async () => {
    await h.gateways.contentStore.put({ bytes: first, declaredMediaType: "text/plain", maxBytes: 1_000 });
    const process2 = await observed();
    await jobOf(process2.gateways, JOB_NAMES.pinOutbox).run(noCtx, aborted());
    expect(process2.statements).toEqual([]);
    expect(h.fetch.calls).toHaveLength(0);
    expect(await pinRows()).toMatchObject([{ status: "pending", kubo_done: false, attempts: 0 }]);
  });

  it("aborted during a batch: the item in flight counts no failed attempt and the next item is never contacted", async () => {
    await h.gateways.contentStore.put({ bytes: first, declaredMediaType: "text/plain", maxBytes: 1_000 });
    await h.gateways.contentStore.put({ bytes: second, declaredMediaType: "text/plain", maxBytes: 1_000 });
    // Items are processed in sha256 order (same next_attempt_at).
    const [early, late] = [identify(first), identify(second)].sort((a, b) => a.sha256.localeCompare(b.sha256));
    if (!early || !late) throw new Error("fixture");
    const controller = new AbortController();
    h.fetch.on("POST", BLOCK_PUT, () => {
      controller.abort();
      return new Response(JSON.stringify({ Key: early.cid, Size: early.size }), { status: 200 });
    });
    await jobOf(h.gateways, JOB_NAMES.pinOutbox).run(noCtx, controller.signal);

    // block/put of the first item answered; its pin/add was refused by the aborted signal; nothing for the second.
    expect(h.fetch.callsTo(BLOCK_PUT)).toHaveLength(1);
    expect(h.fetch.callsTo(`${KUBO_URL}/api/v0/pin/add?arg=${late.cid}`)).toHaveLength(0);
    expect(await pinRows()).toMatchObject([
      { status: "pending", kubo_done: false, attempts: 0 },
      { status: "pending", kubo_done: false, attempts: 0 },
    ]);
    expect(h.metrics.counters.get("content_pin_failed{}")).toBeUndefined();
  });

  it("an abort cancels the request in flight instead of waiting for the 10 s timeout", async () => {
    await h.gateways.contentStore.put({ bytes: first, declaredMediaType: "text/plain", maxBytes: 1_000 });
    const controller = new AbortController();
    h.fetch.on(
      "POST",
      BLOCK_PUT,
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          // A hung Kubo node: answers only when the request's signal aborts.
          call.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
          setTimeout(() => controller.abort(), 50);
        }),
    );
    const started = Date.now();
    await jobOf(h.gateways, JOB_NAMES.pinOutbox).run(noCtx, controller.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await pinRows()).toMatchObject([{ status: "pending", attempts: 0 }]);
    expect(h.metrics.counters.get("content_pin_failed{}")).toBeUndefined();
  });

  it("the outbox resumes after an aborted run", async () => {
    await h.gateways.contentStore.put({ bytes: first, declaredMediaType: "text/plain", maxBytes: 1_000 });
    await jobOf(h.gateways, JOB_NAMES.pinOutbox).run(noCtx, aborted());
    const cid = rawCidFromBytes(first);
    h.fetch.json("POST", BLOCK_PUT, 200, { Key: cid, Size: first.byteLength });
    h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: [cid] });
    h.fetch.json("GET", /\/pins\?cid=/, 200, { count: 1, results: [{ requestid: "r0", status: "pinned", pin: { cid } }] });
    await jobOf(h.gateways, JOB_NAMES.pinOutbox).run(noCtx, new AbortController().signal);
    expect(await pinRows()).toMatchObject([{ status: "pinned" }]);
  });
});

describe("token re-encryption job (SEC-GH-07)", () => {
  async function linkUnderOldKey() {
    const k1 = h.secrets.tokenEncryptionKeys.previous[0];
    if (!k1) throw new Error("fixture needs a previous key");
    const oldProcess = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: k1, previous: [] } }) });
    await linkUser(h, USER_A, { gateways: oldProcess, grant: appGrant(1) });
    await linkUser(h, USER_B, { gateways: oldProcess, grant: appGrant(2), githubUserId: 1002, login: "bob" });
    expect(await count("github_tokens", "key_id = 'k1'")).toBe(4);
  }

  it("aborted before the batch: nothing is re-encrypted", async () => {
    await linkUnderOldKey();
    const process2 = await observed();
    await jobOf(process2.gateways, JOB_NAMES.reencryptTokens).run(noCtx, aborted());
    expect(process2.statements.filter((text) => /^update/i.test(text.trim()))).toEqual([]);
    expect(await count("github_tokens", "key_id = 'k1'")).toBe(4);
  });

  it("aborted during a batch: the row being written finishes, no further row is touched", async () => {
    await linkUnderOldKey();
    const controller = new AbortController();
    const process2 = await observed((text) => {
      if (/^update github_tokens/i.test(text.trim())) controller.abort();
    });
    await jobOf(process2.gateways, JOB_NAMES.reencryptTokens).run(noCtx, controller.signal);
    expect(process2.statements.filter((text) => /^update github_tokens/i.test(text.trim()))).toHaveLength(1);
    expect(await count("github_tokens", "key_id = 'k2'")).toBe(1);
    expect(await count("github_tokens", "key_id = 'k1'")).toBe(3);
    // SEC-GH-07: the job reports how many rows remain under retired keys.
    expect(h.logs.filter((line) => line.msg.startsWith("GitHub token re-encryption")).map((line) => line.msg)).toEqual([
      "GitHub token re-encryption: 1 re-encrypted, 0 revoked (undecryptable), 3 remain under retired keys",
    ]);
    // An unaborted run finishes the rest.
    await jobOf(h.gateways, JOB_NAMES.reencryptTokens).run(noCtx, new AbortController().signal);
    expect(await count("github_tokens", "key_id = 'k2'")).toBe(4);
    expect(h.logs.at(-1)?.msg).toBe("GitHub token re-encryption: 3 re-encrypted, 0 revoked (undecryptable), 0 remain under retired keys");
  });
});

describe("OAuth-state purge job (SEC-GH-03)", () => {
  async function expiredStates(n: number) {
    await insertUser(h.database, USER_A);
    await h.database.sql.query(
      `INSERT INTO github_oauth_states (state_hash, session_id, user_id, verifier_key_id, verifier_iv, verifier_ciphertext, created_at, expires_at)
       SELECT md5(i::text) || md5('x' || i::text), 'sess', $1, 'k2', decode(repeat('00', 12), 'hex'), decode(repeat('00', 32), 'hex'),
              timestamptz '2026-09-30T00:00:00Z', timestamptz '2026-09-30T00:10:00Z'
         FROM generate_series(1, $2::int) AS i`,
      [USER_A, n],
    );
  }

  it("aborted before the batch: nothing is deleted", async () => {
    await expiredStates(1_200);
    const process2 = await observed();
    await jobOf(process2.gateways, JOB_NAMES.purgeOAuthStates).run(noCtx, aborted());
    expect(process2.statements).toEqual([]);
    expect(await count("github_oauth_states")).toBe(1_200);
  });

  it("aborted during the purge: the batch in flight completes (500 rows), no further batch starts", async () => {
    await expiredStates(1_200);
    const controller = new AbortController();
    const process2 = await observed((text) => {
      if (/^delete from github_oauth_states/i.test(text.trim())) controller.abort();
    });
    await jobOf(process2.gateways, JOB_NAMES.purgeOAuthStates).run(noCtx, controller.signal);
    expect(await count("github_oauth_states")).toBe(700);
    // Unaborted, it purges everything in bounded batches.
    await jobOf(h.gateways, JOB_NAMES.purgeOAuthStates).run(noCtx, new AbortController().signal);
    expect(await count("github_oauth_states")).toBe(0);
  });
});
