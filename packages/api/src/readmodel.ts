// Placeholder owned by the `assembly` lane, which wires @pine/indexer-native or @pine/read-model-envio here.
import type { ReadModelFactory } from "./contracts/platform.js";

export const createReadModel: ReadModelFactory = async () => {
  throw new Error("read model wiring is not implemented yet");
};
