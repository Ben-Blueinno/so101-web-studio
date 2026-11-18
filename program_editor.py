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

    def add(call, joint, field, amount):
        low, high = (-360, 360) if native and joint != "gripper" else MODEL_LIMITS[joint]
        if not low <= amount <= high:
            fail(call, f"{joint} must be between {low:g} and {high:g}.")
        if len(steps) >= 32:
            fail(call, "A route can have up to 32 moves.")
        steps.append({"joint": joint, field: amount})

    def method_call(call, method):
        return (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and isinstance(call.func.value, ast.Name) and call.func.value.id == "robot"
                and call.func.attr == method and not call.keywords)

    def baseline(node, key):
        return (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
                and node.value.id == "start" and isinstance(node.slice, ast.Constant)
                and node.slice.value == key)

    def send_action(call):
        if len(call.args) != 1 or not isinstance(call.args[0], ast.Dict) or len(call.args[0].keys) != 1:
            fail(call, "Use one joint per robot.send_action({...}) call.")
        action = call.args[0]
        key, target = action.keys[0], action.values[0]
        if not isinstance(key, ast.Constant) or not isinstance(key.value, str) or not key.value.endswith(".pos"):
            fail(call, 'Use a LeRobot action key like "shoulder_pan.pos".')
        joint = key.value.removesuffix(".pos")
        if joint not in MODEL_LIMITS:
            fail(call, f"Unknown SO-101 joint {joint!r}.")
        if joint == "gripper":
            add(call, joint, "position_pct", value(target))
        elif baseline(target, key.value):
            add(call, joint, "offset_deg", 0)
        elif (isinstance(target, ast.BinOp) and isinstance(target.op, (ast.Add, ast.Sub))
              and baseline(target.left, key.value)):
            delta = value(target.right)
            add(call, joint, "offset_deg", -delta if isinstance(target.op, ast.Sub) else delta)
        else:
            fail(call, f'Use start[{key.value!r}] plus or minus an offset in degrees.')

    def visit(body):
        nonlocal budget
        for node in body:
            budget -= 1
            if budget < 0:
                fail(node, "The program does too many operations.")
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                if name in COMMANDS or (native and name in ("robot", "start")):
                    fail(node, "Choose a different variable name.")
                variables[name] = value(node.value)
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
                        add(call, "gripper", "position_pct", value(call.args[0]))
                        continue
                    if call.func.id == "move" and len(call.args) == 2:
                        joint = call.args[0]
                        if (isinstance(joint, ast.Constant) and isinstance(joint.value, str)
                                and joint.value in MODEL_LIMITS and joint.value != "gripper"):
                            add(call, joint.value, "offset_deg", value(call.args[1]))
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
        if (not isinstance(first, ast.Assign) or len(first.targets) != 1
                or not isinstance(first.targets[0], ast.Name) or first.targets[0].id != "start"
                or not method_call(first.value, "get_observation") or first.value.args):
            fail(first, "Start the function with start = robot.get_observation().")
        visit(body)
    else:
        visit(tree.body)
    if not steps:
        raise ValueError("Add at least one arm action.")
    route = {"schema": DRAFT, "steps": steps}
    if native:
        route["coordinates"] = "lerobot"
    return route
