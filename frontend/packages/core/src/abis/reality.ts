/**
 * Reality.eth v3.0 minimal fragments (research §5). Note: LogFinalize is emitted only when the arbitrator answers;
 * finalization by timeout emits nothing — derive it from getFinalizeTS/isFinalized.
 */
export const realityAbi = [
  {
    type: 'function',
    name: 'submitAnswer',
    stateMutability: 'payable',
    inputs: [
      { name: 'question_id', type: 'bytes32' },
      { name: 'answer', type: 'bytes32' },
      { name: 'max_previous', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getBestAnswer',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isFinalized',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'resultFor',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getBond',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getFinalizeTS',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'getOpeningTS',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'getTimeout',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'getMinBond',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isPendingArbitration',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isSettledTooSoon',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'resultForOnceSettled',
    stateMutability: 'view',
    inputs: [{ name: 'question_id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'LogNewQuestion',
    inputs: [
      { name: 'question_id', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'template_id', type: 'uint256', indexed: false },
      { name: 'question', type: 'string', indexed: false },
      { name: 'content_hash', type: 'bytes32', indexed: true },
      { name: 'arbitrator', type: 'address', indexed: false },
      { name: 'timeout', type: 'uint32', indexed: false },
      { name: 'opening_ts', type: 'uint32', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'created', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LogNewAnswer',
    inputs: [
      { name: 'answer', type: 'bytes32', indexed: false },
      { name: 'question_id', type: 'bytes32', indexed: true },
      { name: 'history_hash', type: 'bytes32', indexed: false },
      { name: 'user', type: 'address', indexed: true },
      { name: 'bond', type: 'uint256', indexed: false },
      { name: 'ts', type: 'uint256', indexed: false },
      { name: 'is_commitment', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LogNotifyOfArbitrationRequest',
    inputs: [
      { name: 'question_id', type: 'bytes32', indexed: true },
      { name: 'user', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'LogReopenQuestion',
    inputs: [
      { name: 'question_id', type: 'bytes32', indexed: true },
      { name: 'reopened_question_id', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'LogFinalize',
    inputs: [
      { name: 'question_id', type: 'bytes32', indexed: true },
      { name: 'answer', type: 'bytes32', indexed: true },
    ],
  },
] as const

/** Reality.eth answer encodings for a Yes/No categorical question (Seer adds "Invalid result" natively). */
export const REALITY_ANSWERS = {
  /** outcome index 0 */
  yes: '0x0000000000000000000000000000000000000000000000000000000000000000',
  /** outcome index 1 */
  no: '0x0000000000000000000000000000000000000000000000000000000000000001',
  /** Reality.eth invalid: 2^256 − 1 */
  invalid: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  /** Reality.eth "answered too soon": 2^256 − 2 */
  too_soon: '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe',
} as const

/** Unicode separator Reality.eth uses between question fields (U+241F). Never allowed inside fields. */
export const REALITY_SEPARATOR = '\u241f'
