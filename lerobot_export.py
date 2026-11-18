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
        def resolve_target(joint, field, value):
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
                target = direction * value
                if field == "offset_deg":
                    target += origin
                tolerance = 0.5
            if not (isfinite(origin) and low - tolerance <= origin <= high + tolerance
                    and low <= target <= high):
                raise ValueError(f"{joint}: start or target is outside the calibrated range.")
            return key, target, low, high, tolerance

        targets = [[resolve_target(*action) for action in group] for group in _ROUTE]

        expected = {key: float(start[key]) for key in robot.action_features if key.endswith(".pos")}

        for index, group in enumerate(targets, 1):
            goals = {key: target for key, target, _, _, _ in group}
            if approve is not None and not approve(index, goals.copy()):
                return robot.get_observation()
            observed = robot.get_observation()
            for axis, previous in expected.items():
                drift_tolerance = 3 if axis == "gripper.pos" else 2
                if not abs(float(observed[axis]) - previous) <= drift_tolerance:
                    raise RuntimeError(f"{axis}: arm moved away from the expected pose before step {index}.")
            step_start = {key: float(observed[key]) for key in goals}
            started = monotonic()
            best_error = {key: abs(target - step_start[key]) for key, target in goals.items()}
            duration = max(2.0, max(best_error.values()) / 5)
            last_progress = dict.fromkeys(goals, started)
            while True:
                observed = robot.get_observation()
                now = monotonic()
                progress = min(1, (now - started) / duration)
                commands = {}
                reached = True
                for key, target, low, high, tolerance in group:
                    current = float(observed[key])
                    if not low - tolerance <= current <= high + tolerance:
                        raise RuntimeError(f"{key}: measured value is outside the calibrated range.")
                    error = abs(target - current)
                    if error <= tolerance or best_error[key] - error >= 0.1:
                        last_progress[key], best_error[key] = now, error
                    if error <= tolerance:
                        continue
                    reached = False
                    if now - last_progress[key] >= 3 or now - started >= duration * 4 + 3:
                        raise RuntimeError(f"{key}: did not reach {target:.2f} at step {index}.")
                    planned = step_start[key] + (target - step_start[key]) * progress
                    if (planned - current) * (target - current) > 0:
                        increment = min(1.0, abs(planned - current), error)
                        commands[key] = min(high, max(low, current + copysign(increment, target - current)))
                if reached:
                    break
                if commands:
                    robot.send_action(commands)
                sleep(0.05)
            expected.update(goals)

        return robot.get_observation()
''').lstrip()


def export_lerobot(source, directions):
    route = compile_program(source)
    groups = [tuple((action["joint"], key, value)
                    for action in step.get("actions", [step])
                    for key, value in action.items() if key != "joint")
              for step in route["steps"]]
    joints = dict.fromkeys(joint for group in groups for joint, _, _ in group)
    if route.get("coordinates") == "lerobot":
        signs = dict.fromkeys(joints, 1)
    else:
        signs = {joint: directions[joint] for joint in joints if joint in directions}
    entries = indent("".join(f"{group!r},\n" for group in groups), "    ")
    return (
        '"""Generated SO-101 route. Import run_route and pass your existing follower."""\n\n'
        "from math import copysign, isfinite\n"
        "from time import monotonic, sleep\n\n"
        "from lerobot.robots.so_follower import SO101Follower\n\n\n"
        f"_ROUTE = (\n{entries})\n"
        f"_EXPORTED_DIRECTIONS = {signs!r}\n\n\n"
        + RUNNER
    )
