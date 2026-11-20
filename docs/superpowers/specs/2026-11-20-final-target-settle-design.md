# Exact final target and verified hold

The user approved sending the exact final servo target and requiring 500 ms
of continuous encoder readings within the existing tolerance before success.

The current controller can return as soon as readings enter tolerance, leaving
the last intermediate goal active. Hardware readback confirmed an intermediate
elbow goal, followed by drift outside the rest tolerance. Gain tuning alone
does not address the missing final command.

Keep the bounded interpolation, calibration checks, speed, stationary-joint
checks, stop behavior, torque limits and existing failure timeouts. Once all
active axes enter tolerance, enable holding through the existing routine and
write their exact final goals once. Latch those goals: subsequent samples must
not replace them with intermediate goals. Restart the 500 ms hold timer if any
active axis leaves tolerance. Stop and failed-feedback checks continue while
settling. Report measured values from the final verified sample.

Test the real BrowserFollower controller against a deterministic simulated bus
and clock. Cover an ordinary move, a target initially within tolerance,
simultaneous axes, transient drift, persistent drift, and Stop during settling.
No motor settings or public stage availability change as part of this fix.
Physical verification remains a separate supervised test after deployment.
