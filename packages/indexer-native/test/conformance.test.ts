import "./lock.js";
import { describeReadModelConformance } from "@pine/shared/testing/read-model-conformance";
import { applyEvents } from "../src/apply.js";
import { createNativeReadModel } from "../src/read-model.js";
import { advanceCursor } from "../src/store.js";
import { openDatabase } from "./harness.js";

// The scenario events go through applyEvents (the poller's apply path) and the cursor advances with the poller's
// cursor function, in one transaction, on a fresh PGlite per factory call.
describeReadModelConformance("native", async (events, setup) => {
  const database = await openDatabase();
  try {
    await database.db.transaction(async (tx) => {
      await applyEvents(tx, events, { chainId: setup.chainId, questionTimeout: setup.questionTimeout });
      const last = events.at(-1);
      if (last) await advanceCursor(tx, { chainId: setup.chainId, block: last.blockNumber, blockHash: last.blockHash, blockTimestamp: last.blockTimestamp });
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  return { readModel: createNativeReadModel(database.db, { chainId: setup.chainId }), close: database.close };
});
