# GitHub Claim Verification — Product Specification

Status: discovery draft. Product direction agreed; implementation and launch details remain open.

## 1. Product decision

Build a full, publishable application in which customers connect GitHub, select code, publish a bounded acceptance claim, and fund a Seer prediction market that incentivizes independent investigation.

This is adversarial verification of a specific claim, not procurement of a complete code review, a promise to produce software, or insurance against software losses.

The initial audience is teams verifying public software patches and releases, including agent-generated code. Smart-contract invariants are a policy specialization rather than the only supported domain. AI authorship is not an eligibility requirement.

The separate sponsorship program will fund selected users' markets. It is not a substitute for normal customer-funded publishing, and sponsorship economics must be reported separately.

## 2. Agreed product boundaries

- GitHub connection and a repository/PR selection experience.
- Public repositories first.
- The main action is VERIFY: publish a claim about a fixed commit.
- Specific, versioned policy types rather than unrestricted claims such as "this code is safe."
- Permissionless investigation and trading by external participants, including agent operators.
- Seer supplies market infrastructure; Reality.eth answers the market question; Kleros arbitrates disputed answers through the supported integration.
- Customers alone decide whether to merge PRs. No platform merge, deployment, or live target-system execution authority.
- No reviewer-selection auction in this design.
- No guaranteed full audit report, guaranteed investigator participation, or general safety certification.
- Existing market criteria cannot change when the PR receives new commits. A changed artifact requires a new verification record/market.

## 3. Proposed customer journey

1. Connect GitHub with minimal permissions; browse public repositories and PRs.
2. Select the exact commit and, where relevant, its base commit.
3. Choose a policy family and provide one bounded claim, scope, configuration, and reproduction environment.
4. Preview the complete question, policy version, immutable references, evidence deadline, resolution rules, and financial risks.
5. Connect a wallet and fund market creation/liquidity under an explicit spending limit.
6. Publish the immutable claim and market references. Expose a machine-readable description to agents.
7. Track market prices/depth, evidence, submission deadlines, and oracle/dispute status.
8. Inspect demonstrated failures and decide independently whether to change or merge the code.
9. Follow settlement, redemption, and any remaining liquidity position.

These are proposed capabilities, not claims that an integration has been implemented or deployed.

## 4. Policy families

See [policies/README.md](policies/README.md) for draft technical templates:

- Functional correctness.
- Bot and automation reliability.
- Smart-contract invariant/security verification.

Each market chooses a specific requirement inside a family. A family is not a blanket promise to examine every possible failure.

The technical policy must be referenced in the actual immutable market question/description and remain compatible with Seer's applicable market policies. A policy displayed only in our frontend is insufficient. Integration compatibility is a launch gate.

## 5. Question and outcome semantics

Proposed question structure:

"Was a reproducible counterexample demonstrating [specified violation] against commit [hash], under configuration/environment [hashes] and policy [version/hash], submitted through [evidence mechanism] before [absolute UTC timestamp]?"

- YES: at least one timely, admissible submission demonstrates the specified violation.
- NO: no timely, admissible submission demonstrates that violation.
- Native invalid/unanswerable outcomes must be handled according to the underlying protocol and policy, including the actual payout rules. Do not assume an invalid market produces a full refund.

Evidence submission and final adjudication have separate timing. A timely submission can remain under adjudication after the submission deadline. Late discoveries do not reopen a finalized market; they can support a new verification effort.

NO is not proof that the code is correct. UI language should describe the actual result, such as "No qualifying counterexample submitted," not "Safe" or "Certified secure."

A market price refers to the defined submission-and-resolution event. It is not the probability that the software contains no bugs. Trading volume, wallet count, and collateral do not independently prove review depth or reviewer independence.

An evidence deadline is not automatically a protocol-wide trading cutoff; outcome tokens may remain transferable. Do not promise trading restrictions that Seer/token contracts do not enforce.

## 6. Evidence and execution boundaries

- Require a reproducible test/demonstration, expected and actual behavior, and a connection to the exact requirement.
- Pin source, dependency/runtime versions, non-secret configuration, and relevant external-state assumptions.
- Screenshots, recordings, and logs support evidence; for the initial technical policies they do not replace reproducibility.
- Require durable, timestamp-verifiable submission references. Hosting failures, censorship resistance, availability, and evidence front-running require explicit design before launch.
- Treat all submitted repositories, scripts, logs, and attachments as untrusted. Automated reproduction requires isolated, resource-limited execution without customer secrets, production signing keys, or implicit network privileges.
- No authorization to attack deployed systems or spend real target-system funds is created by opening a market.
- Smart-contract policies involving potentially live vulnerabilities need an approved disclosure process before they can be enabled. Do not default to publicly releasing a live exploit.

## 7. Funding and incentives

Liquidity can subsidize informed trading; it is not a fixed bounty or a guaranteed reviewer payment. LP fee income, researcher trading profits, and oracle-answer bond rewards are distinct mechanisms.

The application must explain and display:

- Customer capital deposited and exposed to loss.
- Market-creation, transaction, liquidity/swap, and applicable protocol costs.
- Price impact and executable depth, not just a headline price.
- Whether capital/liquidity can be withdrawn and what, if anything, commits it for the investigation period. Default withdrawable LP positions must not be advertised as guaranteed future rewards.
- Oracle-answer bonds, possible escalation/arbitration costs, and who funds them.
- Net spending limits and explicit wallet approval for additional costs.

Do not assume external LPs will indefinitely subsidize informed researchers. No promised fixed researcher reward, minimum return, loss reimbursement, or guaranteed refund is part of the agreed design.

The user's first example includes a stated $5 willingness to pay. Clarification is required: market funding versus paying for implementation, and whether the amount includes fees. No fee feasibility or adequate market depth has yet been established.

## 8. Full application release requirements — proposed

A publishable release needs more than a demonstration market:

- Customer-funded GitHub-to-market publishing, independent of sponsorship.
- Immutable policy/claim presentation and durable market-to-commit links.
- Agent-facing discovery and machine-readable reproduction instructions.
- Evidence submission, browsing, and resolution/dispute navigation.
- Reliable chain-state indexing and recovery from partial creation/funding failures.
- Wallet/account security, minimal GitHub permissions, and safe handling of untrusted content.
- Explicit loading, empty, failed, pending, disputed, invalid, and resolved states.
- Funding/redemption reconciliation and visible transaction history.
- Observability, abuse controls, deployment documentation, and user-facing risk disclosures.
- Review of applicable legal/regulatory obligations for the intended jurisdictions and operation model.

No app source, deployment, or target-bot changes are authorized or performed by writing this specification.

## 9. First worked example

See [docs/keeper-bot-market-example.md](docs/keeper-bot-market-example.md).

Source: `../kleros/kleros-v2/docs/gateway-balancer-bot-spec.md`, relative to this project root.

Proposed narrow claim: reporter-deposit principal must not be funded from arbitration allocations or the operator's transaction-gas reserve. Paying the reporter transaction's legitimate gas fee from the operator reserve is permitted.

The source is a requirements document. No target implementation or real vulnerability has been evaluated, and no PR/commit is selected yet.

## 10. Open decisions and launch gates

1. Actual target PR/commit and selected claim.
2. Meaning of the $5 budget, fee inclusions, and minimum viable market funding.
3. Supported chain, collateral asset, Seer deployment, and current fee/contract verification.
4. Final immutable policy representation and compatibility with Seer/Reality/Kleros resolution.
5. Submission mechanism, timestamp proof, evidence availability, and disclosure/front-running design.
6. Investigation duration. A 72-hour window was proposed but has not been agreed; arbitration may take longer.
7. Who supplies oracle answers, monitors disputed answers, and funds escalation when necessary.
8. Initial liquidity shape, potential withdrawal constraints, and sponsor/customer maximum loss.
9. Safe reproduction environment and policy-specific admissible fault models.
10. Platform fee/revenue model, authentication choice, stack, hosting, and operational ownership.
11. First enabled policy families and live-security disclosure restrictions.
12. Pilot comparison with an equally funded bounty and conventional review, measuring valid findings, noise, latency, and total cost rather than trading activity alone.

## 11. Infrastructure references

- [Seer overview](https://seer-3.gitbook.io/seer-documentation/overview/what-is-seer)
- [Providing liquidity](https://seer-3.gitbook.io/seer-documentation/getting-started/navigate-our-site/provide-liquidity)
- [Reporting answers](https://seer-3.gitbook.io/seer-documentation/getting-started/navigate-our-site/report-answer)
- [Raising disputes](https://seer-3.gitbook.io/seer-documentation/getting-started/navigate-our-site/raise-a-dispute)

Documentation review is not verification of a deployed integration, current fees, or suitability of the proposed technical questions.
