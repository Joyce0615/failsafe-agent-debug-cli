# Remediation Runbooks

Each runbook is a sequence with a stated precondition, a stated blast radius,
and — the part usually missing — what remains outstanding after it succeeds.
Every mitigation here treats a symptom. None of them fixes a defect, and a
runbook that ends without saying so is how an incident gets closed with the bug
still in the codebase.

## Before any of them

1. Establish the cause class. `recommend()` refuses to rank modes without one,
   because several mitigations make several failure classes *worse* — retrying a
   resource exhaustion multiplies the load that caused it.
2. Check `classifyConsequence`. Anything irreversible is `severe` regardless of
   how small it looks and needs a completed dry run before approval.
3. Get an approval that is bound to *this* action. A blanket "go ahead" is not
   an approval; `actionDigest` includes the target and the parameters precisely
   so one cannot be reused for another.

---

## Runbook: Rollback

**Use when** a regression is the cause and the previous version is deployable.

**Preconditions** — both verified by `evaluateMode("rollback", …)`:
- a previous version is recorded, and
- it is known to be deployable. Rolling back to something that will not start is
  a longer outage, not a shorter one.

**Contraindicated for** `data_corruption`: rolling back code does not un-write
corrupt data, and an older writer may not understand the new data.

**Steps**
1. Confirm the previous version's artifacts verify (`verifyRelease`).
2. Request approval; consequence is at least `high` because blast radius is 1.
3. Roll back.
4. Run the counterfactual controls (`runControlMatrix`): the failure must
   disappear *and* the mutation arm must still fail, or the rollback was
   coincidental.

**Still outstanding afterwards**
- The defect is in the codebase and will be re-merged unless reverted at source.
- Data written by the newer version may not be readable by the older one.

---

## Runbook: Feature disable

**Use when** the failing path is behind a flag.

**Precondition** — the flag is *confirmed* to gate the failing path. A flag that
does not cover the code is a no-op that looks exactly like a fix, and the time
lost is worse than time not spent because the team now believes it tried
something.

**Steps**
1. Verify coverage: the failing stack must be inside the gated code.
2. Disable. Effect is fast (~30s) and fully reversible.
3. Confirm the symptom stops for the affected cohort specifically, not in
   aggregate — an aggregate that recovers because traffic moved is not a fix.

**Still outstanding afterwards**
- The feature is off for every user, including those it was working for.
- The defect behind the flag is unfixed.

---

## Runbook: Retry

**Use when** the failure is *observed* to succeed on a subsequent attempt.

**Contraindicated for** `resource_exhaustion`, `capacity`, `regression`, and
`data_corruption`. These are hard blocks rather than warnings: a warning at 3am
reads as "proceed with care" and the retry storm happens anyway.

**Before retrying**, establish that the failure is actually intermittent.
`rerunPolicy` is the instrument: three passes of a 20%-flaky test happen 51% of
the time, so three passes do not establish anything. Budget exhaustion returns
`inconclusive`, never `resolved`.

**Still outstanding afterwards**
- The underlying flakiness is unaddressed and will recur.
- Retries hide the failure rate from every dashboard counting final outcomes.

---

## Runbook: Traffic shift

**Use when** the failure is confined to part of the fleet *and* the destination
has genuine spare capacity.

**Contraindicated for** `capacity`: shifting relocates the overload.

**Preconditions**
- the failure is localized, and
- the destination has at least 100% of the shifted load available. Below that,
  the shift creates a second incident.

**Still outstanding afterwards**
- The failing partition is still failing and is now unobserved by real traffic,
  which makes the next diagnosis harder rather than easier.
- The destination is carrying load it was not provisioned for.

---

## Runbook: Emergency override

**Use when** production is down and the approval path is unavailable.

The override exists because a system without one gets bypassed informally —
somebody runs the command by hand and the audit trail ends. Using it is a
deliberate, recorded act:

1. Supply a written justification. It is part of the signature and cannot be
   edited afterwards.
2. The action is flagged `requires_post_hoc_review`.
3. The override does **not** excuse an expired approval or a missing dry run for
   an irreversible action. Those still fail.

**Still outstanding afterwards**
- A post-hoc review. An override that is never reviewed is an approval process
  that has been switched off one incident at a time.

---

## After any remediation

- Record the attempt in the fix ledger with its outcome (`FixEpisode`). Outcome
  is a *history*: a fix that resolves and later regresses is not a success, and
  a durability figure quoted without an observation window is a statement about
  that window only.
- If a hypothesis that justified the fix is later refuted, retract the
  justification (`invalidateHypothesis`) without changing the outcome. The fix
  may still have worked; what is gone is the reason.
