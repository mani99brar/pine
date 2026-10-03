// Stand-in for optional @x402/* modules that @coinbase/cdp-sdk imports (reached through RainbowKit →
// @wagmi/connectors → @base-org/account). Pine never uses x402 payments; every export throws if called.
function unavailable() {
  throw new Error('x402 payments are not available in Pine')
}
export const AuthCaptureEvmScheme = unavailable
export const BUILDER_CODE = unavailable
export const BUILDER_CODE_PATTERN = unavailable
export const BUILDER_CODE_SCHEMA = unavailable
export const BatchSettlementEvmScheme = unavailable
export const BuilderCodeClientExtension = unavailable
export const ExactEvmScheme = unavailable
export const ExactEvmSchemeV1 = unavailable
export const ExactSvmScheme = unavailable
export const ExactSvmSchemeV1 = unavailable
export const HTTPFacilitatorClient = unavailable
export const PaymentRequirementsV1Schema = unavailable
export const PaymentRequirementsV2Schema = unavailable
export const UptoEvmScheme = unavailable
export const UptoSvmScheme = unavailable
export const bazaarResourceServerExtension = unavailable
export const builderCodeResourceServerExtension = unavailable
export const paymentMiddlewareFromConfig = unavailable
export const paymentMiddlewareFromHTTPServer = unavailable
export const registerExactEvmScheme = unavailable
export const toClientEvmSigner = unavailable
export const wrapFetchWithPayment = unavailable
export const x402Client = unavailable
export const x402HTTPResourceServer = unavailable
export const x402ResourceServer = unavailable
