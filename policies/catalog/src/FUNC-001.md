# FUNC-001 Functional Correctness — policy version 0.1.0 (DRAFT)

Status: draft for development and staging. Not approved market terms. A version approved for production is published as a new file with a new digest; this text never changes.

## Intended use
Verify one specific feature requirement, or one claimed bug fix, of an application or library at a pinned commit. Examples: a user cannot access another user's private resource through named API operations; a parser accepts or rejects a specified class of inputs according to a frozen format definition; a stated bug fix eliminates an identified failure under defined conditions.

## Claim parameters this policy requires
The claim document must state, in the named fields:
- `claim.requirement`: the exact expected behaviour, as one bounded proposition.
- `claim.violation`: what observable behaviour demonstrates a violation.
- `claim.scope`: the feature or API boundaries in scope, and anything explicitly out of scope.
- `claim.allowedInputs`: the allowed input domain.
- `claim.regressionOnly`: `true` if only a violation introduced relative to `target.baseCommit` qualifies; `false` if any violation at `target.commit` qualifies.
- `environment`: the supported runtime, dependency versions and non-secret configuration.

## Evidence
A repeatable test or demonstration exercising the target code at `target.commit`, the reproduction command, fixtures without real customer data, the actual output, and an explanation of the violated requirement. When `claim.regressionOnly` is `true`, the evidence must also show the behaviour is correct at `target.baseCommit`.

## Exclusions
- Style preferences, unbounded performance claims and general code-quality judgments.
- Unsupported environments or configurations outside the published scope.
- An intentionally modified target implementation.
- A screenshot or assertion without a reproducible behavioural failure.

## Outcome
Yes requires at least one timely, admissible functional counterexample (rules C3–C5). No means none was submitted; it is not a general correctness certification.

