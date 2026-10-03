// Chain gateway (PRD-02 3.3, SEC-TX-09): read-only viem clients for two independent RPC providers. Both must report the
// configured chain id at startup; finalizedBlock() takes the primary's `finalized` block and requires the secondary to
// return the same hash at that number. Every error message is redacted (RPC URLs embed API keys).

import { createPublicClient, type PublicClient, type Transport } from "viem";
import { gnosis } from "viem/chains";
import type { ChainGateway } from "../../contracts/app.js";
import type { Redactor } from "../../contracts/redact.js";
import { safeErrorMessage } from "../../contracts/redact.js";

export class ChainIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainIntegrityError";
  }
}

export async function createChainGateway(input: {
  chainId: number;
  transports: { primary: Transport; secondary: Transport };
  redact: Redactor;
}): Promise<ChainGateway> {
  const { chainId, redact } = input;
  const client = (transport: Transport) => createPublicClient({ chain: gnosis, transport }) as unknown as PublicClient;
  const primary = client(input.transports.primary);
  const secondary = client(input.transports.secondary);

  const guarded = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ChainIntegrityError) throw error;
      // No `cause`: viem errors embed the RPC URL (and its API key); only the redacted message survives.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${what} failed: ${safeErrorMessage(error, redact)}`);
    }
  };

  for (const [name, rpc] of [["primary", primary], ["secondary", secondary]] as const) {
    const reported = await guarded(`eth_chainId on the ${name} RPC`, () => rpc.getChainId());
    if (reported !== chainId) throw new ChainIntegrityError(`The ${name} RPC reports chain id ${reported}, expected ${chainId}`);
  }

  return {
    chainId,
    publicClient: primary,
    async finalizedBlock() {
      const head = await guarded("Reading the finalized block", () => primary.getBlock({ blockTag: "finalized" }));
      if (head.number === null || head.hash === null) throw new ChainIntegrityError("The primary RPC returned a pending finalized block");
      const number = head.number;
      const other = await guarded("Reading the finalized block from the secondary RPC", () => secondary.getBlock({ blockNumber: number }));
      if (other.hash === null || other.hash.toLowerCase() !== head.hash.toLowerCase()) {
        throw new ChainIntegrityError(`RPC providers disagree on the hash of finalized block ${number}`);
      }
      return number;
    },
  };
}
