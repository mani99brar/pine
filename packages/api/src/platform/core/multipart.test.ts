// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
// Multipart limits (PRD-02 2.2, 3a): core registers @fastify/multipart once with fileSize = maxUploadBytes, files 1,
// fields 10, parts 11. busboy reports the files/fields limits only to a caller that keeps iterating, so the test-only
// routes consume like a real upload route: one iterates request.parts() and buffers every file, the other buffers the
// single file with toBuffer() (which enforces the size limit).

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteModule } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { testConfig } from "../../contracts/testing.js";
import { createHarness, csrfHeaders, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const MAX_UPLOAD = 4_096;
const BOUNDARY = "----pinelimits";

const uploadModule: RouteModule = {
  name: "upload-probe",
  async register(app: FastifyInstance) {
    app.post("/api/v1/probe/one-file", { config: { pine: { multipart: true } } }, async (request) => {
      const file = await request.file();
      if (!file) throw new ApiError("BAD_REQUEST", "file required");
      return { size: (await file.toBuffer()).length };
    });
    app.post("/api/v1/probe/parts", { config: { pine: { multipart: true } } }, async (request) => {
      const files: number[] = [];
      const fields: string[] = [];
      for await (const part of request.parts()) {
        if (part.type === "file") files.push((await part.toBuffer()).length);
        else fields.push(part.fieldname);
      }
      return { files, fields };
    });
  },
};

type Part = { name: string; filename?: string; content: string | Buffer };

function multipartBody(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename === undefined ? `form-data; name="${part.name}"` : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type = part.filename === undefined ? "" : "Content-Type: application/octet-stream\r\n";
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`), Buffer.from(part.content), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function send(url: string, parts: Part[]) {
  h ??= await createHarness({ modules: [uploadModule], database: db(), config: { evidence: { ...testConfig().evidence, maxUploadBytes: MAX_UPLOAD } } });
  return h.app.inject({ method: "POST", url, headers: csrfHeaders({ "content-type": `multipart/form-data; boundary=${BOUNDARY}` }), payload: multipartBody(parts) });
}

const file = (size: number, name = "file"): Part => ({ name, filename: `${name}.bin`, content: Buffer.alloc(size, 0x61) });

describe("multipart limits (SEC-EVID upload bounds, SEC-OPS)", () => {
  it("accepts one file of exactly maxUploadBytes with a few fields", async () => {
    const one = await send("/api/v1/probe/one-file", [file(MAX_UPLOAD)]);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({ size: MAX_UPLOAD });
    const parts = await send("/api/v1/probe/parts", [{ name: "a", content: "1" }, { name: "b", content: "2" }, file(10)]);
    expect(parts.statusCode).toBe(200);
    expect(parts.json()).toEqual({ files: [10], fields: ["a", "b"] });
  });

  it("refuses a file one byte above maxUploadBytes with 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await send("/api/v1/probe/one-file", [file(MAX_UPLOAD + 1)]);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    const viaParts = await send("/api/v1/probe/parts", [file(MAX_UPLOAD + 1)]);
    expect(viaParts.statusCode).toBe(413);
  });

  it("refuses a second file with 413", async () => {
    const res = await send("/api/v1/probe/parts", [file(10, "first"), file(10, "second")]);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("refuses more than 10 fields with 413", async () => {
    const fields = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, content: "x" }));
    const res = await send("/api/v1/probe/parts", fields);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    const ten = await send("/api/v1/probe/parts", fields.slice(0, 10));
    expect(ten.statusCode).toBe(200);
  });
});
