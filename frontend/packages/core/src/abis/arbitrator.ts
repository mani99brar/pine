/**
 * Kleros arbitration contracts on the arbitration chain (Ethereum): the cross-chain foreign proxies
 * (Gnosis/Optimism/Base markets) and Realitio_v2_1_ArbitratorWithAppeals (Ethereum markets).
 * Source: docs/research/seer-integration.md §6.
 * `submitEvidence(_arbitrationID, _evidenceURI)`: `_arbitrationID = uint256(realityQuestionId)`; permissionless,
 * no status check (works before a dispute exists). Whether jurors see pre-dispute evidence is unverified.
 */
export const arbitratorProxyAbi = [
  {
    type: 'function',
    name: 'requestArbitration',
    stateMutability: 'payable',
    inputs: [
      { name: '_questionID', type: 'bytes32' },
      { name: '_maxPrevious', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getDisputeFee',
    stateMutability: 'view',
    inputs: [{ name: '_questionID', type: 'bytes32' }],
    outputs: [{ name: 'fee', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'submitEvidence',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_arbitrationID', type: 'uint256' },
      { name: '_evidenceURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'arbitrator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'arbitratorExtraData',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'arbitrationIDToRequester',
    stateMutability: 'view',
    inputs: [{ name: 'arbitrationID', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'ArbitrationRequested',
    inputs: [
      { name: '_questionID', type: 'bytes32', indexed: true },
      { name: '_requester', type: 'address', indexed: true },
      { name: '_maxPrevious', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ArbitrationCreated',
    inputs: [
      { name: '_questionID', type: 'bytes32', indexed: true },
      { name: '_requester', type: 'address', indexed: true },
      { name: '_disputeID', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Evidence',
    inputs: [
      { name: '_arbitrator', type: 'address', indexed: true },
      { name: '_evidenceGroupID', type: 'uint256', indexed: true },
      { name: '_party', type: 'address', indexed: true },
      { name: '_evidence', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Ruling',
    inputs: [
      { name: '_arbitrator', type: 'address', indexed: true },
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_ruling', type: 'uint256', indexed: false },
    ],
  },
] as const

/** KlerosLiquid (Kleros v1 court on Ethereum) read fragments. */
export const klerosLiquidAbi = [
  {
    type: 'function',
    name: 'arbitrationCost',
    stateMutability: 'view',
    inputs: [{ name: '_extraData', type: 'bytes' }],
    outputs: [{ name: 'cost', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'disputeStatus',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [{ name: 'status', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'currentRuling',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [{ name: 'ruling', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'appealPeriod',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [
      { name: 'start', type: 'uint256' },
      { name: 'end', type: 'uint256' },
    ],
  },
] as const
