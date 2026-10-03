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

/** formatUtc vectors: [unix seconds, "YYYY-MM-DD HH:MM:SS"] (checked against GNU date -u). Solidity must match. */
export const UTC_FORMAT_VECTORS: readonly (readonly [number, string])[] = [[0, "1970-01-01 00:00:00"], [59, "1970-01-01 00:00:59"], [86399, "1970-01-01 23:59:59"], [86400, "1970-01-02 00:00:00"], [951782399, "2000-02-28 23:59:59"], [951782400, "2000-02-29 00:00:00"], [1709164799, "2024-02-28 23:59:59"], [1709164800, "2024-02-29 00:00:00"], [1709251200, "2024-03-01 00:00:00"], [1791158400, "2026-10-05 00:00:00"], [1893455999, "2029-12-31 23:59:59"], [4107542399, "2100-02-28 23:59:59"], [4107542400, "2100-03-01 00:00:00"], [4294967295, "2106-02-07 06:28:15"]];

/** Raw CIDv1 (sha2-256) locators derived from digests: ClaimRegistry's on-chain base32 encoding must match. */
export const RAW_CID_VECTORS: readonly (readonly [string, string])[] = [["0x1111111111111111111111111111111111111111111111111111111111111111", "bafkreiarceirceirceirceirceirceirceirceirceirceirceirceirce"], ["0x0000000000000000000000000000000000000000000000000000000000000001", "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae"], ["0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"], ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "bafkreih777777777777777777777777777777777777777777777777774"]];

/** Outcome token names: ["PY_" + first 4 bytes of claimDocumentSha256 (8 lowercase hex), "PN_" + same]. */
export const TOKEN_NAME_VECTORS = [
  { claimDocumentSha256: "0x1111111111111111111111111111111111111111111111111111111111111111", tokenNames: ["PY_11111111", "PN_11111111"] },
  { claimDocumentSha256: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", tokenNames: ["PY_e3b0c442", "PN_e3b0c442"] },
] as const;

/** renderQuestion vectors: ClaimRegistry.renderQuestion must return exactly `question` for `input`. */
export const QUESTION_VECTORS = [
  {
    "input": {
      "evidenceRegistry": "0x00000000000000000000000000000000000E01de",
      "title": "Reporter deposits never use arbitration funds or the operator gas reserve",
      "evidenceDeadline": 1791158400,
      "revealDeadline": 1791331200,
      "repositoryId": 427016914,
      "commit": "AB12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
      "claimDocumentSha256": "0x1111111111111111111111111111111111111111111111111111111111111111",
      "policyDocumentSha256": "0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc"
    },
    "question": "Pine claim [Reporter deposits never use arbitration funds or the operator gas reserve]: was a reproducible counterexample submitted to evidence registry 0x00000000000000000000000000000000000e01de on Gnosis, recorded before 2026-10-05 00:00:00 UTC and disclosed before 2026-10-07 00:00:00 UTC, for GitHub repository id 427016914 at commit ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12? Terms: claim document ipfs://bafkreiarceirceirceirceirceirceirceirceirceirceirceirceirce (sha256 0x1111111111111111111111111111111111111111111111111111111111111111), policy ipfs://bafkreieuas4qw7vchkv4istyw5vrtz5rk3uor75oy2m32evu3k63fwrm7q (sha256 0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
  },
  {
    "input": {
      "evidenceRegistry": "0xffffffffffffffffffffffffffffffffffffffff",
      "title": "x",
      "evidenceDeadline": 4294880895,
      "revealDeadline": 4294967295,
      "repositoryId": 1,
      "commit": "0000000000000000000000000000000000000001",
      "claimDocumentSha256": "0x0000000000000000000000000000000000000000000000000000000000000001",
      "policyDocumentSha256": "0xff00000000000000000000000000000000000000000000000000000000000000"
    },
    "question": "Pine claim [x]: was a reproducible counterexample submitted to evidence registry 0xffffffffffffffffffffffffffffffffffffffff on Gnosis, recorded before 2106-02-06 06:28:15 UTC and disclosed before 2106-02-07 06:28:15 UTC, for GitHub repository id 1 at commit 0000000000000000000000000000000000000001? Terms: claim document ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae (sha256 0x0000000000000000000000000000000000000000000000000000000000000001), policy ipfs://bafkreih7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (sha256 0xff00000000000000000000000000000000000000000000000000000000000000). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
  },
  {
    "input": {
      "evidenceRegistry": "0x1234567890abcdef1234567890abcdef12345678",
      "title": " ~!#$%&'()*+,-./0123456789:;<=>?@^_`{|}",
      "evidenceDeadline": 1709164800,
      "revealDeadline": 1709251200,
      "repositoryId": 9007199254740991,
      "commit": "ffffffffffffffffffffffffffffffffffffffff",
      "claimDocumentSha256": "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "policyDocumentSha256": "0x95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7"
    },
    "question": "Pine claim [ ~!#$%&'()*+,-./0123456789:;<=>?@^_`{|}]: was a reproducible counterexample submitted to evidence registry 0x1234567890abcdef1234567890abcdef12345678 on Gnosis, recorded before 2024-02-29 00:00:00 UTC and disclosed before 2024-03-01 00:00:00 UTC, for GitHub repository id 9007199254740991 at commit ffffffffffffffffffffffffffffffffffffffff? Terms: claim document ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku (sha256 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855), policy ipfs://bafkreievo4wckp4t23rwz2dd7uodottyh3q725poympfkiujxlazko7f64 (sha256 0x95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
  }
] as const;
