"""Compile classroom Python statements into a route without running arbitrary code."""
import ast
import operator

MODEL_LIMITS = {'gripper': [0, 100], 'wrist_roll': [-157.21, 162.78], 'wrist_flex': [-166.61, 23.38], 'elbow_flex': [-131.2, 62.45], 'shoulder_lift': [-59.89, 140.1], 'shoulder_pan': [-109.99, 109.99]}

DRAFT = "so101-tabletop-move-set-v1"
EXAMPLE = '''# Change these offsets, then select Preview in 3D.
turn = 8
move("shoulder_pan", turn)
move("shoulder_lift", -5)
move("elbow_flex", 7)
grip(45)
move("elbow_flex", 0)
move("shoulder_lift", 0)
move("shoulder_pan", 0)
'''
LEROBOT_EXAMPLE = '''def route(robot):
    start = robot.get_observation()
    turn = 8
    robot.send_action({"shoulder_pan.pos": start["shoulder_pan.pos"] + turn})
    robot.send_action({"gripper.pos": 45})
    robot.send_action({"shoulder_pan.pos": start["shoulder_pan.pos"]})
'''
ARITHMETIC = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv}
COMMANDS = {"move", "grip", "range"}


def compile_program(source):
    if len(source) > 8192:
        raise ValueError("Keep the program below 8,192 characters.")
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise ValueError(f"Line {error.lineno}: {error.msg}") from error
    steps, variables = [], {}
    budget = 512
    native = len(tree.body) == 1 and isinstance(tree.body[0], ast.FunctionDef)
    has_start = False

    def fail(node, message):
        raise ValueError(f"Line {node.lineno}: {message}")

    def value(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            number = node.value
        elif isinstance(node, ast.Name) and node.id in variables:
            number = variables[node.id]
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            number = value(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.BinOp) and type(node.op) in ARITHMETIC:
            try:
                number = ARITHMETIC[type(node.op)](value(node.left), value(node.right))
            except ZeroDivisionError:
                fail(node, "Division by zero.")
        else:
            fail(node, "Use a number, a saved variable, or +, -, *, /.")
        if not -10000 <= number <= 10000:
            fail(node, "Number is outside the supported range.")
        return number

    def target_for(call, joint, field, amount):
        low, high = (-360, 360) if native and joint != "gripper" else MODEL_LIMITS[joint]
        if not low <= amount <= high:
            fail(call, f"{joint} must be between {low:g} and {high:g}.")
        return {"joint": joint, field: amount}

    def add_step(call, step):
        if len(steps) >= 32:
            fail(call, "A route can have up to 32 moves.")
        steps.append(step)

    def method_call(call, method):
        return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and isinstance(call.func.value, ast.Name) and call.func.value.id == "robot"
                and call.func.attr == method and not call.keywords)

    def baseline(node, key):
        if not (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
                and node.value.id == "start" and isinstance(node.slice, ast.Constant)
                and node.slice.value == key):
            return False
        if not has_start:
            fail(node, "Put start = robot.get_observation() first to use a relative target.")
        return True

    def send_action(call):
        if len(call.args) != 1 or not isinstance(call.args[0], ast.Dict) or not call.args[0].keys:
            fail(call, "Give robot.send_action({...}) one or more joint targets.")
        action = call.args[0]
        targets = [joint_target(call, key, target) for key, target in zip(action.keys, action.values)]
        if len({(target.get("follower"), target["joint"]) for target in targets}) != len(targets):
            fail(call, "Give each joint only one target in a move.")
        add_step(call, targets[0] if len(targets) == 1 else {"actions": targets})

    def joint_target(call, key, target):
        if not isinstance(key, ast.Constant) or not isinstance(key.value, str) or not key.value.endswith(".pos"):
            fail(call, 'Use a LeRobot action key like "shoulder_pan.pos".')
        joint = key.value.removesuffix(".pos")
        follower = None
        if "." in joint:
            follower, joint = joint.split(".", 1)
            if follower not in ("A", "B"):
                fail(call, "Use A. or B. to select a follower.")
        if joint not in MODEL_LIMITS:
            fail(call, f"Unknown SO-101 joint {joint!r}.")
        if follower:
            field = "position_pct" if joint == "gripper" else "position_deg"
            return {**target_for(call, joint, field, value(target)), "follower": follower}
        if joint == "gripper":
            return target_for(call, joint, "position_pct", value(target))
        if baseline(target, key.value):
            return target_for(call, joint, "offset_deg", 0)
        if (isinstance(target, ast.BinOp) and isinstance(target.op, (ast.Add, ast.Sub))
                and baseline(target.left, key.value)):
            delta = value(target.right)
            return target_for(call, joint, "offset_deg", -delta if isinstance(target.op, ast.Sub) else delta)
        return target_for(call, joint, "position_deg", value(target))

    def visit(body):
        nonlocal budget
        for node in body:
            budget -= 1
            if budget < 0:
                fail(node, "The program does too many operations.")
            assignment = (node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1
                          else node.target if native and isinstance(node, ast.AnnAssign) else None)
            if isinstance(assignment, ast.Name):
                name = assignment.id
                if name in COMMANDS or (native and name in ("robot", "start")):
                    fail(node, "Choose a different variable name.")
                if node.value is None:
                    fail(node, "Give the typed variable a starting number.")
                number = value(node.value)
                if isinstance(node, ast.AnnAssign):
                    if not isinstance(node.annotation, ast.Name) or node.annotation.id not in ("int", "float"):
                        fail(node, "Use int or float for a numeric variable's type hint.")
                    if node.annotation.id == "int" and type(number) is not int:
                        fail(node, "An int variable needs a whole number.")
                variables[name] = number
                continue
            if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and not node.orelse:
                if node.target.id in COMMANDS or (native and node.target.id in ("robot", "start")):
                    fail(node, "Choose a different loop variable.")
                call = node.iter
                if (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "range"
                        and len(call.args) == 1 and not call.keywords):
                    count = value(call.args[0])
                    if type(count) is int and 0 <= count <= 32:
                        for index in range(count):
                            variables[node.target.id] = index
                            visit(node.body)
                        continue
                fail(node, "Use for name in range(N): with an integer from 0 to 32.")
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                call = node.value
                if native and method_call(call, "send_action"):
                    send_action(call)
                    continue
                if not native and isinstance(call.func, ast.Name) and not call.keywords:
                    if call.func.id == "grip" and len(call.args) == 1:
                        add_step(call, target_for(call, "gripper", "position_pct", value(call.args[0])))
                        continue
                    if call.func.id == "move" and len(call.args) == 2:
                        joint = call.args[0]
                        if (isinstance(joint, ast.Constant) and isinstance(joint.value, str)
                                and joint.value in MODEL_LIMITS and joint.value != "gripper"):
                            add_step(call, target_for(call, joint.value, "offset_deg", value(call.args[1])))
                            continue
                        fail(call, "Use a quoted arm joint name. Use grip() for the gripper.")
            commands = "robot.send_action()" if native else "move() or grip()"
            fail(node, f"Use {commands}, a numeric assignment, or a for/range loop.")

    if native:
        function = tree.body[0]
        arguments = function.args
        if (function.decorator_list or [arg.arg for arg in arguments.args] != ["robot"]
                or arguments.posonlyargs or arguments.kwonlyargs or arguments.defaults
                or arguments.vararg or arguments.kwarg):
            fail(function, "Define one function with the argument robot.")
        first, *body = function.body
        has_start = (isinstance(first, ast.Assign) and len(first.targets) == 1
                     and isinstance(first.targets[0], ast.Name) and first.targets[0].id == "start"
                     and method_call(first.value, "get_observation") and not first.value.args)
        visit(body if has_start else function.body)
    else:
        visit(tree.body)
    if not steps:
        raise ValueError("Add at least one arm action.")
    route = {"schema": DRAFT, "steps": steps}
    if native:
        route["coordinates"] = "lerobot"
    return route
