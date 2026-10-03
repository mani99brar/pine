import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { PromMetrics, startMetricsListener } from "./metrics.js";

describe("metrics adapter", () => {
  it("creates counters and histograms lazily in a dedicated registry", async () => {
    const metrics = new PromMetrics();
    metrics.increment("github_link_revoked", { reason: "unauthorized" });
    metrics.increment("github_link_revoked", { reason: "unauthorized" });
    metrics.observe("http_request", 0.12, { method: "GET", route: "/x", status: "200" });
    const { body } = await metrics.render();
    expect(body).toContain('pine_github_link_revoked_total{reason="unauthorized"} 2');
    expect(body).toContain("pine_http_request_seconds_bucket");
  });

  it("two adapters never collide (no global registry)", async () => {
    const a = new PromMetrics();
    const b = new PromMetrics();
    a.increment("jobs_runs", { job: "x" });
    b.increment("jobs_runs", { job: "x" });
    expect((await a.render()).body).toContain('pine_jobs_runs_total{job="x"} 1');
    expect((await b.render()).body).toContain('pine_jobs_runs_total{job="x"} 1');
  });

  it("drops samples whose label keys differ from the first use, warning once per name", async () => {
    const warnings: string[] = [];
    const metrics = new PromMetrics((message) => warnings.push(message));
    metrics.increment("siwe_failures", { reason: "expired" });
    metrics.increment("siwe_failures", { other: "x" });
    metrics.increment("siwe_failures", {});
    metrics.increment("Bad Name!");
    expect(warnings).toEqual(["metric siwe_failures sample dropped: label keys differ from the first use", "metric invalid sample dropped: invalid metric name"]);
    expect((await metrics.render()).body).toContain('pine_siwe_failures_total{reason="expired"} 1');
  });

  it("serves GET /metrics on the internal listener only", async () => {
    const metrics = new PromMetrics();
    metrics.increment("probe");
    const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
    try {
      const port = listener.address()?.port ?? 0;
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", reject);
          req.end();
        });
      const ok = await get("/metrics");
      expect(ok.status).toBe(200);
      expect(ok.body).toContain("pine_probe_total 1");
      expect((await get("/other")).status).toBe(404);
    } finally {
      await listener.close();
    }
  });
});
