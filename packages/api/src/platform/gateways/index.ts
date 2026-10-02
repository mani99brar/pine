// Placeholder owned by the `platform-gateways` lane, which replaces it with the real implementation.
import type { GatewayFactory } from "../../contracts/platform.js";

export const createGateways: GatewayFactory = async () => {
  throw new Error("platform-gateways is not implemented yet");
};
