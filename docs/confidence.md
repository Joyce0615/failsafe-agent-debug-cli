# Confidence Semantics

Failsafe emits several numbers between 0 and 1 and they mean different things.
Treating them as interchangeable is the most likely way to misread the tool, so
this document says what each one is, what it is not, and whether it can be
compared with any other.

## The numbers

| Name | Module | What it means | What it is *not* |
|---|---|---|---|
| `root_cause.confidence` | `src/rules/confidence.ts` | Strength of the rule that matched, tier-adjusted | A probability that the diagnosis is correct |
| `RankedCause.confidence` | `src/diagnosis/ranking.ts` | Normalized posterior over the candidate set **plus** an explicit "none of these" | A probability over the candidates alone; the residual is a real member |
| `RankedCause.raw_confidence` | `src/diagnosis/ranking.ts` | The same, before calibration | The reported figure — `confidence` is |
| Calibrated confidence | `src/diagnosis/calibration.ts` | An observed accuracy for predictions in that bin | Meaningful in an unobserved bin, where the raw value passes through |
| `expected_bits` | `src/diagnosis/experiments.ts` | Mutual information between an outcome and the hypothesis, in bits | A confidence at all; it is a *change* in uncertainty |
| Beta posterior mean/interval | `src/rules/flaky-model.ts` | Belief about a failure *probability*, from observed reruns | Belief about a diagnosis |
| `strength` on a causal edge | `src/diagnosis/causal-construction.ts` | How well the evidence supports that edge existing | A probability that the edge is causal |
| `relevance` | `src/diagnosis/drift.ts` | How much evidence links a change to the failure | A likelihood that the change caused it |
| `exactness` | `src/diagnosis/symbol-resolution.ts` | Which backend answered: `exact`, `syntactic`, `approximate` | A number; it is deliberately ordinal |
| `trust_score` | `src/exchange/bundle.ts` | Whether a received bundle should be believed | Anything about the diagnosis inside it |

## Rules that hold everywhere

1. **A residual is always available and always means the same thing.** Where a
   distribution is reported, "none of these" is a member of it. A leader at 0.4
   with a residual of 0.5 is a system saying it probably has the wrong candidate
   set, and that is a different statement from a leader at 0.4 with two rivals.

2. **Calibration is checked, not assumed.** A confidence is only as good as the
   corpus it was validated on. `calibrationReport` withholds a verdict below 30
   answered predictions, and a ranking produced without a calibration map says
   so in its caveats.

3. **Confidence never travels without its contradictions.** Item 60 keeps
   supporting and contradicting evidence in separate fields, and a candidate
   with contradictions is named in the caveats. A confidence figure quoted
   without them has been stripped of the thing that makes it arguable.

4. **Bits are not probabilities.** `expected_bits` measures how much an
   experiment would change belief. An experiment worth 1 bit is not "100%
   confident"; it is one that halves the hypothesis space in expectation.

5. **Ordinal is not cardinal.** `exactness` and risk tiers are ordered
   categories. They are never averaged, and sorting by them is lexicographic
   rather than by a numeric score, because the whole point is that no ratio
   should let a riskier or vaguer answer overtake a better one.

## Thresholds and where they are defined

| Constant | Value | Module |
|---|---|---|
| `MIN_LEADER_CONFIDENCE` | 0.45 | `src/diagnosis/ranking.ts` |
| `MIN_MARGIN` | 0.15 | `src/diagnosis/ranking.ts` |
| `SOUNDNESS_THRESHOLD` | 0.7 | `src/bench/reasoning-rubric.ts` |
| `DISCRIMINATION_THRESHOLD` | 0.05 bits | `src/diagnosis/experiments.ts` |
| `MIN_CALIBRATION_SAMPLES` | 30 | `src/diagnosis/calibration.ts` |
| `MIN_ACCEPTABLE_KAPPA` | 0.6 | `src/bench/reasoning-rubric.ts` |
| `LINK_THRESHOLD` | 0.2 | `src/diagnosis/drift.ts` |

`tests/docs/documentation.test.ts` asserts these values match the code, so this
table cannot drift silently.

## How to read a low confidence

A low number is not a failure of the tool. The three reasons are distinguishable
and call for different responses:

- **High residual** — the candidate set is probably wrong. Widen it; more
  evidence about the current candidates will not help.
- **Low margin** — two candidates are genuinely competing. Run the experiment
  that discriminates between them (`rankExperiments`).
- **Contradictions present** — something is arguing against the leader. Read it
  before spending more budget.
