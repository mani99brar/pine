// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IClaimRegistry
/// @notice FROZEN interface. Creates a Seer categorical Yes/No market for a verification claim and records an immutable
/// link between the market and the claim's content-addressed documents, in one transaction. The market question is
/// composed ON-CHAIN from the validated parameters (see renderQuestion), so the question can never disagree with the
/// registry record: the claim-document digest, policy digest, repository id, commit, evidence registry and deadlines
/// in the question are exactly the recorded values.
/// @dev There is no owner, no pause and no upgrade path. All configuration is immutable and set at deployment. The
/// constructor is implementation-defined (docs/prd/PRD-01-chain.md section 2.1): it takes the Seer factory, the evidence
/// registry, the min-bond floor and the expected Seer immutables, and refuses any mismatch. The deploy script deploys
/// the EvidenceRegistry first, passing this registry's predicted CREATE address; this constructor requires
/// code at both addresses and IEvidenceRegistry(evidenceRegistry).claimRegistry() == address(this), so the pair is
/// mutually and immutably bound. No URI or other free text is
/// accepted except the validated ASCII title: document locators in the question are raw CIDv1 (sha2-256) values
/// derived on-chain from the digests ("b" + base32-lower of 0x01 0x55 0x12 0x20 || digest), so claim documents and
/// policy texts must be single IPFS blocks (<= 256 KiB, enforced off-chain).
/// Market shape (compile-time constants): Seer createCategoricalMarket with outcomes ["Yes","No"] (Seer appends the
/// invalid slot), tokenNames ["PY_" + first 4 bytes of claimDocumentSha256 as 8 lowercase hex,
/// "PN_" + the same 8 hex], category "misc", lang "en_US", no parent market, bounds 0, openingTime = revealDeadline.
/// The registry cannot verify the off-chain claim document; the API verifies that a document with the recorded digest
/// exists and matches the recorded fields (creator, repository, commit, deadlines, policy) before listing a claim.
///
/// Timing (frozen operators, SEC-SC-07):
///  - creation requires block.timestamp + MIN_EVIDENCE_WINDOW <= evidenceDeadline <= block.timestamp + MAX_EVIDENCE_WINDOW;
///  - evidenceDeadline + MIN_REVEAL_WINDOW <= revealDeadline <= evidenceDeadline + MAX_REVEAL_WINDOW;
///  - evidence commitments and publications count iff block.timestamp < evidenceDeadline;
///  - reveals count iff block.timestamp < revealDeadline;
///  - the Reality.eth question opens at revealDeadline (no answer is possible before every timely commitment could be revealed).
interface IClaimRegistry {
    /// @param claimDocumentSha256 SHA-256 of the RFC 8785 canonical claim document bytes. Nonzero.
    /// @param policyDocumentSha256 SHA-256 of the exact policy text bytes the claim is bound to. Nonzero.
    /// @param repositoryId GitHub numeric repository id (stable across renames and transfers). Nonzero.
    /// @param commit Git commit id (SHA-1, 20 bytes) of the target. Nonzero.
    /// @param evidenceDeadline Unix seconds; see timing rules.
    /// @param revealDeadline Unix seconds; see timing rules. Also the Reality.eth opening time. Must fit in uint32.
    /// @param minBond Reality.eth minimum bond in native wei (xDAI); minimumMinBond() <= minBond <= MAX_MIN_BOND().
    /// @param title Short claim title: 1..MAX_TITLE_BYTES bytes of printable ASCII (0x20..0x7E) excluding '"' and '\'.
    /// Informational only: the claim document governs.
    struct CreateClaimParams {
        bytes32 claimDocumentSha256;
        bytes32 policyDocumentSha256;
        uint64 repositoryId;
        bytes20 commit;
        uint64 evidenceDeadline;
        uint64 revealDeadline;
        uint256 minBond;
        string title;
    }

    struct Claim {
        address creator;
        uint64 createdAt;
        uint64 evidenceDeadline;
        uint64 revealDeadline;
        uint64 repositoryId;
        bytes20 commit;
        bytes32 claimDocumentSha256;
        bytes32 policyDocumentSha256;
        /// Reality.eth question id (Market.questionsIds()[0]).
        bytes32 questionId;
        /// Conditional Tokens condition id (Market.conditionId()).
        bytes32 conditionId;
        /// keccak256(bytes(marketName)) of the composed question.
        bytes32 marketNameHash;
        uint256 minBond;
        /// Wrapped ERC20 outcome tokens: Market.wrappedOutcome(0) (Yes), (1) (No), (2) (Invalid).
        address yesToken;
        address noToken;
        address invalidToken;
    }

    /// @notice Emitted once per market, in the same transaction that created the Seer market. Carries every field an
    /// indexer needs (the full Claim record, the title and the composed question); no view call is required.
    event ClaimCreated(
        address indexed market, address indexed creator, bytes32 indexed claimDocumentSha256, Claim claim, string title, string marketName
    );

    error ZeroValue();
    error EvidenceDeadlineOutOfRange(uint64 evidenceDeadline, uint64 earliest, uint64 latest);
    error RevealDeadlineOutOfRange(uint64 revealDeadline, uint64 earliest, uint64 latest);
    error MinBondTooLow(uint256 minBond, uint256 minimum);
    error MinBondTooHigh(uint256 minBond, uint256 maximum);
    error TitleLength(uint256 length);
    error TitleForbiddenByte(uint256 index);
    error DuplicateClaim(address existingMarket);
    error UnexpectedMarketShape(address market);
    error UnknownMarket(address market);

    /// @notice Creates the Seer market (outcomes "Yes", "No"; Seer appends "Invalid result") with the composed question
    /// and records the claim. Reverts DuplicateClaim when msg.sender already created a claim for the same document.
    /// @return market The new Seer market address, which is also the claim's identifier.
    function createClaim(CreateClaimParams calldata params) external returns (address market);

    /// @notice The exact market question createClaim composes for these parameters (validated identically; reverts on
    /// invalid input). One line of printable ASCII; byte-identical to renderQuestion() in packages/shared/src/question.ts:
    /// `Pine claim [<title>]: was a reproducible counterexample submitted to evidence registry <0x registry, lowercase>
    /// on Gnosis, recorded before <YYYY-MM-DD HH:MM:SS> UTC and disclosed before <YYYY-MM-DD HH:MM:SS> UTC, for GitHub
    /// repository id <decimal> at commit <40 lowercase hex>? Terms: claim document ipfs://<claim CID> (sha256 <0x + 64
    /// lowercase hex>), policy ipfs://<policy CID> (sha256 <0x + 64 lowercase hex>). Yes = at least one timely
    /// admissible counterexample; No = none; admissibility per the policy.`
    /// The first timestamp is evidenceDeadline, the second revealDeadline (both UTC, zero-padded, 24-hour clock).
    /// The result never contains '"', '\' or control characters, so it is safe inside Reality template 2's JSON string.
    function renderQuestion(CreateClaimParams calldata params) external view returns (string memory);

    /// @notice Reverts UnknownMarket for a market this registry did not create.
    function getClaim(address market) external view returns (Claim memory);

    function isRegistered(address market) external view returns (bool);

    /// @notice The market msg.sender-independent lookup: market created by `creator` for `claimDocumentSha256`, or zero.
    function marketOf(address creator, bytes32 claimDocumentSha256) external view returns (address);

    /// @notice Number of claims created by this registry.
    function claimCount() external view returns (uint256);

    /// @notice The EvidenceRegistry bound to this registry at construction (immutable).
    function evidenceRegistry() external view returns (address);

    /// @notice Seer MarketFactory used to create markets (immutable; code checked at construction).
    function seerMarketFactory() external view returns (address);

    /// @notice Smallest accepted Reality.eth minimum bond (immutable).
    function minimumMinBond() external view returns (uint256);

    function MIN_EVIDENCE_WINDOW() external view returns (uint64);
    function MAX_EVIDENCE_WINDOW() external view returns (uint64);
    function MIN_REVEAL_WINDOW() external view returns (uint64);
    function MAX_REVEAL_WINDOW() external view returns (uint64);
    function MAX_TITLE_BYTES() external view returns (uint256);
    function MAX_MIN_BOND() external view returns (uint256);
}
