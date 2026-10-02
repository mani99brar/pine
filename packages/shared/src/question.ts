// FROZEN. The market question, byte-identical to ClaimRegistry.renderQuestion() on-chain (cross-language vectors in
// testing/vectors.ts). The registry composes the question itself; this twin lets the API preview it and lets clients
// verify a market's question offline. It validates the format rules (title, digests, commit, repository id, uint32
// timestamps); the on-chain function additionally enforces the deadline windows and min-bond bounds relative to the block.
// The question is pasted raw by Seer into Reality template 2 (`{"title": "%s", ...}`), so it must never contain `"`, `\`
// or control characters: the title is delimited with brackets and its own `"`/`\` are forbidden.

import { rawCidFromSha256 } from "./canonical.js";
import type { Address, Hex32 } from "./types.js";

export const MAX_TITLE_BYTES = 120;

export class QuestionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionInputError";
  }
}

export interface QuestionInput {
  evidenceRegistry: Address;
  title: string;
  evidenceDeadline: number;
  revealDeadline: number;
  repositoryId: number;
  /** 40 hex characters, no 0x. */
  commit: string;
  claimDocumentSha256: Hex32;
  policyDocumentSha256: Hex32;
}

/**
 * Printable ASCII 0x20..0x7E except '"' (0x22), '\' (0x5C), '[' (0x5B) and ']' (0x5D); 1..MAX_TITLE_BYTES bytes. Brackets are
 * excluded so a title can never close the "Pine claim [<title>]" delimiter and pose as template text.
 */
export function validateTitle(title: string): void {
  if (title.length < 1 || title.length > MAX_TITLE_BYTES) throw new QuestionInputError(`title must be 1..${MAX_TITLE_BYTES} bytes`);
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c || code === 0x5b || code === 0x5d) throw new QuestionInputError(`title has a forbidden character at index ${index}`);
  }
}

/** "YYYY-MM-DD HH:MM:SS" in UTC for unix seconds in [0, 2^32). */
export function formatUtc(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds >= 2 ** 32) throw new QuestionInputError("timestamp out of range");
  const iso = new Date(seconds * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function hex32(value: Hex32, name: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new QuestionInputError(`${name} must be a nonzero 32-byte hex value`);
  return value.toLowerCase();
}

/** Seer outcome token names composed by ClaimRegistry: ["PY_" + first 4 digest bytes as 8 lowercase hex, "PN_" + same]. */
export function tokenNames(claimDocumentSha256: Hex32): readonly [string, string] {
  const digest = hex32(claimDocumentSha256, "claim document sha256");
  const prefix = digest.slice(2, 10);
  return [`PY_${prefix}`, `PN_${prefix}`] as const;
}

export function renderQuestion(input: QuestionInput): string {
  validateTitle(input.title);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.evidenceRegistry)) throw new QuestionInputError("evidence registry must be an address");
  if (!/^[0-9a-fA-F]{40}$/.test(input.commit) || /^0{40}$/.test(input.commit)) throw new QuestionInputError("commit must be 40 hex characters and nonzero");
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new QuestionInputError("repository id must be a positive integer");
  const claimSha = hex32(input.claimDocumentSha256, "claim document sha256") as Hex32;
  const policySha = hex32(input.policyDocumentSha256, "policy sha256") as Hex32;
  return (
    `Pine claim [${input.title}]: was a reproducible counterexample submitted to evidence registry ${input.evidenceRegistry.toLowerCase()} ` +
    `on Gnosis, recorded before ${formatUtc(input.evidenceDeadline)} UTC and disclosed before ${formatUtc(input.revealDeadline)} UTC, ` +
    `for GitHub repository id ${input.repositoryId} at commit ${input.commit.toLowerCase()}? ` +
    `Terms: claim document ipfs://${rawCidFromSha256(claimSha)} (sha256 ${claimSha}), ` +
    `policy ipfs://${rawCidFromSha256(policySha)} (sha256 ${policySha}). ` +
    `Yes = at least one timely admissible counterexample; No = none; admissibility per the policy.`
  );
}
