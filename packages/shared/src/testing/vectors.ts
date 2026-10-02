// FROZEN cross-language test vectors. Solidity tests (contracts/) and TypeScript tests must reproduce these exactly.
// Computed independently with viem (computeEvidenceCommitment) and Foundry cast (abi-encode + keccak), 2026-10-02.

export const EVIDENCE_COMMITMENT_VECTOR = {
  typehash: "0x39252baa9e1d793d1e7c90d6eb7a5cbde75f900e250ba793859fdd5c8e567865",
  input: {
    chainId: 100,
    registry: "0x1111111111111111111111111111111111111111",
    market: "0x2222222222222222222222222222222222222222",
    submitter: "0x3333333333333333333333333333333333333333",
    contentSha256: "0x4444444444444444444444444444444444444444444444444444444444444444",
    salt: "0x5555555555555555555555555555555555555555555555555555555555555555",
  },
  commitment: "0xabb073d23ecc75cb6f84541dac5b614ded2b1c1fad1f8ab83823245b3313d18b",
} as const;
