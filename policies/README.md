# Technical Verification Policy Templates

Status: v0.1 discovery drafts. Not approved market terms and not enabled in a deployed application.

These templates define admissible technical counterexamples. They do not commission exhaustive reviews, promise payment to every evidence submitter, or override Seer's market-resolution rules.

## Common publication requirements

Every published claim must freeze:

- Policy ID, version, full text/content hash, and durable retrieval location.
- Repository and commit; base commit when the requirement concerns an introduced regression.
- In-scope components and one exact behavioral requirement/invariant.
- Runtime, dependency versions, non-secret configuration, and relevant external-state snapshot.
- Allowed inputs, operating assumptions, and fault model.
- Evidence submission mechanism and absolute UTC deadline.
- Reproduction requirements, exclusions, and treatment of unavailable/ambiguous evidence under applicable market rules.
- Oracle opening/resolution parameters consistent with the evidence deadline.

One family may contain many requirements, but publication selects a bounded proposition. A title such as "Smart-contract security" is not itself a resolvable claim.

An admissible counterexample must be timely, identify the pinned artifact, and demonstrate the stated violation under the allowed conditions. A test that alters the target's behavior, assumes unavailable privileges, or depends on an excluded environment is not sufficient.

A submission may be adjudicated after its timely filing. Technical validity is settled through the defined oracle/arbitration process, not by the customer silently changing requirements or rejecting inconvenient evidence.

Only the market's native payout rules govern traders. Submitting evidence alone does not guarantee a bounty. Position ownership alone does not demonstrate that its holder performed research.

## FUNC-001 — Functional Correctness

### Intended use

Verify a specific feature requirement or a claimed bug fix in an application/library.

Examples:

- A user cannot access another user's private resource through named API operations.
- A parser accepts/rejects a specified class of inputs according to a frozen format definition.
- A stated bug fix eliminates an identified failure under defined conditions.

### Required parameters

- Exact expected behavior, allowed input domain, and supported environment.
- Relevant feature/API boundaries and configuration.
- Whether any violation in the selected commit qualifies or only a regression introduced relative to the pinned base.

### Evidence

A repeatable test/demonstration exercising the target code, reproduction command, fixtures without real customer data, actual output, and an explanation of the violated requirement.

### Exclusions

- Style preferences, unbounded performance claims, and general code-quality judgments.
- Unsupported environments or configurations outside the published scope.
- An intentionally modified target implementation.
- A screenshot or assertion without a reproducible behavioral failure.

### Outcome

YES requires at least one timely qualifying functional counterexample. NO means none was submitted; it is not a general correctness certification.

## BOT-001 — Automation and Keeper Reliability

### Intended use

Verify one invariant of a keeper, treasury bot, scheduler, or other stateful automation system.

Candidate claim classes:

- Separation of protected fund/accounting categories.
- Prevention of duplicate operations during specified recovery scenarios.
- Safe nonce allocation under specified concurrency.
- Adherence to route, recipient, spender, or spending limits.
- Defined behavior when required inputs become stale or unavailable.

### Required parameters

- One selected invariant and its source requirement.
- Permitted starting states and a way to establish that the failing state is reachable.
- Scope of accounts, chains, routes, and accounting categories.
- Explicit fault model, such as process crash, timeout, or replacement transaction; do not silently assume arbitrary database corruption.
- Which adapters may be simulated and what evidence requires real integration validation.

### Evidence

A reproducible sequence with initial state, allowed events/faults, resulting plans/state transitions, and the violation. Include relevant non-secret journal entries and proposed transaction fields when necessary.

For financial claims, distinguish deposit/transfer principal from legitimate transaction-gas expenditure. Shared physical custody alone does not prove accounting cross-subsidy.

### Exclusions and boundaries

- Do not require or authorize live transfers, production keys, or attacks on services to prove a claim.
- An artificial state not reachable under the agreed model is not a counterexample unless initialization of that state is explicitly allowed.
- Simulation/fault-injection evidence cannot establish that a real bridge, swap, price feed, or deployment integration works.
- A process-level reliability result is not proof of unattended production readiness.

### Outcome

YES requires a timely reproducible violation of the selected invariant, not merely an unrelated improvement suggestion. NO means none was submitted within scope.

## SC-001 — Smart-Contract Invariant and Security Verification

### Intended use

Challenge a particular security property of pinned smart-contract code or a precisely specified deployment state.

Examples:

- An unauthorized caller cannot transfer protected assets through identified entry points.
- A specified accounting invariant holds over an allowed sequence of transactions.
- A defined signature cannot be replayed under the published domain/nonce assumptions.

This is not a full audit or a guarantee of zero vulnerabilities.

### Required parameters

- Source/bytecode references and compiler/build settings.
- For state-dependent claims: chain, addresses, block/state snapshot, configuration, and proxy implementation references as applicable.
- Explicit attacker permissions, initial assets, trusted roles, and external dependency assumptions.
- Exact prohibited effect/invariant. If a severity threshold is used, freeze its definitions and exclusions.
- Approved evidence/disclosure procedure, especially if related deployed systems hold real funds.

### Evidence

A local test or isolated fork reproduction that demonstrates the prohibited effect, with setup, transaction sequence, assertions, and impact explanation. Simulated/fork execution must not broadcast live transactions.

### Exclusions and boundaries

- Possession of a trusted administrator key unless that capability is expressly within the threat model.
- Profit or damage assumptions that cannot occur under the pinned state and allowed actions.
- Speculative findings without a demonstrated qualifying violation.
- Live exploitation, unauthorized access, or moving other parties' assets.
- Deployment-readiness or real-route claims inferred solely from local tests.

### Publication gate

Do not enable claims that may expose live vulnerabilities until evidence access, responsible disclosure, and the adjudicator's ability to examine evidence have been resolved. Keeping exploit evidence confidential while retaining a credible open market is an unresolved design requirement, not an assumed feature.

### Outcome

YES requires a timely qualifying demonstration of the defined security violation. NO means no such evidence was submitted under these rules, not that the contract is safe.

## Policy governance — proposed

The initial application publishes a small reviewed catalog rather than accepting arbitrary user-written court policies. Customers parameterize a template and approve the resulting question before funding.

Policy revisions affect only future markets. Existing markets retain their pinned text. UI labels, documentation updates, or administrator preferences must not retroactively change funded market terms.
