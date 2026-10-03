// Prometheus metrics (PRD-02 2.4): a dedicated Registry per adapter (never the global default), counters and
// histograms created lazily and cached by name, label names fixed at first use; a later sample with different label
// keys is dropped with one redacted warning per metric name. Served only on the internal listener.

import { createServer, type Server } from "node:http";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Metrics } from "../../contracts/app.js";

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LABEL = /^[a-z_][a-z0-9_]{0,31}$/;
const MAX_LABEL_VALUE = 64;

export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<string, { metric: Counter<string>; labels: string }>();
  private readonly histograms = new Map<string, { metric: Histogram<string>; labels: string }>();
  private readonly warned = new Set<string>();

  constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** Adds Node.js process metrics to this adapter's registry (main process only). */
  collectProcessMetrics(): void {
    collectDefaultMetrics({ register: this.registry, prefix: "pine_" });
  }

  increment(name: string, labels: Record<string, string> = {}): void {
    const clean = this.labels(name, labels);
    if (!clean) return;
    const key = Object.keys(clean).sort().join(",");
    let entry = this.counters.get(name);
    if (!entry) {
      entry = {
        metric: new Counter({ name: `pine_${name}_total`, help: `pine ${name} counter`, labelNames: Object.keys(clean).sort(), registers: [this.registry] }),
        labels: key,
      };
      this.counters.set(name, entry);
    }
    if (entry.labels !== key) return this.drop(name, "label keys differ from the first use");
    entry.metric.inc(clean);
  }

  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(seconds) || seconds < 0) return this.drop(name, "invalid observation");
    const clean = this.labels(name, labels);
    if (!clean) return;
    const key = Object.keys(clean).sort().join(",");
    let entry = this.histograms.get(name);
    if (!entry) {
      entry = {
        metric: new Histogram({
          name: `pine_${name}_seconds`,
          help: `pine ${name} duration`,
          labelNames: Object.keys(clean).sort(),
          buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
          registers: [this.registry],
        }),
        labels: key,
      };
      this.histograms.set(name, entry);
    }
    if (entry.labels !== key) return this.drop(name, "label keys differ from the first use");
    entry.metric.observe(clean, seconds);
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  private labels(name: string, labels: Record<string, string>): Record<string, string> | null {
    if (!NAME.test(name)) {
      this.drop(name, "invalid metric name");
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      if (!LABEL.test(key)) {
        this.drop(name, "invalid label name");
        return null;
      }
      out[key] = String(value).slice(0, MAX_LABEL_VALUE);
    }
    return out;
  }

  private drop(name: string, reason: string): void {
    const safeName = NAME.test(name) ? name : "invalid";
    if (this.warned.has(safeName)) return;
    this.warned.add(safeName);
    this.warn(`metric ${safeName} sample dropped: ${reason}`);
  }
}

export interface MetricsListener {
  close(): Promise<void>;
  address(): { port: number } | null;
}

/** Internal listener serving GET /metrics only (bind it to a private interface). */
export async function startMetricsListener(metrics: PromMetrics, options: { host: string; port: number }): Promise<MetricsListener> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (request.method !== "GET" || path !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    metrics.render().then(
      ({ contentType, body }) => response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(body),
      () => response.writeHead(500, { "content-type": "text/plain" }).end("error"),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    address: () => {
      const value = server.address();
      return value !== null && typeof value === "object" ? { port: value.port } : null;
    },
  };
}
