# Worked Example: Gateway Balancer Bot

Status: proposed market, not funded or published. No implementation or actual vulnerability has been evaluated.

## Source

Requirements document, relative to this project root:

`../kleros/kleros-v2/docs/gateway-balancer-bot-spec.md`

Relevant sections:

- 2.2: separate arbitration, bridging/reporter, and operator-gas accounting.
- 4.2: reporter funding uses eligible bridging-fee allocations; arbitration and gas reserves must not cover reporter shortfalls.
- 12, tests 3 and 7: accounting separation and no reporter funding from protected categories.

The source explicitly does not authorize deployments, signing, or live transactions. This verification example does not change that boundary.

## Proposed policy

BOT-001: Automation and Keeper Reliability, parameterized for reporter-funding principal segregation.

## Selected claim

For the frozen configuration and allowed states, each reporter-funding deposit's principal must be allocated only from eligible bridging/reporter funds in the specified accounting scope. It must not consume a pair's arbitration allocation or the operator's transaction-gas reserve.

Important exception: the operator reserve may legitimately pay the gas fee of the reporter-funding transaction. That is not the same as paying the reporter deposit's principal.

Funds sharing the same EOA is not itself a violation; the implementation's allocations, reservations, planned amounts, and resulting accounting must establish the prohibited use.

## Draft question

"Was a reproducible counterexample submitted through [evidence mechanism] before [absolute UTC deadline], against commit [SHA] and environment/configuration [hashes], demonstrating that reporter-deposit principal can consume arbitration funds or the operator transaction-gas reserve, contrary to policy BOT-001 [version/hash] and the pinned keeper specification?"

This question needs final compatibility review against Seer's actual question/description and market-resolution policy before publication.

### YES

At least one timely admissible counterexample demonstrates the selected accounting violation.

### NO

No timely admissible counterexample demonstrates it. This is not a verdict on the bot's overall security, liveness, routing integration, or deployment readiness.

Native invalid/unanswerable outcomes follow the underlying protocol rules; do not advertise a guaranteed refund.

## Illustrative investigation — not a reported bug

Construct a valid, reachable state with:

- A reporter below its funding threshold.
- No eligible bridging-fee funds available for its deposit.
- Protected arbitration funds and operator gas reserves present.

Exercise the real planning/accounting code under the permitted environment. A positive reporter deposit that demonstrably draws its principal from either protected category could qualify. A legitimate gas expense alone does not qualify.

Fixture setup must preserve the implementation's actual assumptions; fabricating an impossible journal state is not sufficient.

## Evidence package

- Target source and specification hashes.
- Pinned runtime/dependencies/configuration.
- Non-secret initial state and its reachability/setup rationale.
- Reproduction command and automated assertions.
- Relevant allocation/reservation transitions and planned transaction values.
- Explanation distinguishing deposit principal from transaction gas.
- Durable evidence reference with timely submission proof.

No production keys, real customer funds, or live broadcast are required or authorized for this proposed accounting claim. Any use of adapter simulations must be explicitly agreed and limited to this claim; it cannot count as validation of actual LI.FI execution. The bot specification's separate real-integration launch gates remain intact.

## Other possible claims — separate scopes, not bundled promises

- After a successful bridge followed by swap failure, recovery must not blindly start another bridge for the same operation.
- Requotes/retries must not reset an operation's total permitted pricing-loss budget.
- Missing, stale, or excessively disagreeing price observations must prevent the corresponding rate update.

One binary market becomes largely settled once its qualifying counterexample is established. It does not continuously reward discovery of every additional unrelated bug.

## Funding and unresolved inputs

The user mentioned $5. Confirm whether this means:

1. Funding verification of an existing implementation/PR; or
2. Paying someone to create the keeper bot, which is a separate work-procurement product.

If it means verification, also confirm whether $5 is the total spending cap or the liquidity allocation before fees. No claim is made that this amount covers meaningful investigation, full integration testing, or a disputed oracle answer.

Still needed:

- Actual PR/commit and public source availability.
- Final invariant wording and specification snapshot.
- Approved reproduction environment and admissible fixtures.
- Exact deadline, evidence mechanism, and oracle parameters.
- Current chain/asset/fees and executable liquidity estimate.
- Resolution monitoring and dispute-funding responsibilities.

This document creates no market, places no trade, and modifies no keeper implementation.
