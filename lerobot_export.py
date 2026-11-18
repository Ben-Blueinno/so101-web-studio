"""Generate a self-contained SO-101 route function for existing LeRobot projects."""
from textwrap import dedent, indent

from program_editor import compile_program


# This source is included in the exported file, so it can be dropped into an existing project.
RUNNER = dedent('''
    def run_route(robot: SO101Follower, *, joint_directions=None, approve=None):
        """Run the route on a connected, calibrated SO-101 using use_degrees=True.

        joint_directions overrides the exported model-to-motor signs, keyed by
        joint name. If supplied, approve(step_number, action) must return true
        before that step moves. The caller owns the robot connection.
        """
        if not robot.is_connected or not robot.is_calibrated:
            raise ValueError("Connect and calibrate the SO-101 before running the route.")
        if not robot.config.use_degrees:
            raise ValueError("Configure your SO101Follower with use_degrees=True.")
        directions = {**_EXPORTED_DIRECTIONS, **(joint_directions or {})}
        start = robot.get_observation()
        targets = []
        for joint, value in _ROUTE:
            direction = directions.get(joint)
            if type(direction) is not int or direction not in (-1, 1):
                raise ValueError(f"Set the verified sign for {joint} to 1 or -1.")
            key = f"{joint}.pos"
            calibration = robot.calibration[joint]
            span = calibration.range_max - calibration.range_min
            if span <= 0:
                raise ValueError(f"{joint}: invalid saved calibration range.")
            origin = float(start[key])
            if joint == "gripper":
                low, high = 0.0, 100.0
                target = value if direction == 1 else 100 - value
                tolerance = max(0.5, 110 / span)
            else:
                # The SO-101 STS3215 encoder uses 4096 positions per turn.
                limit = span * 180 / 4095
                low, high = -limit, limit
                target = origin + direction * value
                tolerance = 0.5
            if not (isfinite(origin) and low - tolerance <= origin <= high + tolerance
                    and low <= target <= high):
                raise ValueError(f"{joint}: start or target is outside the calibrated range.")
            targets.append((key, target, low, high, tolerance))

        expected = {key: float(start[key]) for key in robot.action_features if key.endswith(".pos")}

        for index, (key, target, low, high, tolerance) in enumerate(targets, 1):
            if approve is not None and not approve(index, {key: target}):
                return robot.get_observation()
            observed = robot.get_observation()
            for axis, previous in expected.items():
                drift_tolerance = 3 if axis == "gripper.pos" else 2
                if not abs(float(observed[axis]) - previous) <= drift_tolerance:
                    raise RuntimeError(f"{axis}: arm moved away from the expected pose before step {index}.")
            current = float(observed[key])
            step_start = current
            started = monotonic()
            duration = max(2.0, abs(target - step_start) / 5)
            last_progress = started
            best_error = abs(target - current)
            while True:
                current = float(robot.get_observation()[key])
                if not low - tolerance <= current <= high + tolerance:
                    raise RuntimeError(f"{key}: measured value is outside the calibrated range.")
                error = abs(target - current)
                if error <= tolerance:
                    break
                now = monotonic()
                if best_error - error >= 0.1:
                    last_progress, best_error = now, error
                if now - last_progress >= 3 or now - started >= duration * 4 + 3:
                    raise RuntimeError(f"{key}: did not reach {target:.2f} at step {index}.")
                planned = step_start + (target - step_start) * min(1, (now - started) / duration)
                if (planned - current) * (target - current) > 0:
                    increment = min(1.0, abs(planned - current), error)
                    goal = min(high, max(low, current + copysign(increment, target - current)))
                    robot.send_action({key: goal})
                sleep(0.05)
            expected[key] = target

        return robot.get_observation()
''').lstrip()


def export_lerobot(source, directions):
    route = compile_program(source)
    rows = [(step["joint"], step.get("offset_deg", step.get("position_pct"))) for step in route["steps"]]
    if route.get("coordinates") == "lerobot":
        signs = {joint: 1 for joint, _ in rows}
    else:
        signs = {joint: directions[joint] for joint, _ in rows if joint in directions}
    entries = indent("".join(f"{row!r},\n" for row in rows), "    ")
    return (
        '"""Generated SO-101 route. Import run_route and pass your existing follower."""\n\n'
        "from math import copysign, isfinite\n"
        "from time import monotonic, sleep\n\n"
        "from lerobot.robots.so_follower import SO101Follower\n\n\n"
        f"_ROUTE = (\n{entries})\n"
        f"_EXPORTED_DIRECTIONS = {signs!r}\n\n\n"
        + RUNNER
    )
