import { describe, expect, it } from "vitest";
import { createRedactor } from "../../contracts/redact.js";
import { ChainIntegrityError, createChainGateway } from "./chain.js";
import { chainIdOnly, rejectionOf, scriptedTransport, type RpcScript } from "./testing/harness.js";

const RPC_KEY = "https://rpc.example.test/v2/key-abcdef0123456789";
const redact = createRedactor([RPC_KEY]);

const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

function block(number: number, hash: string) {
  return {
    number: `0x${number.toString(16)}`,
    hash,
    parentHash: `0x${"11".repeat(32)}`,
    timestamp: "0x6700000",
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: `0x${"00".repeat(20)}`,
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"22".repeat(32)}`,
    stateRoot: `0x${"33".repeat(32)}`,
    receiptsRoot: `0x${"44".repeat(32)}`,
    sha3Uncles: `0x${"55".repeat(32)}`,
    size: "0x200",
    totalDifficulty: "0x0",
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x7",
    mixHash: `0x${"66".repeat(32)}`,
  };
}

function rpc(blocks: { finalized?: ReturnType<typeof block>; byNumber?: Map<string, ReturnType<typeof block>> }, chainId = "0x64"): RpcScript {
  return (method, params) => {
    if (method === "eth_chainId") return chainId;
    if (method === "eth_getBlockByNumber") {
      const [tag] = params as [string, boolean];
      if (tag === "finalized") return blocks.finalized ?? null;
      return blocks.byNumber?.get(tag) ?? null;
    }
    throw new Error(`Unscripted RPC call: ${method}`);
  };
}

async function gateway(primary: RpcScript, secondary: RpcScript) {
  return createChainGateway({ chainId: 100, transports: { primary: scriptedTransport(primary), secondary: scriptedTransport(secondary) }, redact });
}

describe("chain gateway (PRD-02 3.3)", () => {
  it("checks eth_chainId on both providers at startup", async () => {
    await expect(gateway(chainIdOnly, chainIdOnly)).resolves.toMatchObject({ chainId: 100 });
    await expect(gateway(rpc({}, "0x1"), chainIdOnly)).rejects.toThrow(/primary RPC reports chain id 1, expected 100/);
    await expect(gateway(chainIdOnly, rpc({}, "0xa"))).rejects.toThrow(/secondary RPC reports chain id 10, expected 100/);
  });

  it("returns the finalized number when both providers agree on its hash", async () => {
    const finalized = block(0x1234, HASH_A);
    const chain = await gateway(rpc({ finalized }), rpc({ byNumber: new Map([["0x1234", block(0x1234, HASH_A)]]) }));
    await expect(chain.finalizedBlock()).resolves.toBe(0x1234n);
  });

  it("throws an integrity error when the secondary has another hash at the finalized number", async () => {
    const chain = await gateway(rpc({ finalized: block(0x1234, HASH_A) }), rpc({ byNumber: new Map([["0x1234", block(0x1234, HASH_B)]]) }));
    await expect(chain.finalizedBlock()).rejects.toBeInstanceOf(ChainIntegrityError);
  });

  it("throws when the secondary does not have the block", async () => {
    const chain = await gateway(rpc({ finalized: block(0x1234, HASH_A) }), rpc({}));
    await expect(chain.finalizedBlock()).rejects.toThrow();
  });

  it("redacts RPC URLs and keys from every error", async () => {
    const leaky: RpcScript = (method) => {
      if (method === "eth_chainId") return "0x64";
      throw new Error(`request to ${RPC_KEY} failed`);
    };
    const chain = await gateway(leaky, chainIdOnly);
    const error = await rejectionOf(chain.finalizedBlock());
    expect(error.message).not.toContain("key-abcdef0123456789");
    const startup = await rejectionOf(
      gateway(() => {
        throw new Error(`connect failed ${RPC_KEY}`);
      }, chainIdOnly),
    );
    expect(startup.message).not.toContain("key-abcdef0123456789");
  });
});
