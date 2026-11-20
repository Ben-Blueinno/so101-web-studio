# Final target settling implementation plan

**Goal:** Deliver exact final goals and verify a continuous 500 ms hold.

**Architecture:** Extend BrowserFollower.moveTogether with a final-command latch
and a settling timer. Retain all existing motion and feedback guards.

**Tech stack:** Plain browser JavaScript, Node's built-in test runner and VM.

## Constraints

- Stable fix branch from main; two-arm availability stays dev-only.
- No widened position tolerance, limits, command lead or timeouts.
- Stop must prevent success and further commands during settling.
- Do not reload the connected Studio until the arm is supported/disconnected.

## Implementation and verification

- [x] Add `tests/pages-serial.test.cjs`, loading the actual controller in a VM
  with a deterministic servo bus and clock; reproduce missing final command.
- [x] Run `node --test tests/pages-serial.test.cjs` and observe the expected
  assertion failures before modifying production code.
- [x] Add final-command and continuous-settling state to `pages-serial.js`.
- [x] Verify exact final goals for single/multiple axes and already-near targets;
  verify 500 ms continuous hold, timer reset, failure on persistent drift,
  and interruption by Stop.
- [x] Run Node tests, JavaScript syntax checks and `git diff --check`.
- [ ] Review the change against stop/limit invariants and commit the fix.
- [ ] Deploy the stable fix, carry it into dev, then request supported Studio
  reload and movement clearance for a supervised rest test. Record physical
  results separately from simulated-bus results.
