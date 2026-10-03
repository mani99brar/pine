// config.yaml pinned to the shared ABIs and addresses (PRD-05 3.1, decisions.md). `simulate` hands handlers already
// decoded params, so a wrong event name, parameter order, type or indexed flag in config.yaml would otherwise go unseen:
// Envio would compute a different topic0 or decode the wrong topics on chain. (The native lane additionally verifies
// topic0s against real Gnosis logs; this test only proves config.yaml equals the shared ABIs.)

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbiItem, toEventSelector, type AbiEvent, type AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { conditionalTokensAbi, klerosHomeProxyAbi, realityV3Abi } from "@pine/shared/abi/external";
import { claimRegistryAbi, evidenceRegistryAbi } from "@pine/shared/abi/generated";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import { SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(path.join(ROOT, "config.yaml"), "utf8");
// Written by `envio codegen`, which the package's test and typecheck scripts run first.
const GENERATED_TYPES = path.join(ROOT, ".envio/types.d.ts");

interface ParsedConfig {
  events: Map<string, string[]>;
  addresses: Map<string, string>;
  topLevel: Map<string, string>;
  chain: Map<string, string>;
}

/** Line-based reader for this file's fixed layout (no YAML dependency in the lane). */
function parseConfig(text: string): ParsedConfig {
  const events = new Map<string, string[]>();
  const addresses = new Map<string, string>();
  const topLevel = new Map<string, string>();
  const chain = new Map<string, string>();
  let section = "";
  let contract = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      const match = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (match) {
        section = match[1]!;
        if (match[2]) topLevel.set(match[1]!, match[2]);
      }
      continue;
    }
    if (section === "contracts") {
      const name = /^ {2}- name: (\w+)$/.exec(line);
      if (name) {
        contract = name[1]!;
        events.set(contract, []);
      }
      const event = /^ {6}- event: "(.+)"$/.exec(line);
      if (event) events.get(contract)!.push(event[1]!);
    } else if (section === "chains") {
      const key = /^ {2}[- ] ([a-z_]+): (.+)$/.exec(line);
      if (key) chain.set(key[1]!, key[2]!);
      const name = /^ {6}- name: (\w+)$/.exec(line);
      if (name) contract = name[1]!;
      const address = /^ {8}address: "(.+)"$/.exec(line);
      if (address) addresses.set(contract, address[1]!);
    }
  }
  return { events, addresses, topLevel, chain };
}

type Normalized = { name: string; type: string; indexed: boolean; components?: Normalized[] };

function normalizeParams(params: readonly AbiParameter[]): Normalized[] {
  return params.map((param) => {
    const out: Normalized = { name: param.name ?? "", type: param.type, indexed: "indexed" in param && param.indexed === true };
    if ("components" in param && param.components) out.components = normalizeParams(param.components);
    return out;
  });
}

const normalizeEvent = (event: AbiEvent) => ({ name: event.name, inputs: normalizeParams(event.inputs), anonymous: event.anonymous === true });

const sharedEvents = (abi: readonly unknown[]): AbiEvent[] => abi.filter((item): item is AbiEvent => (item as { type?: unknown }).type === "event");

/** Contract name in config.yaml -> (shared ABI, events of chain-events.ts it must declare). */
const EXPECTED: Record<string, { abi: readonly unknown[]; events: string[] }> = {
  ClaimRegistry: { abi: claimRegistryAbi, events: ["ClaimCreated"] },
  EvidenceRegistry: { abi: evidenceRegistryAbi, events: ["EvidenceCommitted", "EvidenceRevealed", "EvidencePublished"] },
  RealityETH: {
    abi: realityV3Abi,
    events: ["LogNewAnswer", "LogAnswerReveal", "LogNotifyOfArbitrationRequest", "LogCancelArbitration", "LogFinalize", "LogReopenQuestion", "LogFundAnswerBounty"],
  },
  ConditionalTokens: { abi: conditionalTokensAbi, events: ["ConditionResolution"] },
  KlerosHomeProxy: {
    abi: klerosHomeProxyAbi,
    events: ["RequestNotified", "RequestRejected", "RequestAcknowledged", "RequestCanceled", "ArbitrationFailed", "ArbitratorAnswered", "ArbitrationFinished"],
  },
};

describe("config.yaml", () => {
  const config = parseConfig(CONFIG);

  it("declares exactly the chain-events.ts sources, each signature equal to the shared ABI (names, order, types, indexed)", () => {
    expect([...config.events.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [contract, expected] of Object.entries(EXPECTED)) {
      const declared = (config.events.get(contract) ?? []).map((signature) => parseAbiItem(`event ${signature}`) as AbiEvent);
      expect(declared.map((event) => event.name), contract).toEqual(expected.events);
      const shared = sharedEvents(expected.abi);
      for (const event of declared) {
        const reference = shared.find((item) => item.name === event.name);
        expect(reference, `${contract}.${event.name} in the shared ABI`).toBeDefined();
        expect(normalizeEvent(event), `${contract}.${event.name}`).toEqual(normalizeEvent(reference!));
        expect(toEventSelector(event)).toBe(toEventSelector(reference!));
      }
    }
  });

  it("pins external addresses to GNOSIS_EXTERNAL and defaults Pine registries to the scenario placeholders", () => {
    expect(Object.fromEntries(config.addresses)).toEqual({
      ClaimRegistry: `\${ENVIO_CLAIM_REGISTRY_ADDRESS:-${SCENARIO_ADDRESSES.claimRegistry}}`,
      EvidenceRegistry: `\${ENVIO_EVIDENCE_REGISTRY_ADDRESS:-${SCENARIO_ADDRESSES.evidenceRegistry}}`,
      RealityETH: GNOSIS_EXTERNAL.seer.realitio,
      ConditionalTokens: GNOSIS_EXTERNAL.seer.conditionalTokens,
      KlerosHomeProxy: GNOSIS_EXTERNAL.seer.arbitrator,
    });
    expect(SCENARIO_ADDRESSES.reality).toBe(GNOSIS_EXTERNAL.seer.realitio);
    expect(SCENARIO_ADDRESSES.conditionalTokens).toBe(GNOSIS_EXTERNAL.seer.conditionalTokens);
    expect(SCENARIO_ADDRESSES.klerosHomeProxy).toBe(GNOSIS_EXTERNAL.seer.arbitrator);
  });

  it("SEC-IDX-03 indexes Gnosis with reorg rollback (depth 200), a ~40 block lag, lowercase addresses and transaction hashes", () => {
    expect(config.chain.get("id")).toBe("100");
    // Overridable only so createTestIndexer can finish (vitest.config.ts); production must keep the default.
    expect(config.chain.get("block_lag")).toBe("${ENVIO_BLOCK_LAG:-40}");
    expect(config.chain.get("max_reorg_depth")).toBe("200");
    expect(config.topLevel.get("rollback_on_reorg")).toBe("true");
    expect(config.topLevel.get("address_format")).toBe("lowercase");
    expect(CONFIG).toMatch(/field_selection:\n {2}transaction_fields:\n {4}- hash\n/);
  });

  it("selects the block hash and the transaction hash for every event (Envio's generated event types expose both)", () => {
    expect(existsSync(GENERATED_TYPES), "run envio codegen first (the test script does)").toBe(true);
    const types = readFileSync(GENERATED_TYPES, "utf8");
    const typeBody = (name: string) => {
      const match = new RegExp(`^type ${name} = \\{\\n([\\s\\S]*?)^\\};`, "m").exec(types);
      expect(match, name).not.toBeNull();
      return match![1]!;
    };
    // A field missing from field_selection is typed FieldNotSelected<...> instead of string.
    expect(typeBody("EvmBlock")).toMatch(/^ {2}readonly hash: string;$/m);
    expect(typeBody("EvmTransaction")).toMatch(/^ {2}readonly hash: string;$/m);
    expect(typeBody("EvmTransaction")).toMatch(/readonly transactionIndex: FieldNotSelected</);
  });

  it("configures the RPC from env as a fallback to HyperSync, with Pine registries and start block from env", () => {
    expect(CONFIG).toMatch(/\n {4}rpc:\n {6}- url: \$\{ENVIO_GNOSIS_RPC_URL:-https:\/\/rpc\.gnosischain\.com\}\n {8}for: \$\{ENVIO_GNOSIS_RPC_FOR:-fallback\}\n/);
    expect(config.chain.get("start_block")).toBe("${ENVIO_PINE_START_BLOCK:-0}");
  });
});
