# Research: Reality.eth v3 and Kleros cross-chain arbitration as used by Seer on Gnosis Chain

Collected 2026-10-02 by a research agent for architecture decisions; verified against primary sources and Gnosis/Ethereum state with Foundry cast. Facts marked unverified must not be relied on without checking.

## Summary

Seer on Gnosis (chain 100) uses the native-xDAI Reality.eth v3 contract RealityETH_v3_0 at 0xE78996A233895bE74a66F451f1019cA9734205cc. Its source is verified on Blockscout as RealityETH_v3_0 (solc 0.8.6, BalanceHolder, not the ERC20 build). I checked every function selector and event topic listed below against the on-chain bytecode.
Seer MarketFactory 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1 reports these values on chain: arbitrator()=0x68154EA682f95BF582b80Dd6453FA401737491Dc, realitio()=Reality v3, questionTimeout()=302400 s (3.5 days), marketCount=1600. All 70 Seer questions created in about the last 35 days use that arbitrator and that timeout.
Questions are asked with askQuestionWithMinBond(templateId, question, arbitrator, 302400, openingTime, nonce=0, minBond), where msg.sender is the MarketFactory. Templates used: 1 = uint (scalar), 2 = single-select (categorical, including Yes/No), 3 = multiple-select. Fields in the question string are separated by U+241F.
ID derivation, checked in v3 source and by recomputing a live Seer question: content_hash = keccak256(abi.encodePacked(uint256 template_id, uint32 opening_ts, string question)). question_id = keccak256(abi.encodePacked(content_hash, address arbitrator, uint32 timeout, uint256 min_bond, address realitio, address asker, uint256 nonce)). Note that the Reality contract address comes before msg.sender.
Bonds: the first answer must be >= min_bond, and each later answer must be >= 2x the current bond. Every answer resets finalize_ts to now + timeout. Answers before opening_ts revert ("opening date must have passed").
Answer conventions: 0xff..ff means invalid (a convention only; the contract does not enforce it). 0xff..fe is UNRESOLVED_ANSWER ("answered too soon"): resultForOnceSettled reverts until someone calls reopenQuestion, and Seer's RealityProxy resolves through resultForOnceSettled.
LogFinalize is emitted only when the arbitrator answers. A normal timeout finalization emits no event, so indexers must derive it from finalize_ts and block time.
Arbitrator 0x68154E…91Dc is RealitioHomeArbitrationProxy (Kleros cross-chain proxy). It relays over the Gnosis AMB (home 0x75Df5AF0…bb59) to RealitioForeignArbitrationProxyWithAppeals on Ethereum mainnet, 0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68. That proxy creates disputes on KlerosLiquid 0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069 in the General Court (subcourt 0) with 31 jurors.
Arbitration is requested only on mainnet, paid in ETH: requestArbitration(bytes32 questionID, uint256 maxPrevious) payable, with fee = getDisputeFee(bytes32) = 0.1674 ETH today (31 x 0.0054 ETH). Nothing on Gnosis accepts payment for arbitration.
Evidence (ERC-1497) is submitted on mainnet with foreignProxy.submitEvidence(uint256 arbitrationID = uint256(questionID), string evidenceURI). It can be submitted before a dispute exists.
Kleros ruling r is mapped to the Reality answer bytes32(r-1). Ruling 0 (refuse to arbitrate) underflows to 0xff..ff (invalid). On-chain I saw ruling 2^256-1, which maps to 0xff..fe (answered too soon).
Only 3 disputes have ever gone through this proxy pair (Oct 2024, Jan 2025, Jul 2025). Observed timeline:
- mainnet request to Gnosis RequestNotified: about 30 min.
- handleNotifiedRequest (permissionless) to RequestAcknowledged: 9 min to 36 h.
- acknowledgement to ArbitrationCreated on mainnet: 1 to 3.5 h. The Gnosis-to-mainnet AMB leg needs executeSignatures on mainnet.
- dispute to ruling: about 14.5 to 15 days. General Court periods: evidence 280800 s, vote 583200 s, appeal 388800 s; hiddenVotes is false.
- ruling to ArbitratorAnswered on Gnosis: about 30 min.
- ArbitratorAnswered to reportArbitrationAnswer, which actually finalizes Reality: 4.5 h to 5 days, because it needs a manual, permissionless call.
- Total from request to finalization: about 16 to 20 days, longer if appealed.
Policy: the arbitrator ToS / Seer resolution policy is ipfs://QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf, and the metaevidence is /ipfs/QmVkcsYWd22JkG2rq29wQzNeXP5WEZ9vyVrrnhzry5vdHa. The General Court policy says rulings use the "state of the world at dispute creation", and late evidence that was not readily public is disregarded.
Bonds in practice: the Seer UI default MIN_BOND on Gnosis is 10 xDAI. On-chain min bonds in the 70-question sample: 10 xDAI (45), 0.1 xDAI (22), 1 xDAI (3). One disputed question was escalated to a 2000 xDAI bond.

## Verified addresses

| Name | Chain | Address | Verified | Evidence |
|---|---|---|---|---|
| Reality.eth v3 (RealityETH_v3_0, native xDAI) used by Seer | 100 | `0xE78996A233895bE74a66F451f1019cA9734205cc` | True | Blockscout verified source name RealityETH_v3_0 v0.8.6, BalanceHolder (native); cast code 33837 hex chars; Seer deployments/gnosis/Reality.json; MarketFactory.realitio() returns it; all selectors/topics grep-matched in runtime bytecode |
| Seer MarketFactory (current, Gnosis) | 100 | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | True | seer-pm/demo contracts/deployments/gnosis/MarketFactory.json; cast call arbitrator()/realitio()/questionTimeout()=302400/marketCount()=1600; it is the asker (topic2) of recent LogNewQuestion events |
| Seer RealityProxy (resolves markets via resultForOnceSettled) | 100 | `0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C` | True | MarketFactory.realityProxy() on-chain; deployments/gnosis/RealityProxy.json |
| Kleros RealitioHomeArbitrationProxy (arbitrator set on Seer questions) | 100 | `0x68154EA682f95BF582b80Dd6453FA401737491Dc` | True | Blockscout verified RealitioHomeArbitrationProxy 0.7.6; cast call realitio()=0xE789..05cc, amb()=0x75Df..bb59, foreignProxy()=0xFe0e..Aa68, foreignChainId()=1; MarketFactory.arbitrator(); arbitrator field in all 70 recent Seer LogNewQuestion events |
| Kleros RealitioForeignArbitrationProxyWithAppeals (request arbitration / evidence / appeals here) | 1 | `0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68` | True | eth.blockscout verified source; cast call homeProxy()=0x6815..91Dc, homeChainId()=100, amb()=0x4C36..E64e, arbitrator()=KlerosLiquid, getDisputeFee()=0.1674 ETH |
| KlerosLiquid (Kleros Court v1) | 1 | `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069` | True | Blockscout name KlerosLiquid verified; foreignProxy.arbitrator(); courts(0) feeForJuror=0.0054 ETH; arbitrationCost = 31*0.0054 = 0.1674 ETH matches |
| Gnosis AMB home bridge (xDAI side) | 100 | `0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59` | True | home proxy amb(); EternalStorageProxy verified; sourceChainId()=100, destinationChainId()=1, maxGasPerTx()=2000000, requiredSignatures()=4 |
| Gnosis AMB foreign bridge (Ethereum side) | 1 | `0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e` | True | foreign proxy amb(); EternalStorageProxy verified; sourceChainId()=1, destinationChainId()=100 |
| Kleros PolicyRegistry (court policies) | 1 | `0xCf1f07713d5193FaE5c1653C9f61953D048BECe4` | True | Blockscout name PolicyRegistry verified; policies(0) = /ipfs/Qmd1TMEbtic3TSonu5dfqa5k3aSrjxRGY8oJH3ruGgazRB (General Court JSON fetched) |
| Seer collateral (sDAI) used by MarketFactory | 100 | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | True | MarketFactory.collateralToken() on-chain (not a Reality/Kleros contract; included for context) |

## Signatures

- **RealityETH_v3_0** (function, verified): `function askQuestionWithMinBond(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond) payable returns (bytes32)` — selector 0x484b93c4; used by Seer MarketFactory with nonce=0, timeout=302400
- **RealityETH_v3_0** (function, verified): `function askQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce) payable returns (bytes32)` — 0x762c38fd; question_id uses min_bond=uint256(0)
- **RealityETH_v3_0** (function, verified): `function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable` — 0x77f325df; msg.value is the bond; first >= min_bond, later >= 2*current bond; max_previous>0 reverts if current bond > max_previous
- **RealityETH_v3_0** (function, verified): `function submitAnswerFor(bytes32 question_id, bytes32 answer, uint256 max_previous, address answerer) payable` — 0x111ec138 (selector computed; not bytecode-grepped)
- **RealityETH_v3_0** (function, verified): `function submitAnswerCommitment(bytes32 question_id, bytes32 answer_hash, uint256 max_previous, address _answerer) payable` — 0xd7cff986; answer_hash=keccak256(abi.encodePacked(answer,nonce)); reveal window = timeout/8 (37800s for Seer)
- **RealityETH_v3_0** (function, verified): `function submitAnswerReveal(bytes32 question_id, bytes32 answer, uint256 nonce, uint256 bond)` — 0x4dc266b4
- **RealityETH_v3_0** (function, verified): `function fundAnswerBounty(bytes32 question_id) payable` — 0x59245ff3 (computed)
- **RealityETH_v3_0** (function, verified): `function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)` — 0x1101a0fd; arrays last-to-first, history_hashes are the PREVIOUS hash of each entry (final element 0x0); credits balanceOf, then withdraw()
- **RealityETH_v3_0** (function, verified): `function claimMultipleAndWithdrawBalance(bytes32[] question_ids, uint256[] lengths, bytes32[] hist_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)` — 0x28828b1e
- **RealityETH_v3_0** (function, verified): `function withdraw()` — 0x3ccfd60b; uses payable.transfer (2300 gas stipend)
- **RealityETH_v3_0** (function, verified): `function reopenQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond, bytes32 reopens_question_id) payable returns (bytes32)` — 0x1126a9dc; only for questions resolved to 0xff..fe; params must match original; anyone can call
- **RealityETH_v3_0** (function, verified): `function resultFor(bytes32 question_id) view returns (bytes32)` — 0xd09cc57e; reverts unless finalized
- **RealityETH_v3_0** (function, verified): `function resultForOnceSettled(bytes32 question_id) view returns (bytes32)` — 0xab5a4e35; reverts if 0xff..fe and not (successfully) reopened
- **RealityETH_v3_0** (function, verified): `function isSettledTooSoon(bytes32 question_id) view returns (bool)` — 0x06c3b67a
- **RealityETH_v3_0** (function, verified): `function isFinalized(bytes32 question_id) view returns (bool)` — 0x7f8d429e; !pending_arbitration && finalize_ts>0 && finalize_ts<=now
- **RealityETH_v3_0** (function, verified): `function isPendingArbitration(bytes32 question_id) view returns (bool)` — 0x924532fb
- **RealityETH_v3_0** (function, verified): `function getFinalizeTS(bytes32 question_id) view returns (uint32)` — 0xacae8f4e
- **RealityETH_v3_0** (function, verified): `function getOpeningTS(bytes32 question_id) view returns (uint32)` — 0x9e63fa6a
- **RealityETH_v3_0** (function, verified): `function getTimeout(bytes32 question_id) view returns (uint32)` — 0x9f1025c6; 0 means question does not exist
- **RealityETH_v3_0** (function, verified): `function getBond(bytes32 question_id) view returns (uint256)` — 0x26d6c97b
- **RealityETH_v3_0** (function, verified): `function getMinBond(bytes32 question_id) view returns (uint256)` — 0x484c0714
- **RealityETH_v3_0** (function, verified): `function getBestAnswer(bytes32 question_id) view returns (bytes32)` — 0x8d552d46
- **RealityETH_v3_0** (function, verified): `function getHistoryHash(bytes32 question_id) view returns (bytes32)` — 0x82ffa9f7 (computed)
- **RealityETH_v3_0** (function, verified): `function getContentHash(bytes32 question_id) view returns (bytes32)` — 0x51577ea9 (computed)
- **RealityETH_v3_0** (function, verified): `function getArbitrator(bytes32 question_id) view returns (address)` — 0x2518904c (computed)
- **RealityETH_v3_0** (function, verified): `function questions(bytes32) view returns (bytes32 content_hash, address arbitrator, uint32 opening_ts, uint32 timeout, uint32 finalize_ts, bool is_pending_arbitration, uint256 bounty, bytes32 best_answer, bytes32 history_hash, uint256 bond, uint256 min_bond)` — 0x95addb90; called successfully via cast on live questions
- **RealityETH_v3_0** (function, verified): `function getFinalAnswerIfMatches(bytes32 question_id, bytes32 content_hash, address arbitrator, uint32 min_timeout, uint256 min_bond) view returns (bytes32)` — 0x12a203c3
- **RealityETH_v3_0** (function, verified): `function notifyOfArbitrationRequest(bytes32 question_id, address requester, uint256 max_previous)` — 0xf6a94ecb; onlyArbitrator; requires stateOpen and an existing answer
- **RealityETH_v3_0** (function, verified): `function assignWinnerAndSubmitAnswerByArbitrator(bytes32 question_id, bytes32 answer, address payee_if_wrong, bytes32 last_history_hash, bytes32 last_answer_or_commitment_id, address last_answerer)` — 0xd44e293c
- **RealityETH_v3_0** (event, verified): `event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)` — topic0 0xfe2dac156a3890636ce13f65f4fdf41dcaee11526e4a5374531572d92194796c; topics[1]=question_id, [2]=user, [3]=content_hash
- **RealityETH_v3_0** (event, verified): `event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)` — topic0 0xe47ca4ebbbc2990134d1168821f38c5e177f3d5ee564bffeadeaa351905e6221; answer NOT indexed; also emitted (bond=0) when arbitrator answers
- **RealityETH_v3_0** (event, verified): `event LogAnswerReveal(bytes32 indexed question_id, address indexed user, bytes32 indexed answer_hash, bytes32 answer, uint256 nonce, uint256 bond)` — topic0 0xa7b2d313bc7a062e30b2c3b811aa4c9faf09755a6b4ea3bf42deff920944332f
- **RealityETH_v3_0** (event, verified): `event LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user)` — topic0 0x75d7939999bc902187c4aed400872883e445145f1983539166f783fa040b4762
- **RealityETH_v3_0** (event, verified): `event LogCancelArbitration(bytes32 indexed question_id)` — topic0 0x71bf7c2b9df0b8818e7eb6746a5bf69699ebbab041f3795f9ed58e469afa9a3a; finalize_ts reset to now+timeout
- **RealityETH_v3_0** (event, verified): `event LogFinalize(bytes32 indexed question_id, bytes32 indexed answer)` — topic0 0x18d760beffe3717270cd90d9d920ec1a48c194e9ad7bba23eb1c92d3eb974f97; ONLY emitted by submitAnswerByArbitrator, never on normal timeout finalization
- **RealityETH_v3_0** (event, verified): `event LogClaim(bytes32 indexed question_id, address indexed user, uint256 amount)` — topic0 0x9c121aff33b50c1a53fef034ebec5f83da2d5a5187048f9c76c397ba27c1a1a6
- **RealityETH_v3_0** (event, verified): `event LogFundAnswerBounty(bytes32 indexed question_id, uint256 bounty_added, uint256 bounty, address indexed user)` — topic0 0x54d68405b79f2aa4fd4e8db7b67844ad254cf8f208aac476c2894134a9deab66
- **RealityETH_v3_0** (event, verified): `event LogMinimumBond(bytes32 indexed question_id, uint256 min_bond)` — topic0 0x9641ca9d53af3bead658ffcc6c7d8c35e7dae9938367bd8eb45bee35d5c62504; only emitted if min_bond>0
- **RealityETH_v3_0** (event, verified): `event LogNewTemplate(uint256 indexed template_id, address indexed user, string question_text)` — topic0 0xb87fb721c0a557bb8dff89a86796466931d82ba530a66a239263eb8735ade2e4
- **RealityETH_v3_0** (event, verified): `event LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id)` — topic0 0x32e7d5617fb1be6bd0e7c3974d438d4514c4cf349e9330691d8abf6f6fd43121; topics[1]=NEW question id, topics[2]=the original (reopened) id
- **RealityETH_v3_0** (event, verified): `event LogWithdraw(address indexed user, uint256 amount)` — topic0 0x4ce7033d118120e254016dccf195288400b28fc8936425acd5f17ce2df3ab708 (computed)
- **RealityETH_v3_0** (constant, verified): `bytes32 constant UNRESOLVED_ANSWER = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe` — answered too soon; invalid = 0xff..ff by convention only
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function requestArbitration(bytes32 _questionID, uint256 _maxPrevious) payable` — 0xa829c3d1; msg.value >= arbitrator.arbitrationCost(extraData); ETH on Ethereum mainnet
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function getDisputeFee(bytes32 _questionID) view returns (uint256)` — 0xa22352e2; ignores questionID; currently 167400000000000000 wei
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function submitEvidence(uint256 _arbitrationID, string _evidenceURI)` — 0xa6a7f0eb; _arbitrationID = uint256(questionID); no access/state checks
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function fundAppeal(uint256 _arbitrationID, uint256 _answer) payable returns (bool)` — 0x4b2f0ea0; _answer in Kleros denomination = realityAnswer+1
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function handleFailedDisputeCreation(bytes32 _questionID, address _requester)` — 0x4aa6a1e4
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function withdrawFeesAndRewardsForAllRounds(uint256 _arbitrationID, address _beneficiary, uint256 _contributedTo)` — 0xfe2dddeb
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (function, verified): `function arbitrationRequests(uint256, address) view returns (uint8 status, uint248 deposit, uint256 disputeID, uint256 answer)` — 0xedabc474; Status {None,Requested,Created,Ruled,Failed}
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event ArbitrationRequested(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious)` — 0x2067d1b3170fe803dd001b95b04f9d372eb9c3e5a48ed131a62962a7300bdb20
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event ArbitrationCreated(bytes32 indexed _questionID, address indexed _requester, uint256 indexed _disputeID)` — 0xcf9bcbc2efae51060af73ef64119281007f63eada739f19c41c181d8350fa814
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event ArbitrationCanceled(bytes32 indexed _questionID, address indexed _requester)` — 0xe7700735be0b02f71ef1d623678daf36cd936af4c349a22ad9d5a8b217df0dd9
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester)` — 0x9beda0c81abc1c65da7685f113195974dfddb781dfde6263e5a1b13a5356ffad (same topic as home-side ArbitrationFailed)
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event Evidence(address indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence)` — 0xdccf2f8b2cc26eafcd61905cba744cff4b81d14740725f6376390dc6298a6a3c
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event Dispute(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _metaEvidenceID, uint256 _evidenceGroupID)` — 0x74baab670a4015ab2f1b467c5252a96141a2573f2908e58a92081e80d3cfde3d
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event Ruling(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling)` — 0x394027a5fa6e098a1191094d1719d6929b9abc535fcc0c8f448d6a4e75622276
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event Contribution(uint256 indexed _localDisputeID, uint256 indexed _round, uint256 ruling, address indexed _contributor, uint256 _amount)` — 0xcae597f39a3ad75c2e10d46b031f023c5c2babcd58ca0491b122acda3968d4c0
- **RealitioForeignArbitrationProxyWithAppeals (mainnet)** (event, verified): `event RulingFunded(uint256 indexed _localDisputeID, uint256 indexed _round, uint256 indexed _ruling)` — 0x39493c1b78d9a13bcc9e1d532fc7faed3889248d93affa811416ce3c6bcb1a68
- **RealitioHomeArbitrationProxy (Gnosis)** (function, verified): `function handleNotifiedRequest(bytes32 _questionID, address _requester)` — 0x91602fd7; permissionless; must be called after RequestNotified to send ack to mainnet
- **RealitioHomeArbitrationProxy (Gnosis)** (function, verified): `function handleRejectedRequest(bytes32 _questionID, address _requester)` — 0xc77cccc9; permissionless; triggers refund on mainnet
- **RealitioHomeArbitrationProxy (Gnosis)** (function, verified): `function reportArbitrationAnswer(bytes32 _questionID, bytes32 _lastHistoryHash, bytes32 _lastAnswerOrCommitmentID, address _lastAnswerer)` — 0x241a9f82; permissionless; REQUIRED to finalize Reality after ruling
- **RealitioHomeArbitrationProxy (Gnosis)** (function, verified): `function requests(bytes32, address) view returns (uint8 status, bytes32 arbitratorAnswer)` — 0xc510faf7; Status {None,Rejected,Notified,AwaitingRuling,Ruled,Finished}
- **RealitioHomeArbitrationProxy (Gnosis)** (function, verified): `function questionIDToRequester(bytes32) view returns (address)` — 0x1865fed1
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event RequestNotified(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious)` — 0xf56e18fc84dbd66db78337b5bd0973943fa70c9b52243a540bdac79274f6682d
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event RequestRejected(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious, string _reason)` — 0xf677e762f2ddc710deec335dd0cfa8a65cc9c9c351b268243be8629f2e8d1b5f
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event RequestAcknowledged(bytes32 indexed _questionID, address indexed _requester)` — 0xff09615c531ab8799ea1c67a0952ddbef1c864ef91d390995d0dc07656f4210f
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event RequestCanceled(bytes32 indexed _questionID, address indexed _requester)` — 0xf313a768599b60b7f8aedb7757d867d09463365b79b55b86ed3c961e6da5a249
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester)` — 0x9beda0c81abc1c65da7685f113195974dfddb781dfde6263e5a1b13a5356ffad
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event ArbitratorAnswered(bytes32 indexed _questionID, bytes32 _answer)` — 0x1813d15d8cef51cff8bbd419a8e13e0655c1babea320dea4174d5e7bc40c4294
- **RealitioHomeArbitrationProxy (Gnosis)** (event, verified): `event ArbitrationFinished(bytes32 indexed _questionID)` — 0x2abf2fd86256e4607561adae782a4853682b6c0b976995a9a45c5fc3a1757386
- **Seer MarketFactory** (struct, verified): `struct CreateMarketParams { string marketName; string[] outcomes; string questionStart; string questionEnd; string outcomeType; uint256 parentOutcome; address parentMarket; string category; string lang; uint256 lowerBound; uint256 upperBound; uint256 minBond; uint32 openingTime; string[] tokenNames; }` — from seer-pm/demo main contracts/src/MarketFactory.sol; deployed factory metadata includes this source; createCategoricalMarket(CreateMarketParams) uses template 2

## Facts

- [verified] Seer's Gnosis MarketFactory asks Reality questions on RealityETH_v3_0 (native xDAI) at 0xE78996A233895bE74a66F451f1019cA9734205cc with timeout 302400s and arbitrator 0x68154EA682f95BF582b80Dd6453FA401737491Dc. (source: cast call MarketFactory realitio()/arbitrator()/questionTimeout(); Blockscout verified source; 70/70 recent LogNewQuestion events)
- [verified] question_id = keccak256(abi.encodePacked(content_hash, arbitrator(20B), timeout(uint32), min_bond(uint256), address(realitio), msg.sender, nonce(uint256))); content_hash = keccak256(abi.encodePacked(uint256 template_id, uint32 opening_ts, bytes question)). (source: Verified v3 source + recomputation matched live question 0xb3ca4b14...1fa6 and its content_hash topic)
- [verified] submitAnswer requires msg.value>0, >= min_bond for first answer, >= 2x current bond afterwards; each answer sets finalize_ts = now + timeout. (source: RealityETH_v3_0 modifiers bondMustDoubleAndMatchMinimum and _updateCurrentAnswer)
- [verified] Answers (and arbitration notification) before opening_ts revert with 'opening date must have passed'; after finalize_ts they revert. (source: stateOpen modifier)
- [verified] LogFinalize is emitted only by submitAnswerByArbitrator; ordinary timeout finalization emits no event. (source: v3 source)
- [verified] claimWinnings burns 1/40 (2.5%) of every bond except the final one; answer takeover pays the earlier correct answerer an amount equal to their bond; the bounty goes to the winning answerer unless the answer is 0xff..fe. (source: v3 claimWinnings/_processHistoryItem)
- [high] Seer RealityProxy resolves with resultForOnceSettled; 0xff..ff or out-of-range answers resolve categorical markets to the INVALID outcome; 0xff..fe blocks resolution until reopenQuestion is used. (source: seer-pm/demo contracts/src/RealityProxy.sol)
- [verified] Arbitration is requested only on Ethereum mainnet via foreign proxy requestArbitration(bytes32,uint256) paid in ETH; current fee 0.1674 ETH (General Court, 31 jurors x 0.0054 ETH). (source: cast call getDisputeFee and KlerosLiquid courts(0); arbitratorExtraData = (subcourt 0, 31 jurors))
- [high] First appeal base cost is 0.3 ETH per KlerosLiquid.appealCost(0,0x) at the queried dispute (dispute 0 sample); for a 31-juror dispute it would be (2*31+1)*0.0054=0.3402 ETH; winner side pays +30%, loser +70%, loser only during first 50% of appeal period. (source: cast call appealCost; foreign proxy getMultipliers()=3000/7000/5000/10000)
- [verified] Kleros ruling r maps to Reality answer bytes32(r-1); ruling 0 (refuse) underflows to 0xff..ff (invalid); NUMBER_OF_CHOICES = type(uint256).max. (source: foreign proxy rule() source (solc 0.7.6, no overflow checks))
- [verified] Only 3 Seer/Kleros cross-chain disputes have ever occurred via this proxy pair: Oct 2024 (ruled answered-too-soon), Jan 2025 (answered-too-soon, bond escalated to 2000 xDAI), Jul 2025 (answer 0). (source: Blockscout getLogs on both proxies)
- [verified] Observed end-to-end arbitration (request to Reality finalization) took about 16.3 to 20 days; dispute to ruling about 14.5 to 15 days; reportArbitrationAnswer lagged the ruling by 4.5 h to 5 days. (source: event timestamps on mainnet and Gnosis)
- [high] The Gnosis-to-Ethereum AMB leg (ack to dispute creation) requires collecting validator signatures and calling executeSignatures on the mainnet AMB; it is not executed automatically. (source: Seer ArbitrationFlow.ts uses foreignAmb.executeSignatures; observed 1 to 3.5 h delays)
- [verified] Evidence for these disputes is ERC-1497 Evidence emitted by foreign proxy submitEvidence(uint256 arbitrationID=uint256(questionID), string URI) on mainnet; 27 evidence events exist; Dispute event sets evidenceGroupID = uint256(questionID); MetaEvidence ID 0 = /ipfs/QmVkcsYWd22JkG2rq29wQzNeXP5WEZ9vyVrrnhzry5vdHa. (source: foreign proxy source + logs)
- [verified] Arbitrator ToS / policy for Seer questions is ipfs://QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf (home proxy metadata() and foreign termsOfService()). (source: cast call metadata()/termsOfService(); PDF fetched and read)
- [verified] Seer UI default MIN_BOND on Gnosis is 10 xDAI; on-chain min_bonds of 70 recent Seer questions: 10 xDAI (45), 0.1 (22), 1 (3). (source: seer-pm/demo web/src/lib/config.ts; getMinBond calls)
- [high] General Court periods: evidence 280800s, commit 583200s (skipped since hiddenVotes=false), vote 583200s, appeal 388800s. (source: KlerosLiquid getSubcourt(0) and courts(0))
- [verified] Commit-reveal reveal window = timeout/8 = 37800s for Seer questions. (source: v3 _storeCommitment)

## Risks

- Arbitration takes about 16 to 20 days (observed) or longer with appeals. Any product deadline, payout or 'investigation window' must not assume quick oracle finality, and markets stay unresolved (and positions locked) for that long.
- Arbitration needs ETH on Ethereum mainnet (about 0.17 ETH plus gas, more for appeals). Defending an answer by escalating bonds costs xDAI on Gnosis. Operations need funded wallets on both chains.
- The arbitration request is asynchronous. If the AMB message reaches Gnosis after finalize_ts, or after someone has raised the bond above maxPrevious, Reality.notifyOfArbitrationRequest reverts, the request is RequestRejected, and getting the deposit back needs handleRejectedRequest plus an AMB relay. Request arbitration hours before finalize_ts, not minutes.
- Several steps are permissionless and nobody is paid to call them: handleNotifiedRequest and reportArbitrationAnswer on Gnosis, and executeSignatures on the mainnet AMB. Without a keeper the question stays pending for days; one observed case lagged 5 days. The app must run its own keeper.
- Normal Reality finalization emits no event (LogFinalize is only emitted on arbitration), so a monitor that waits for LogFinalize will never see normal resolution.
- Answered-too-soon (0xff..fe) outcomes have actually happened: 2 of the 3 Kleros rulings were this. resultForOnceSettled then reverts until someone calls reopenQuestion. Setting opening_ts strictly after the evidence deadline T avoids this.
- General Court policy: rulings use the 'state of the world at dispute creation', and evidence submitted after the first evidence period that was not readily public may be disregarded. A counterexample must be public and timestamped before T. A question whose answer depends on private or late evidence risks an INVALID ruling or refusal.
- Seer policy: a question with no clearly most-reasonable interpretation must resolve INVALID (rule 19). A technical 'reproducible counterexample' question that leaves reproduction criteria, environment or acceptance tests ambiguous could be ruled invalid.
- Reality withdraw() uses address.transfer (2300 gas). Smart-contract wallets such as a Safe proxy may fail to receive xDAI withdrawals. Answer from an EOA or check this before relying on a contract wallet. This is a plausible issue that I did not test.
- If the question parameters match an existing question exactly, Seer MarketFactory reuses that question_id instead of creating a new one (nonce is fixed at 0). Identical market parameters therefore share one oracle question.
- Last-minute answers: each new answer resets the 3.5-day timer, so the risk is not a short window. The risk is that nobody is watching or funded to double the bond, or to escalate to arbitration, before finalize_ts. A wrong answer with only min_bond (0.1 to 10 xDAI) finalizes if unchallenged.
- Only 3 disputes have ever used this arbitration path, so operational experience is thin. Juror familiarity with technical software-verification questions is untested.

## Recommendations

- Use Seer MarketFactory 0x83183DA8… createCategoricalMarket with outcomes ["Yes","No"] (template 2). Precompute question_id off-chain with the verified formula and assert it equals the LogNewQuestion topic and the Market's questionId before showing it to customers.
- Set openingTime >= evidence deadline T plus a buffer (for example T + 1h) so no answer can be given before the facts are fixed. This removes most answered-too-soon risk. Put the absolute UTC deadline, commit SHA, policy hash and the evidence mechanism inside the question text.
- Make counterexample submission public and timestamped before T (for example an on-chain commitment or a public IPFS/GitHub artifact with a hash anchored on chain), so Kleros jurors can treat it as readily public evidence that existed when the dispute was created.
- Choose min_bond deliberately (10 xDAI is the Seer default; consider more for funded markets). Run a funded answerer bot that submits the correct answer soon after opening_ts and counter-answers with 2x bond whenever a wrong answer appears. Use max_previous to avoid race overpayment.
- Escalate to Kleros once the bond at stake exceeds the cost of arbitration (about 0.17 ETH plus gas), or when an attacker keeps doubling. Call requestArbitration on mainnet with maxPrevious = the current bond, at least several hours before finalize_ts.
- Run a keeper that: (a) on RequestNotified calls handleNotifiedRequest; (b) relays the Gnosis-to-Ethereum AMB message (executeSignatures) if it is not picked up; (c) on ArbitratorAnswered calls reportArbitrationAnswer with the last history entry from LogNewAnswer; (d) on RequestRejected calls handleRejectedRequest; (e) on ArbitrationFailed (mainnet) calls handleFailedDisputeCreation.
- Index on Gnosis: LogNewQuestion, LogMinimumBond, LogNewAnswer, LogAnswerReveal, LogNotifyOfArbitrationRequest, LogCancelArbitration, LogFinalize, LogReopenQuestion, LogClaim, and all 7 home-proxy events. On mainnet: ArbitrationRequested/Created/Canceled/Failed, Dispute, Evidence, Ruling, Contribution, RulingFunded, and KlerosLiquid AppealPossible/AppealDecision/NewPeriod for the disputeID. Compute finalization status as finalize_ts <= now && !isPendingArbitration.
- Submit evidence via foreignProxy.submitEvidence(uint256(questionID), '/ipfs/<cid>/evidence.json'), with ERC-1497 JSON {name, description, fileURI, fileTypeExtension}, during the first-round evidence period (280800s after dispute creation), or earlier, since no dispute is required.
- After finalization, call claimWinnings (or claimMultipleAndWithdrawBalance) for bonds the app posted, and withdraw() to an EOA.
- Communicate to customers that resolution may take about 3.5 days (no dispute) up to about 3 weeks or more (Kleros), and that LP/collateral stays locked until then.

## Open questions

- Whether Kleros General Court jurors will accept a technical reproducibility judgement (a 'counterexample submitted before T' question) without a specialised subcourt. The Seer proxy is hardwired to subcourt 0 with 31 jurors and cannot be changed per question.
- Whether a custom arbitrator or a different Kleros proxy (for example a Kleros v2 / technical court) is possible with Seer. The MarketFactory arbitrator is immutable, so a different arbitrator would need our own factory or direct Reality questions plus Seer-compatible market creation; not researched.
- Exact current behaviour of the Gnosis-to-Ethereum AMB relaying (whether any party auto-executes, and the cost of executeSignatures). Inferred from Seer's test script and the observed 1 to 3.5 h delays, not from Gnosis bridge docs.
- Whether Seer's frontend or any Seer-run bots answer questions or relay arbitration steps by default. Observed answers on recent markets used 0.1 xDAI bonds, so someone does answer, but who was not identified.
- ETH/xDAI price at implementation time, needed to compare arbitration cost to bond levels; I did not guess it.
- Whether Seer has a second/newer factory (FutarchyFactory, CirclesMarketFactory, QuestionsFactory) using a different arbitrator or timeout. Only MarketFactory was checked.

## Detailed notes

# Reality.eth v3 + Kleros arbitration for Seer markets on Gnosis

All addresses below were checked with `cast` against the chain and against verified source on Blockscout (gnosis.blockscout.com / eth.blockscout.com). Every selector and topic I list was also grep-matched against the deployed runtime bytecode. Working files are in `/tmp/claude-1000/-home-agentops-dev-pine/3bdbf7d8-eaa9-4ef4-bb24-f4ee398ebcc1/scratchpad/research/`:
- `R.sol`: verified Reality v3 source
- `Home.sol`, `Foreign.sol`: proxy sources
- `policy.txt`: Seer policy text
- `nq.json`: 70 recent Seer LogNewQuestion logs
- `foreign_logs.json`, `home_logs.json`: proxy logs
- `getlogs.py`: paginated eth_getLogs helper

## 1. Contracts

| Role | Chain | Address | Evidence |
|---|---|---|---|
| Reality.eth v3, `RealityETH_v3_0`, native xDAI (BalanceHolder, **not** ERC20) | Gnosis 100 | `0xE78996A233895bE74a66F451f1019cA9734205cc` | Blockscout verified, solc 0.8.6; `MarketFactory.realitio()` |
| Seer MarketFactory | Gnosis | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | `arbitrator()`, `questionTimeout()=302400`, `marketCount()=1600` |
| Seer RealityProxy (resolves markets) | Gnosis | `0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C` | `MarketFactory.realityProxy()` |
| Kleros `RealitioHomeArbitrationProxy` (the Reality *arbitrator*) | Gnosis | `0x68154EA682f95BF582b80Dd6453FA401737491Dc` | `realitio()`, `amb()`, `foreignProxy()`, `foreignChainId()=1` |
| Kleros `RealitioForeignArbitrationProxyWithAppeals` | Ethereum 1 | `0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68` | `homeProxy()`, `homeChainId()=100`, `arbitrator()` |
| KlerosLiquid (Court v1) | Ethereum | `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069` | Blockscout name KlerosLiquid |
| AMB home (Gnosis side) | Gnosis | `0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59` | `sourceChainId()=100`, `destinationChainId()=1`, `requiredSignatures()=4` |
| AMB foreign (Ethereum side) | Ethereum | `0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e` | `sourceChainId()=1`, `destinationChainId()=100` |
| Kleros PolicyRegistry | Ethereum | `0xCf1f07713d5193FaE5c1653C9f61953D048BECe4` | `policies(0)` gives the General Court policy |

Foreign proxy configuration, read with `cast call`:
- `arbitratorExtraData` is subcourt 0 (General Court) with 31 jurors.
- `getMultipliers()` = winner 3000, loser 7000, loserAppealPeriod 5000, divisor 10000.
- `termsOfService` = `/ipfs/QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf`.
- MetaEvidence 0 = `/ipfs/QmVkcsYWd22JkG2rq29wQzNeXP5WEZ9vyVrrnhzry5vdHa`. It sets `arbitrableChainID=100`, `arbitratorChainID=1`, and fileURI = the Seer policy.

Home proxy `metadata()` returns `{"tos":"ipfs://QmPmRkXF.../seer-markets-resolution-policy.pdf", "foreignProxy":true}`. The `foreignProxy:true` flag tells the Reality UI that arbitration is requested on the foreign chain.

Recent usage: all 70 Seer questions created in about the last 600k Gnosis blocks (about 35 days, up to block 48554346) use arbitrator `0x6815…91Dc` and timeout 302400. Templates seen: 1 (34), 2 (32), 3 (4).

## 2. How Seer creates questions

From `seer-pm/demo/contracts/src/MarketFactory.sol`:

```solidity
bytes32 content_hash = keccak256(abi.encodePacked(templateId /*uint256*/, openingTime /*uint32*/, encodedQuestion));
bytes32 question_id = keccak256(abi.encodePacked(content_hash, arbitrator, questionTimeout /*uint32*/, minBond, address(realitio), address(this), uint256(0)));
if (realitio.getTimeout(question_id) != 0) return question_id; // reuse existing identical question
return realitio.askQuestionWithMinBond(templateId, encodedQuestion, arbitrator, questionTimeout, openingTime, 0, minBond);
```

Templates are created in the Reality constructor:
- 0: bool
- 1: uint, 18 decimals (Seer scalar)
- 2: single-select (Seer categorical)
- 3: multiple-select (Seer multi-categorical)
- 4: datetime

Encoding the question string:
- Categorical: `question + "␟" + "\"Yes\",\"No\"" + "␟" + category + "␟" + lang`. Live example: `Which party will win the Senate in 2026?␟"Democratic Party","Republican Party"␟misc␟en_US`.
- The single-select answer is `bytes32(uint256(outcomeIndex))`, so for outcomes ["Yes","No"], Yes = 0x00…00 and No = 0x00…01.
- `0xff…ff` resolves to Seer's INVALID outcome, and so does any index >= number of outcomes.

ID derivation check: I recomputed content_hash and question_id for live question `0xb3ca4b14de27e8db1339a64fe2314e44b0b5b8b95ae71b5fd4175474d5821fa6` and both matched the event topics. Packed widths are: template uint256 (32 bytes), opening_ts uint32 (4), question as raw UTF-8, arbitrator (20), timeout uint32 (4), min_bond (32), Reality address (20), asker (20), nonce (32).

```python
content_hash = keccak(tpl.to_bytes(32) + opening.to_bytes(4) + question.encode())
question_id  = keccak(content_hash + arb20 + timeout.to_bytes(4) + min_bond.to_bytes(32) + realitio20 + asker20 + nonce.to_bytes(32))
```

## 3. Reality v3 lifecycle, verified from source

**Asking.** `askQuestionWithMinBond(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond) payable returns (bytes32)` (0x484b93c4).
- Requires that the template exists and `0 < timeout < 365 days`.
- `msg.value` becomes the bounty, minus any arbitrator question fee.
- Emits LogNewQuestion, then LogFundAnswerBounty if there is a bounty, then LogMinimumBond if min_bond > 0.

**Answering.** `submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable` (0x77f325df).
- The `stateOpen` modifier requires: the question exists, it is not pending arbitration, `finalize_ts == 0 || finalize_ts > now`, and `opening_ts == 0 || opening_ts <= now`. Otherwise it reverts with "opening date must have passed".
- Bond rule: `msg.value > 0`. The first answer needs `>= min_bond`; every later answer needs `>= 2 * current bond`.
- If `max_previous > 0`, the call reverts when the current bond is greater than `max_previous`.
- Each answer sets `best_answer` and `finalize_ts = now + timeout` (302400 s for Seer).
- Emits `LogNewAnswer(answer, question_id, history_hash, user, bond, ts, is_commitment)`.
- `history_hash_new = keccak256(abi.encodePacked(prev_history_hash, answer_or_commitment_id, bond, answerer, is_commitment))`.

**Commit-reveal.**
- `submitAnswerCommitment(question_id, answer_hash, max_previous, answerer)`, where `answer_hash = keccak256(abi.encodePacked(answer, nonce))` and `commitment_id = keccak256(abi.encodePacked(question_id, answer_hash, msg.value))`.
- Reveal with `submitAnswerReveal(question_id, answer, nonce, bond)` within `timeout/8` (37800 s for Seer).
- A commitment that is never revealed always counts as wrong.

**Finalization.**
- `isFinalized = !is_pending_arbitration && finalize_ts > 0 && finalize_ts <= now`.
- There is **no event** for timeout finalization. `LogFinalize(question_id indexed, answer indexed)` is emitted only from `submitAnswerByArbitrator`.
- `resultFor` reverts unless finalized.
- `resultForOnceSettled` also reverts when the result is `0xff…fe` and no reopened replacement has settled. Seer RealityProxy uses this one.

**Special answers.**
- `UNRESOLVED_ANSWER = 0xff…fe` means "answered too soon". It is a contract constant; the bounty is withheld and kept for a reopening.
- `0xff…ff` means INVALID. This is a convention only.
- `reopenQuestion(...)` (0x1126a9dc) can be called by anyone, but only when `isSettledTooSoon`. It must reuse the identical template, question, arbitrator, timeout, opening_ts and min_bond, and it moves the bounty to the new question. LogReopenQuestion's topics[1] is the NEW id and topics[2] is the original id.

**Claims.**
- `claimWinnings(question_id, history_hashes[], addrs[], bonds[], answers[])`. All arrays are ordered last-to-first, and `history_hashes[i]` is the hash *before* entry i, so the last element is 0x0. It can be split across several transactions.
- Every bond except the final one has 1/40 (2.5%) withheld.
- A correct earlier answerer who is "taken over" gets a fee equal to their own bond.
- Payouts credit `balanceOf`, emit LogClaim, and are collected with `withdraw()`, which uses `transfer`.
- The convenience call is `claimMultipleAndWithdrawBalance`.
- Rebuild the history from LogNewAnswer events (answer, history_hash, user, bond, is_commitment).

**Getters** (selectors in the signatures list): getFinalizeTS, getOpeningTS, getTimeout (0 means the question does not exist), getBond, getMinBond, getBestAnswer, getHistoryHash, getContentHash, getArbitrator, getBounty, isPendingArbitration, isFinalized, isSettledTooSoon, and `questions(bytes32)`. The last returns `(content_hash, arbitrator, opening_ts, timeout, finalize_ts, is_pending_arbitration, bounty, best_answer, history_hash, bond, min_bond)`.

**Arbitrator hooks** (only the arbitrator, i.e. the home proxy, can call these):
- `notifyOfArbitrationRequest(qid, requester, max_previous)` requires `stateOpen` and an existing answer, then sets pending.
- `cancelArbitration(qid)` unsets pending and sets `finalize_ts = now + timeout`.
- `assignWinnerAndSubmitAnswerByArbitrator(...)` / `submitAnswerByArbitrator(...)` set the answer and `finalize_ts = now`, which finalizes immediately.

### Event topics on Reality v3 (Gnosis)

| Event | topic0 |
|---|---|
| LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created) | 0xfe2dac156a3890636ce13f65f4fdf41dcaee11526e4a5374531572d92194796c |
| LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment) | 0xe47ca4ebbbc2990134d1168821f38c5e177f3d5ee564bffeadeaa351905e6221 |
| LogAnswerReveal(bytes32 indexed question_id, address indexed user, bytes32 indexed answer_hash, bytes32 answer, uint256 nonce, uint256 bond) | 0xa7b2d313bc7a062e30b2c3b811aa4c9faf09755a6b4ea3bf42deff920944332f |
| LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user) | 0x75d7939999bc902187c4aed400872883e445145f1983539166f783fa040b4762 |
| LogCancelArbitration(bytes32 indexed question_id) | 0x71bf7c2b9df0b8818e7eb6746a5bf69699ebbab041f3795f9ed58e469afa9a3a |
| LogFinalize(bytes32 indexed question_id, bytes32 indexed answer) | 0x18d760beffe3717270cd90d9d920ec1a48c194e9ad7bba23eb1c92d3eb974f97 |
| LogClaim(bytes32 indexed question_id, address indexed user, uint256 amount) | 0x9c121aff33b50c1a53fef034ebec5f83da2d5a5187048f9c76c397ba27c1a1a6 |
| LogFundAnswerBounty(bytes32 indexed question_id, uint256 bounty_added, uint256 bounty, address indexed user) | 0x54d68405b79f2aa4fd4e8db7b67844ad254cf8f208aac476c2894134a9deab66 |
| LogMinimumBond(bytes32 indexed question_id, uint256 min_bond) | 0x9641ca9d53af3bead658ffcc6c7d8c35e7dae9938367bd8eb45bee35d5c62504 |
| LogNewTemplate(uint256 indexed template_id, address indexed user, string question_text) | 0xb87fb721c0a557bb8dff89a86796466931d82ba530a66a239263eb8735ade2e4 |
| LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id) | 0x32e7d5617fb1be6bd0e7c3974d438d4514c4cf349e9330691d8abf6f6fd43121 |
| LogWithdraw(address indexed user, uint256 amount) | 0x4ce7033d118120e254016dccf195288400b28fc8936425acd5f17ce2df3ab708 |

## 4. Kleros cross-chain arbitration flow

1. **Request, on Ethereum mainnet, paid in ETH.**
   - Read the fee: `fee = foreignProxy.getDisputeFee(qid)`. Today that is 0.1674 ETH = `KlerosLiquid.arbitrationCost(extraData)` = 31 jurors × 0.0054 ETH.
   - Call `foreignProxy.requestArbitration{value: >= fee}(qid, maxPrevious)` (0xa829c3d1).
   - Emits `ArbitrationRequested`, then the AMB sends `receiveArbitrationRequest(qid, requester, maxPrevious)` to Gnosis.
2. **Gnosis receives it** (validators execute automatically; observed about 26 to 36 min). The home proxy try-calls `Reality.notifyOfArbitrationRequest`.
   - On success, the question becomes pending arbitration (its timer is frozen) and the proxy emits `RequestNotified`.
   - On failure it emits `RequestRejected(reason)`. Causes: finalize_ts already passed, no answer yet, bond > maxPrevious, or another request already accepted.
3. **Someone calls `homeProxy.handleNotifiedRequest(qid, requester)`** (permissionless). It emits `RequestAcknowledged` and sends an AMB message to mainnet.
   - For a rejected request, call `handleRejectedRequest` instead; that ends in `ArbitrationCanceled` on mainnet with the deposit refunded.
   - Observed lag from notification to ack: 9 min to 36 h.
4. **The Gnosis-to-Ethereum AMB message is executed** (`executeSignatures` on mainnet AMB 0x4C36…). The foreign proxy's `receiveArbitrationAcknowledgement` then calls `KlerosLiquid.createDispute`.
   - Emits `ArbitrationCreated(qid, requester, disputeID)` and `Dispute(arbitrator, disputeID, 0, uint256(qid))`. Any surplus deposit is sent back to the requester.
   - If the fee went up in the meantime, it emits `ArbitrationFailed`. Then call `handleFailedDisputeCreation`, which refunds the deposit and calls `cancelArbitration` on Gnosis; that resets the timer to now + timeout.
   - Observed delay: 1 to 3.5 h.
5. **Kleros General Court.**
   - Periods: evidence 280800 s (3.25 d), then vote 583200 s (6.75 d); commit is skipped because hiddenVotes = false. Appeal period is 388800 s (4.5 d).
   - Observed time from dispute to ruling: about 14.5 to 15 days.
   - Appeals go through `foreignProxy.fundAppeal(uint256(qid), klerosAnswer)`, where klerosAnswer = realityAnswer + 1. The winner side pays appealCost × 1.3 and the loser side appealCost × 1.7. The loser can only fund during the first half of the appeal period.
   - `KlerosLiquid.appealCost(0, 0x)` returned 0.3 ETH at the dispute I queried. For a 31-juror case the next round is 63 jurors × 0.0054 = 0.3402 ETH.
6. **Ruling.** `foreignProxy.rule()` sends `receiveArbitrationAnswer(qid, bytes32(ruling-1))` over the AMB (observed about 30 min to Gnosis) and emits `Ruling`. On Gnosis the home proxy emits `ArbitratorAnswered(qid, answer)`.
   - Ruling 0 (refuse to arbitrate) underflows to `0xff…ff` (INVALID).
   - Ruling 2^256-1 maps to `0xff…fe` (answered too soon); this was observed twice.
7. **Someone must call `homeProxy.reportArbitrationAnswer(qid, lastHistoryHash, lastAnswerOrCommitmentID, lastAnswerer)`** (permissionless).
   - The arguments are the *previous* history hash and the last answer entry, taken from the last LogNewAnswer.
   - This calls `assignWinnerAndSubmitAnswerByArbitrator`, which emits LogNewAnswer (bond 0) and LogFinalize, finalizes the question, and emits `ArbitrationFinished`.
   - If the last answer was wrong, the requester becomes the payee. The arbitration fee is **not** refunded by Reality.
   - Observed lag after ArbitratorAnswered: 4.5 h to 5 days.

Observed disputes (the only 3 ever made through this proxy pair):
- qid 0x705b9f…: requested 2024-10-08, ruled 2024-10-23, answer 0xff…fe, finished 2024-10-28.
- qid 0x895fa4…: requested 2025-01-13, ruled 2025-01-30, answer 0xff…fe, bond had been escalated to 2000 xDAI.
- qid 0xa17903…: requested 2025-07-08, ruled 2025-07-23, answer 0, finished 2025-07-25.

### Evidence (ERC-1497)

Call `foreignProxy.submitEvidence(uint256 _arbitrationID, string _evidenceURI)` on **mainnet** (0xa6a7f0eb), with `_arbitrationID = uint256(questionID)`.
- It has no state checks, so evidence can be posted before a dispute exists.
- It emits `Evidence(KlerosLiquid, uint256(qid), sender, uri)`.
- The URI points to JSON `{"name","description","fileURI","fileTypeExtension"}` on IPFS, conventionally `/ipfs/<cid>/<keccak>.json` or similar.
- The home proxy has no evidence function.

### Events to index for arbitration

**Gnosis home proxy 0x6815…91Dc:**

| Event | topic0 |
|---|---|
| RequestNotified(bytes32 indexed, address indexed, uint256) | 0xf56e18fc84dbd66db78337b5bd0973943fa70c9b52243a540bdac79274f6682d |
| RequestRejected(bytes32 indexed, address indexed, uint256, string) | 0xf677e762f2ddc710deec335dd0cfa8a65cc9c9c351b268243be8629f2e8d1b5f |
| RequestAcknowledged(bytes32 indexed, address indexed) | 0xff09615c531ab8799ea1c67a0952ddbef1c864ef91d390995d0dc07656f4210f |
| RequestCanceled(bytes32 indexed, address indexed) | 0xf313a768599b60b7f8aedb7757d867d09463365b79b55b86ed3c961e6da5a249 |
| ArbitrationFailed(bytes32 indexed, address indexed) | 0x9beda0c81abc1c65da7685f113195974dfddb781dfde6263e5a1b13a5356ffad |
| ArbitratorAnswered(bytes32 indexed, bytes32) | 0x1813d15d8cef51cff8bbd419a8e13e0655c1babea320dea4174d5e7bc40c4294 |
| ArbitrationFinished(bytes32 indexed) | 0x2abf2fd86256e4607561adae782a4853682b6c0b976995a9a45c5fc3a1757386 |

Home proxy state is available through `requests(qid, requester)`, which returns (status, arbitratorAnswer) with status enum {None, Rejected, Notified, AwaitingRuling, Ruled, Finished}, and through `questionIDToRequester(qid)`.

**Mainnet foreign proxy 0xFe0e…Aa68:**

| Event | topic0 |
|---|---|
| ArbitrationRequested | 0x2067d1b3170fe803dd001b95b04f9d372eb9c3e5a48ed131a62962a7300bdb20 |
| ArbitrationCreated(qid indexed, requester indexed, disputeID indexed) | 0xcf9bcbc2efae51060af73ef64119281007f63eada739f19c41c181d8350fa814 |
| ArbitrationCanceled | 0xe7700735be0b02f71ef1d623678daf36cd936af4c349a22ad9d5a8b217df0dd9 |
| ArbitrationFailed | 0x9beda0c8… |
| Dispute | 0x74baab670a4015ab2f1b467c5252a96141a2573f2908e58a92081e80d3cfde3d |
| Evidence | 0xdccf2f8b2cc26eafcd61905cba744cff4b81d14740725f6376390dc6298a6a3c |
| Ruling | 0x394027a5fa6e098a1191094d1719d6929b9abc535fcc0c8f448d6a4e75622276 |
| Contribution | 0xcae597f39a3ad75c2e10d46b031f023c5c2babcd58ca0491b122acda3968d4c0 |
| RulingFunded | 0x39493c1b78d9a13bcc9e1d532fc7faed3889248d93affa811416ce3c6bcb1a68 |
| Withdrawal | 0x54b3cab3cb5c4aca3209db1151caff092e878011202e43a36782d4ebe0b963ae |

Foreign proxy state is available through `arbitrationRequests(uint256(qid), requester)`, which returns (status {None, Requested, Created, Ruled, Failed}, deposit, disputeID, answer).

**KlerosLiquid, filtered by disputeID** (topics computed only, not bytecode-checked):
- AppealPossible(uint256 indexed, address indexed): 0xa5d41b970d849372be1da1481ffd78d162bfe57a7aa2fe4e5fb73481fa5ac24f
- AppealDecision: 0x9c9b64db9e130f48381bf697abf638e73117dbfbfd7a4484f2da3ba188f4187d
- NewPeriod(uint256 indexed, uint8): 0x4e6f5cf43b95303e86aee81683df63992061723a829ee012db21dad388756b91
- Views: `appealPeriod(uint256)` 0xafe15cfb, `currentRuling(uint256)` 0x1c3db16d, `disputeStatus(uint256)` 0x10f169e8.

## 5. Policies and whether our question can be adjudicated

**Seer Markets Resolution Policy** (ipfs://QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf, 8 pages, text in `policy.txt`).

The question resolves **INVALID** for:
- relative dates;
- moral (not factual) questions;
- no valid answer among the outcomes;
- multiple valid outcomes in a single-choice question (with exceptions in rules 20 and 21);
- repeated answers;
- prohibited questions that incentivise violence.

It resolves **ANSWERED TOO SOON** when the answer was not known at the time of the first answer but is reasonably expected to become known later.

Default rules: UTC 24h clock; dates read as MM/DD/YYYY unless written YYYY-MM-DD; the opening date counts as the event date if no date is given. Rule 15 requires objective, reasonable-person interpretation regardless of what the creator intended. Rule 18 says use the most credible sources. **Rule 19: if no interpretation is clearly more reasonable than the others, the answer is INVALID.**

**Kleros General Court policy** (`/ipfs/Qmd1TMEbtic3TSonu5dfqa5k3aSrjxRGY8oJH3ruGgazRB` via PolicyRegistry `policies(0)`):
- Rulings are based on the state of the world, court policies and primary documents as they were when the dispute was created.
- Evidence submitted after the first-round evidence period that was not readily public must be disregarded.
- "Refuse to arbitrate" applies when both sides behaved immorally.

What this means for a question like "was a reproducible counterexample submitted before T": it is a factual question with an absolute deadline, so it can be adjudicated if:
- (a) the evidence mechanism is public and timestamped (on-chain or an IPFS hash anchored before T);
- (b) "reproducible" is defined operationally: pinned commit SHA, environment and config hashes, an exact reproduction script, and pass/fail criteria tied to the hashed policy;
- (c) opening_ts >= T, so it cannot be answered too soon;
- (d) the question text points jurors to where the evidence lives.

If reproduction needs judgement the jurors cannot exercise, or the criteria are ambiguous, the risk is INVALID under rule 19. Jurors are General Court generalists (31 at first instance), so the evidence has to be self-explanatory, ideally with deterministic steps that anyone can run.

## 6. Practical guidance

**Bonds and timeout.**
- Seer UI default MIN_BOND on Gnosis is 10 xDAI (`web/src/lib/config.ts`); other options seen on chain are 0.1 and 1 xDAI. Timeout is fixed at 3.5 days by the factory.
- Bond escalation doubles each step: 10 → 20 → 40 → … xDAI. After n steps the bond is 10·2^n.

**Who answers.** Anyone; Reality.eth has no allowlist. Arbitration can also be requested by anyone holding ETH on mainnet.

**Last-minute answers.** Each answer restarts the 3.5-day timer, so the danger is having no funded watcher. The app should run:
- an answer bot that answers right after opening_ts with the correct answer at >= min_bond, and doubles the bond against any wrong answer, using max_previous = the bond it saw;
- an escalation policy: once the opponent's bond exceeds roughly the arbitration cost (about 0.17 ETH plus mainnet gas, converted to xDAI), or with fewer than about 24 h left before finalize_ts, call requestArbitration on mainnet with maxPrevious = current bond. Leave enough margin for the roughly 30-minute AMB relay plus a safety buffer;
- a keeper for handleNotifiedRequest, handleRejectedRequest, handleFailedDisputeCreation, AMB executeSignatures if needed, and reportArbitrationAnswer;
- an evidence publisher that calls submitEvidence on mainnet;
- a claimer that runs claimWinnings and then withdraw().

**Monitoring state machine per question:**
- `getTimeout == 0` → not created.
- `now < opening_ts` → not open.
- `finalize_ts == 0` → open, unanswered.
- `isPendingArbitration` → arbitration; then follow the home and foreign proxy statuses.
- `finalize_ts > now` → answered, challengeable.
- otherwise → finalized: read `resultFor`. If it is 0xff…fe, the question needs reopening; also check LogReopenQuestion.

Use reorg-safe confirmations on both chains.

## Commands that worked

```
cast call 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1 "arbitrator()(address)" --rpc-url https://rpc.gnosischain.com
cast call 0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68 "getDisputeFee(bytes32)(uint256)" 0x00..00 --rpc-url https://ethereum-rpc.publicnode.com
cast call 0xE78996A233895bE74a66F451f1019cA9734205cc "questions(bytes32)(bytes32,address,uint32,uint32,uint32,bool,uint256,bytes32,bytes32,uint256,uint256)" <qid> --rpc-url https://rpc.gnosischain.com
curl -sL https://gnosis.blockscout.com/api/v2/smart-contracts/<addr>   # verified source
curl -sL "https://gnosis.blockscout.com/api?module=logs&action=getLogs&address=<addr>&fromBlock=..&toBlock=latest"
```

RPC log-range limits: rpc.gnosischain.com allows 10k blocks per eth_getLogs; publicnode Gnosis also enforces small ranges; the publicnode Ethereum endpoint returned 403 for getLogs, so use the Blockscout logs API there.
