// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identify, rawCidFromBytes, rawCidFromSha256 } from "@pine/shared/canonical";
import { GitHubGatewayError, type AppContext } from "../../contracts/app.js";
import { JOB_NAMES } from "./index.js";
import { API, appGrant, createHarness, KUBO_URL, linkUser, PINNING_URL, repoJson, TOKEN_URL, USER_A, type Harness, type RecordedCall } from "./testing/harness.js";

// Every outbound request of the gateways (GitHub REST, the token endpoint, IPFS gateways, Kubo, the pinning service)
// is created with the 10 s timeout (PRD-02 3.1/3.2, task constraint "bounded sizes and timeouts"), and a hung upstream
// surfaces as an ordinary failure instead of hanging the caller.

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
afterEach(() => {
  vi.restoreAllMocks();
});

const REPO = `${API}/repos/kleros/pine`;
const GW1 = "https://gw1.ipfs.test";
const GW2 = "https://gw2.ipfs.test";

/** Records the duration of every AbortSignal.timeout(); `override` replaces the duration actually used. */
function spyTimeouts(override?: number) {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const durations: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    durations.push(ms);
    return original(override ?? ms);
  });
  return durations;
}

/** An upstream that never answers: it settles only when the request's signal aborts. */
const hang = (call: RecordedCall) =>
  new Promise<Response>((_resolve, reject) => {
    call.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
  });

describe("10 s timeout on every outbound request", () => {
  it("GitHub REST, the token endpoint, an IPFS gateway, Kubo and the pinning service are all called with 10_000 ms", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    const bytes = new TextEncoder().encode("timeout coverage");
    const cid = rawCidFromBytes(bytes);
    await h.gateways.contentStore.put({ bytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    const remote = identify(new Uint8Array(randomBytes(64)));
    h.fetch.clear();
    h.clock.advance(9 * 3_600_000);
    h.fetch.json("POST", TOKEN_URL, 200, appGrant(2));
    h.fetch.json("GET", REPO, 200, repoJson());
    h.fetch.json("GET", `${GW1}/ipfs/${rawCidFromSha256(remote.sha256)}?format=raw`, 404, {});
    h.fetch.json("GET", `${GW2}/ipfs/${rawCidFromSha256(remote.sha256)}?format=raw`, 404, {});
    h.fetch.json("POST", /\/api\/v0\/block\/put/, 200, { Key: cid, Size: bytes.byteLength });
    h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: [cid] });
    h.fetch.json("GET", /\/pins\?cid=/, 200, { count: 0, results: [] });
    h.fetch.json("POST", `${PINNING_URL}/pins`, 202, { requestid: "r1", status: "queued", pin: { cid } });

    const durations = spyTimeouts();
    await h.gateways.github.getRepo(USER_A, "kleros", "pine");
    await h.gateways.contentStore.retrieve(remote.sha256, 1_000);
    const job = h.gateways.jobs.find((item) => item.name === JOB_NAMES.pinOutbox);
    await job?.run(undefined as unknown as AppContext, new AbortController().signal);

    const hosts = h.fetch.calls.map((call) => `${call.method} ${new URL(call.url).origin}${new URL(call.url).pathname}`);
    expect(hosts).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${REPO}`,
      `GET ${GW1}/ipfs/${rawCidFromSha256(remote.sha256)}`,
      `GET ${GW2}/ipfs/${rawCidFromSha256(remote.sha256)}`,
      `POST ${KUBO_URL}/api/v0/block/put`,
      `POST ${KUBO_URL}/api/v0/pin/add`,
      `GET ${PINNING_URL}/pins`,
      `POST ${PINNING_URL}/pins`,
    ]);
    expect(durations).toEqual(h.fetch.calls.map(() => 10_000));
    expect(h.fetch.calls.every((call) => call.signal !== null)).toBe(true);
  });

  it("a GitHub API that never answers is UPSTREAM once the timeout fires, and frees its concurrency slots", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.fetch.calls.length = 0;
    spyTimeouts(100);
    h.fetch.on("GET", REPO, hang, 6);
    const errors = await Promise.all(Array.from({ length: 6 }, () => h.gateways.github.getRepo(USER_A, "kleros", "pine").catch((caught: unknown) => caught)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(GitHubGatewayError);
      expect((error as GitHubGatewayError).code).toBe("UPSTREAM");
    }
    // The per-user slots (5) were released: the next call goes through.
    h.fetch.json("GET", REPO, 200, repoJson());
    await expect(h.gateways.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
  });

  it("a token endpoint that never answers is UPSTREAM and keeps the link", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.clock.advance(9 * 3_600_000);
    spyTimeouts(100);
    h.fetch.on("POST", TOKEN_URL, hang);
    const error = await h.gateways.github.getRepo(USER_A, "kleros", "pine").catch((caught: unknown) => caught);
    expect((error as GitHubGatewayError).code).toBe("UPSTREAM");
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
  });

  it("a hung first IPFS gateway times out and retrieve uses the second one", async () => {
    const remote = new Uint8Array(randomBytes(1_000));
    const id = identify(remote);
    spyTimeouts(100);
    h.fetch.on("GET", `${GW1}/ipfs/${id.cid}?format=raw`, hang);
    h.fetch.on("GET", `${GW2}/ipfs/${id.cid}?format=raw`, () => new Response(Buffer.from(remote), { status: 200 }));
    const bytes = await h.gateways.contentStore.retrieve(id.sha256, 10_000);
    expect(Buffer.from(bytes ?? []).equals(Buffer.from(remote))).toBe(true);
    expect(h.fetch.calls.map((call) => new URL(call.url).origin)).toEqual([GW1, GW2]);
  });

  it("a hung Kubo node counts a failed attempt with backoff instead of blocking the outbox", async () => {
    await h.gateways.contentStore.put({ bytes: new TextEncoder().encode("hung kubo"), declaredMediaType: "text/plain", maxBytes: 1_000 });
    spyTimeouts(100);
    h.fetch.on("POST", /\/api\/v0\/block\/put/, hang);
    const job = h.gateways.jobs.find((item) => item.name === JOB_NAMES.pinOutbox);
    await job?.run(undefined as unknown as AppContext, new AbortController().signal);
    const rows = await h.database.sql.query<{ status: string; attempts: number }>("SELECT status, attempts FROM content_pins");
    expect(rows).toEqual([{ status: "pending", attempts: 1 }]);
  });
});
