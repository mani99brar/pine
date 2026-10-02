/**
 * Seer minimal fragments (MarketFactory, Router, Market, MarketView-free reads).
 * Source: docs/research/seer-integration.md §2–§3 (seer-pm/demo @ 60423441, deployed ABIs compared).
 */
export const createMarketParamsComponents = [
  { name: 'marketName', type: 'string' },
  { name: 'outcomes', type: 'string[]' },
  { name: 'questionStart', type: 'string' },
  { name: 'questionEnd', type: 'string' },
  { name: 'outcomeType', type: 'string' },
  { name: 'parentOutcome', type: 'uint256' },
  { name: 'parentMarket', type: 'address' },
  { name: 'category', type: 'string' },
  { name: 'lang', type: 'string' },
  { name: 'lowerBound', type: 'uint256' },
  { name: 'upperBound', type: 'uint256' },
  { name: 'minBond', type: 'uint256' },
  { name: 'openingTime', type: 'uint32' },
  { name: 'tokenNames', type: 'string[]' },
] as const

export const marketFactoryAbi = [
  {
    type: 'function',
    name: 'createCategoricalMarket',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: createMarketParamsComponents }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'marketCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'realitio',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'questionTimeout',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
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
    name: 'collateralToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'NewMarket',
    inputs: [
      { name: 'market', type: 'address', indexed: true },
      { name: 'marketName', type: 'string', indexed: false },
      { name: 'parentMarket', type: 'address', indexed: false },
      { name: 'conditionId', type: 'bytes32', indexed: false },
      { name: 'questionId', type: 'bytes32', indexed: false },
      { name: 'questionsIds', type: 'bytes32[]', indexed: false },
    ],
  },
] as const

export const routerAbi = [
  {
    type: 'function',
    name: 'splitPosition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'market', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mergePositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'market', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeemPositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'market', type: 'address' },
      { name: 'outcomeIndexes', type: 'uint256[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getWinningOutcomes',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool[]' }],
  },
] as const

/** GnosisRouter extras (xDAI <-> sDAI via SavingsXDaiAdapter). */
export const gnosisRouterAbi = [
  {
    type: 'function',
    name: 'splitFromBase',
    stateMutability: 'payable',
    inputs: [{ name: 'market', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mergeToBase',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'redeemToBase',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'market', type: 'address' },
      { name: 'outcomeIndexes', type: 'uint256[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const

export const marketAbi = [
  {
    type: 'function',
    name: 'marketName',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'conditionId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'questionId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'wrappedOutcome',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [
      { name: 'wrapped1155', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
  },
  {
    type: 'function',
    name: 'numOutcomes',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'outcomes',
    stateMutability: 'view',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'questionsIds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    type: 'function',
    name: 'templateId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'payoutReported',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/** Gnosis Conditional Tokens Framework (read helpers). */
export const conditionalTokensAbi = [
  {
    type: 'function',
    name: 'getOutcomeSlotCount',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payoutDenominator',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payoutNumerators',
    stateMutability: 'view',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
