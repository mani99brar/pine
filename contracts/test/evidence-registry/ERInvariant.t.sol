// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {IEvidenceRegistry} from "../../src/interfaces/IEvidenceRegistry.sol";
import {ERMockClaimRegistry} from "./mocks/ERMockClaimRegistry.sol";

/// @notice Drives commits, publications, valid and invalid reveals and time across three markets, keeping an
/// independently computed ghost copy of every record the registry should hold. Violations are counted rather than
/// asserted here, because a reverting handler call is discarded (fail_on_revert = false); the invariants read them.
contract ERHandler is Test {
    EvidenceRegistry public immutable registry;
    ERMockClaimRegistry public immutable claims;
    address[3] internal markets;
    address[3] internal actors;

    IEvidenceRegistry.Submission[] internal _expected;
    mapping(uint256 id => bytes32) internal _salts;
    mapping(uint256 id => bytes32) internal _digests;

    /// Calls that succeeded although they must revert (invalid reveals) or returned a non-sequential id.
    uint256 public unexpectedSuccesses;
    /// Timely, well-formed calls by the right actor that reverted.
    uint256 public unexpectedFailures;
    uint256 public reveals;

    constructor(EvidenceRegistry registry_, ERMockClaimRegistry claims_, address[3] memory markets_) {
        registry = registry_;
        claims = claims_;
        markets = markets_;
        actors = [makeAddr("actor0"), makeAddr("actor1"), makeAddr("actor2")];
    }

    function expectedCount() external view returns (uint256) {
        return _expected.length;
    }

    function expected(uint256 id) external view returns (IEvidenceRegistry.Submission memory) {
        return _expected[id - 1];
    }

    function salt(uint256 id) external view returns (bytes32) {
        return _salts[id];
    }

    function digest(uint256 id) external view returns (bytes32) {
        return _digests[id];
    }

    function commit(uint256 actorSeed, uint256 marketSeed, bytes32 digest_, bytes32 salt_) external {
        address actor = actors[actorSeed % 3];
        address market = markets[marketSeed % 3];
        bytes32 commitment = registry.computeCommitment(market, actor, digest_, salt_);
        bool timely = block.timestamp < claims.getClaim(market).evidenceDeadline;
        vm.prank(actor);
        try registry.commitEvidence(market, commitment) returns (uint256 id) {
            _expected.push(
                IEvidenceRegistry.Submission({
                    market: market,
                    submitter: actor,
                    committedAt: uint64(block.timestamp),
                    revealedAt: 0,
                    status: IEvidenceRegistry.Status.Committed,
                    commitment: commitment,
                    contentSha256: bytes32(0)
                })
            );
            if (id != _expected.length || !timely) ++unexpectedSuccesses;
            _salts[id] = salt_;
            _digests[id] = digest_;
        } catch {
            if (timely) ++unexpectedFailures;
        }
    }

    function publish(uint256 actorSeed, uint256 marketSeed, bytes32 digest_) external {
        address actor = actors[actorSeed % 3];
        address market = markets[marketSeed % 3];
        bool valid = block.timestamp < claims.getClaim(market).evidenceDeadline && digest_ != bytes32(0);
        vm.prank(actor);
        try registry.publishEvidence(market, digest_) returns (uint256 id) {
            _expected.push(
                IEvidenceRegistry.Submission({
                    market: market,
                    submitter: actor,
                    committedAt: uint64(block.timestamp),
                    revealedAt: uint64(block.timestamp),
                    status: IEvidenceRegistry.Status.Published,
                    commitment: bytes32(0),
                    contentSha256: digest_
                })
            );
            if (id != _expected.length || !valid) ++unexpectedSuccesses;
        } catch {
            if (valid) ++unexpectedFailures;
        }
    }

    /// Reveals with the true preimage by the true submitter; only this may change a record. Picks the first id from
    /// the seed onward that is revealable, so nearly every run reveals (ERInvariantTest.afterInvariant requires one);
    /// when none is, the seed's own id is attempted anyway and must revert.
    function revealHonest(uint256 idSeed) external {
        uint256 count = _expected.length;
        if (count == 0) return;
        uint256 id = idSeed % count + 1;
        for (uint256 i = 0; i < count; ++i) {
            uint256 candidate = (idSeed % count + i) % count + 1;
            if (_revealable(candidate)) {
                id = candidate;
                break;
            }
        }
        IEvidenceRegistry.Submission storage record = _expected[id - 1];
        bool valid = _revealable(id);
        vm.prank(record.submitter);
        try registry.revealEvidence(id, _digests[id], _salts[id]) {
            if (!valid) {
                ++unexpectedSuccesses;
                return;
            }
            record.status = IEvidenceRegistry.Status.Revealed;
            record.revealedAt = uint64(block.timestamp);
            record.contentSha256 = _digests[id];
            ++reveals;
        } catch {
            if (valid) ++unexpectedFailures;
        }
    }

    /// Arbitrary reveals: any id (including unissued ones), any actor, the true or a perturbed preimage. These must
    /// succeed only when they are indistinguishable from an honest reveal of a Committed id.
    function revealAny(uint256 idSeed, uint256 actorSeed, bool perturbDigest, bool perturbSalt) external {
        uint256 id = idSeed % (_expected.length + 2);
        address actor = actors[actorSeed % 3];
        bytes32 digest_ = perturbDigest ? keccak256(abi.encode(_digests[id])) : _digests[id];
        bytes32 salt_ = perturbSalt ? keccak256(abi.encode(_salts[id])) : _salts[id];
        vm.prank(actor);
        try registry.revealEvidence(id, digest_, salt_) {
            if (id == 0 || id > _expected.length) {
                ++unexpectedSuccesses;
                return;
            }
            IEvidenceRegistry.Submission storage record = _expected[id - 1];
            bool honest = actor == record.submitter && record.status == IEvidenceRegistry.Status.Committed
                && digest_ == _digests[id] && salt_ == _salts[id]
                && block.timestamp < claims.getClaim(record.market).revealDeadline;
            if (!honest) {
                ++unexpectedSuccesses;
                return;
            }
            record.status = IEvidenceRegistry.Status.Revealed;
            record.revealedAt = uint64(block.timestamp);
            record.contentSha256 = digest_;
            ++reveals;
        } catch {}
    }

    /// An honest reveal of `id` must succeed: Committed, timely, and a preimage the registry accepts (nonzero).
    function _revealable(uint256 id) internal view returns (bool) {
        IEvidenceRegistry.Submission storage record = _expected[id - 1];
        return record.status == IEvidenceRegistry.Status.Committed
            && block.timestamp < claims.getClaim(record.market).revealDeadline && _digests[id] != bytes32(0)
            && _salts[id] != bytes32(0);
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 3 days));
    }
}

contract ERInvariantTest is Test {
    uint64 internal constant START = 1_790_000_000;

    ERMockClaimRegistry internal claims;
    EvidenceRegistry internal registry;
    ERHandler internal handler;

    function setUp() public {
        vm.warp(START);
        claims = new ERMockClaimRegistry();
        registry = new EvidenceRegistry(address(claims));
        address[3] memory markets = [makeAddr("market0"), makeAddr("market1"), makeAddr("market2")];
        claims.setClaim(markets[0], START + 1 days, START + 2 days);
        claims.setClaim(markets[1], START + 7 days, START + 9 days);
        claims.setClaim(markets[2], START + 30 days, START + 37 days);
        handler = new ERHandler(registry, claims, markets);
        // One well-formed commitment on the longest-window market (revealable for 37 days), recorded through the
        // handler like any other: every run starts with something an honest reveal can open, so afterInvariant does
        // not depend on the fuzzer happening to commit nonzero preimages before the windows close.
        handler.commit(0, 2, keccak256("pine invariant seed digest"), keccak256("pine invariant seed salt"));
        assertEq(registry.submissionCount(), 1);
        targetContract(address(handler));
    }

    /// Ids are exactly 1..submissionCount: every issued id resolves, 0 and count+1 do not.
    function invariant_idsAreGapless() public view {
        uint256 count = registry.submissionCount();
        assertEq(count, handler.expectedCount(), "count");
        for (uint256 id = 1; id <= count; ++id) {
            assertTrue(registry.getSubmission(id).status != IEvidenceRegistry.Status.None, "issued id without status");
        }
        _assertUnknown(0);
        _assertUnknown(count + 1);
    }

    /// Every record equals its independently tracked expectation: Committed moves only to Revealed (once, by the
    /// submitter, with the committed preimage); Revealed and Published records never change.
    function invariant_recordsMatchExpectedTransitions() public view {
        assertEq(handler.unexpectedSuccesses(), 0, "an invalid call succeeded or an id was not sequential");
        assertEq(handler.unexpectedFailures(), 0, "a timely, well-formed call reverted");
        uint256 count = registry.submissionCount();
        for (uint256 id = 1; id <= count; ++id) {
            IEvidenceRegistry.Submission memory actual = registry.getSubmission(id);
            IEvidenceRegistry.Submission memory want = handler.expected(id);
            assertEq(actual.market, want.market, "market");
            assertEq(actual.submitter, want.submitter, "submitter");
            assertEq(actual.committedAt, want.committedAt, "committedAt");
            assertEq(actual.revealedAt, want.revealedAt, "revealedAt");
            assertEq(uint8(actual.status), uint8(want.status), "status");
            assertEq(actual.commitment, want.commitment, "commitment");
            assertEq(actual.contentSha256, want.contentSha256, "contentSha256");
            _assertShape(id, actual);
        }
    }

    /// Runs after every invariant run: the run revealed at least one commitment through the registry, so the
    /// Committed -> Revealed checks above compared real reveals rather than passing vacuously.
    function afterInvariant() public view {
        assertGt(handler.reveals(), 0, "no reveal succeeded in this run: the transition invariant was vacuous");
    }

    function _assertShape(uint256 id, IEvidenceRegistry.Submission memory s) internal view {
        if (s.status == IEvidenceRegistry.Status.Committed) {
            assertNotEq(s.commitment, bytes32(0), "committed without commitment");
            assertEq(s.contentSha256, bytes32(0), "committed with digest");
            assertEq(s.revealedAt, 0, "committed with revealedAt");
        } else if (s.status == IEvidenceRegistry.Status.Revealed) {
            assertGe(s.revealedAt, s.committedAt, "revealed before commit");
            assertEq(
                s.commitment,
                registry.computeCommitment(s.market, s.submitter, s.contentSha256, handler.salt(id)),
                "revealed preimage does not match"
            );
        } else {
            assertEq(uint8(s.status), uint8(IEvidenceRegistry.Status.Published), "unexpected status");
            assertEq(s.commitment, bytes32(0), "published with commitment");
            assertEq(s.revealedAt, s.committedAt, "published revealedAt");
            assertNotEq(s.contentSha256, bytes32(0), "published without digest");
        }
    }

    function _assertUnknown(uint256 id) internal view {
        try registry.getSubmission(id) {
            revert("unissued id resolved");
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, id));
        }
    }
}
