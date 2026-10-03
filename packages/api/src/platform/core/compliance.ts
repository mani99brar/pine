// Compliance hooks (SEC-LEGAL-01..03): sanctions denylist, geofence from the trusted proxy's country header, and terms
// acceptance of the current digest. Fails closed: 451 for a screened wallet or blocked/unknown (production, gated
// action) country, TERMS_REQUIRED without an acceptance of the current terms. Refusals are audited.

import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AuditLog, ComplianceAction, ComplianceGateway, Database, SessionInfo } from "../../contracts/app.js";
import type { DeploymentEnvironment } from "../../contracts/config.js";
import { ApiError } from "../../contracts/errors.js";
import type { ComplianceSettings, SanctionsSettings } from "./config.js";
import { queryRows } from "./db.js";

export interface ComplianceDeps {
  db: Database;
  audit: AuditLog;
  environment: DeploymentEnvironment;
  termsDigest: string;
  trustProxyHops: number;
  compliance: ComplianceSettings;
  sanctions: SanctionsSettings;
}

/**
 * The client country from the configured trusted header, or null. Honoured only when trustProxy hops are configured
 * (otherwise any client could set it). "XX" (unknown) and "T1" (Tor) count as unknown.
 */
export function requestCountry(request: Pick<FastifyRequest, "headers">, settings: Pick<ComplianceDeps, "trustProxyHops" | "compliance">): string | null {
  const header = settings.compliance.countryHeader;
  if (header === null || settings.trustProxyHops < 1) return null;
  const raw = request.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  return code;
}

export class PlatformCompliance implements ComplianceGateway {
  constructor(private readonly deps: ComplianceDeps) {}

  async assertAllowed(request: FastifyRequest, session: SessionInfo, action: ComplianceAction): Promise<void> {
    const wallet = session.wallet.toLowerCase();
    if (this.deps.sanctions.blockedWallets.has(wallet)) {
      await this.refuse(request, session, action, "sanctions");
      throw new ApiError("UNAVAILABLE_FOR_LEGAL_REASONS", "This action is not available");
    }
    const country = requestCountry(request, this.deps);
    if (country === null) {
      if (this.deps.environment === "production" && this.deps.compliance.countryRequiredActions.has(action)) {
        await this.refuse(request, session, action, "country_unknown");
        throw new ApiError("UNAVAILABLE_FOR_LEGAL_REASONS", "This action is not available");
      }
    } else if (this.deps.compliance.blockedCountries[action].has(country)) {
      await this.refuse(request, session, action, "geofence", country);
      throw new ApiError("UNAVAILABLE_FOR_LEGAL_REASONS", "This action is not available in your region");
    }
    const accepted = await queryRows<{ ok: number }>(
      this.deps.db,
      sql`SELECT 1::int AS ok FROM terms_acceptances WHERE user_id = ${session.userId}::uuid AND terms_digest = ${this.deps.termsDigest} LIMIT 1`,
    );
    if (accepted.length === 0) throw new ApiError("TERMS_REQUIRED", "Accept the current terms and risk disclosure first");
  }

  private async refuse(request: FastifyRequest, session: SessionInfo, action: ComplianceAction, reason: string, country?: string): Promise<void> {
    await this.deps.audit.record({
      actorUserId: session.userId,
      action: "compliance.refused",
      subjectType: "user",
      subjectId: session.userId,
      details: country === undefined ? { action, reason } : { action, reason, country },
      ip: request.ip,
    });
  }
}
