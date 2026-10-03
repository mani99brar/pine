// The frozen conformance suite against createEnvioReadModel over the fake Hasura endpoint, which serves the entity
// rows the real indexer-envio handlers produced for exactly the events the suite passes (hash-bound snapshots).

import { describeReadModelConformance } from "@pine/shared/testing/read-model-conformance";
import { createEnvioReadModel } from "../src/index.js";
import { createFakeHasura } from "./fake-hasura.js";
import { snapshotFor } from "./snapshots.js";

const URL = "https://envio.test/v1/graphql";
const SECRET = "fake-admin-secret";

describeReadModelConformance("envio", async (events, setup) => {
  const fake = createFakeHasura(snapshotFor(events), { url: URL, adminSecret: SECRET, chainId: setup.chainId });
  return { readModel: createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch: fake.fetch, chainId: setup.chainId }) };
});
