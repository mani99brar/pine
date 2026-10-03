// Prometheus metrics and the internal health endpoints (PRD-05 section 2.3): indexed block, finalized block, head block,
// lag seconds, cycles, errors and halted, plus /healthz (process alive) and /readyz (started, recent successful cycle,
// not halted) on a configurable internal host and port. A dedicated registry (never the global one) keeps tests isolated.

import http from "node:http";
import { Counter, Gauge, Registry } from "prom-client";

export interface IndexerMetrics {
  registry: Registry;
  indexedBlock: Gauge;
  finalizedBlock: Gauge;
  headBlock: Gauge;
  lagSeconds: Gauge;
  halted: Gauge;
  cycles: Counter;
  errors: Counter<"kind">;
}

export function createMetrics(): IndexerMetrics {
  const registry = new Registry();
  return {
    registry,
    indexedBlock: new Gauge({ name: "pine_indexer_indexed_block", help: "Highest block whose events are applied", registers: [registry] }),
    finalizedBlock: new Gauge({ name: "pine_indexer_finalized_block", help: "Finalized block both providers agree on", registers: [registry] }),
    headBlock: new Gauge({ name: "pine_indexer_head_block", help: "Latest head block observed on the primary provider", registers: [registry] }),
    lagSeconds: new Gauge({ name: "pine_indexer_lag_seconds", help: "Seconds between now and the indexed block timestamp", registers: [registry] }),
    halted: new Gauge({ name: "pine_indexer_halted", help: "1 when the indexer halted on an integrity conflict", registers: [registry] }),
    cycles: new Counter({ name: "pine_indexer_cycles_total", help: "Ingest cycles started", registers: [registry] }),
    errors: new Counter({ name: "pine_indexer_errors_total", help: "Failed ingest cycles", labelNames: ["kind"], registers: [registry] }),
  };
}

export interface HealthServerOptions {
  metrics: IndexerMetrics;
  ready: () => Promise<boolean>;
  host: string;
  port: number;
}

export function createHealthServer(options: HealthServerOptions): http.Server {
  return http.createServer((request, response) => {
    const send = (status: number, body: string, type = "text/plain; charset=utf-8"): void => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(body);
    };
    if (request.method !== "GET") return send(405, "method not allowed\n");
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/healthz") return send(200, "ok\n");
    if (path === "/readyz") {
      options
        .ready()
        .then((ready) => send(ready ? 200 : 503, ready ? "ready\n" : "not ready\n"))
        .catch(() => send(503, "not ready\n"));
      return;
    }
    if (path === "/metrics") {
      options.metrics.registry
        .metrics()
        .then((body) => send(200, body, options.metrics.registry.contentType))
        .catch(() => send(500, "metrics unavailable\n"));
      return;
    }
    send(404, "not found\n");
  });
}
