"use strict";

const JOINTS = {
  shoulder_pan: "Shoulder pan",
  shoulder_lift: "Shoulder lift",
  elbow_flex: "Elbow flex",
  wrist_flex: "Wrist flex",
  wrist_roll: "Wrist roll",
  gripper: "Gripper",
};
const DEGREES = Math.PI / 180;
const {home: HOME, limits: LIMITS, gripperAngles: [GRIP_MIN, GRIP_MAX]} = SO101_ROUTE_SETTINGS;
const GRIP_HOME = (HOME.gripper - GRIP_MIN) / (GRIP_MAX - GRIP_MIN) * 100;
const V1 = "so101-tabletop-route-v1", V2 = "so101-tabletop-route-v2";
const DRAFT = "so101-tabletop-move-set-v1";
const get = id => document.getElementById(id);
const field = joint => joint === "gripper" ? "position_pct" : "offset_deg";
const routeActions = step => step.actions ?? [step];

function validateRoute(route, {grouped = false} = {}) {
  if (![V1, V2, DRAFT].includes(route?.schema) || !Array.isArray(route.steps)
      || route.steps.length < 1 || route.steps.length > 32) {
    throw new Error("Choose an SO-101 route file with 1 to 32 steps.");
  }
  route.steps.forEach((group, i) => {
    const actions = grouped ? routeActions(group) : [group];
    if (!Array.isArray(actions) || !actions.length || actions.length > 6 ||
        new Set(actions.map(action => action?.joint)).size !== actions.length) {
      throw new Error(`Step ${i + 1}: choose up to six different joints.`);
    }
    for (const step of actions) {
      const joint = step?.joint, key = field(joint);
      if (typeof joint !== "string" || !Object.hasOwn(JOINTS, joint)
          || Object.keys(step).length !== 2 || (route.schema === V1 && joint === "gripper")) {
        throw new Error(`Step ${i + 1}: choose a listed joint and its matching unit.`);
      }
      const value = step[key], [low, high] = route.schema === V1 ? [-15, 15] : LIMITS[joint];
      if (!Number.isFinite(value) || value < low || value > high) {
        throw new Error(`Step ${i + 1}: ${JOINTS[joint]} must be between ${low} and ${high}.`);
      }
    }
  });
  return route.steps;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const normalize = v => v.map(value => value / Math.hypot(...v));
function multiply(a, b) {
  return Array.from({length: 16}, (_, i) => {
    const row = i % 4, col = i - row;
    return a[row] * b[col] + a[4 + row] * b[col + 1] + a[8 + row] * b[col + 2] + a[12 + row] * b[col + 3];
  });
}
function rotate(axis, angle) {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [c+x*x*t, y*x*t+z*s, z*x*t-y*s, 0, x*y*t-z*s, c+y*y*t, z*y*t+x*s, 0,
          x*z*t+y*s, y*z*t-x*s, c+z*z*t, 0, 0, 0, 0, 1];
}
function transform(xyz, [r, p, y]) {
  const matrix = multiply(multiply(rotate([0, 0, 1], y), rotate([0, 1, 0], p)), rotate([1, 0, 0], r));
  matrix.splice(12, 3, ...xyz);
  return matrix;
}
function cameraMatrix(yaw, pitch, aspect, {target, distance}) {
  const back = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const eye = target.map((value, i) => value + distance * back[i]);
  const right = normalize(cross([0, 0, 1], back)), up = cross(back, right);
  const view = [
    right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ];
  const f = 1 / Math.tan(21 * DEGREES), near = 0.02, far = 3;
  return multiply([f/aspect,0,0,0, 0,f,0,0, 0,0,(near+far)/(near-far),-1,
    0,0,2*near*far/(near-far),0], view);
}

const singleView = {yaw: -1.05, target: [0.13, 0, 0.10], distance: 0.64};
const dualView = {yaw: 0.6, target: [0, 0, 0.12], distance: 0.78};
// XLeRobot de51ed34cfe29ba1ca6d910a8e656fff6fd949ae
// simulation/Maniskill/assets/xlerobot/xlerobot.urdf, arm_base_joint[_2].
// Bring the common 0.760 m mounting plane to tabletop height. The reference
// arm's pan offset points along -Y, while our SO-101's points along +X.
// Its +90-degree mounting yaw therefore corresponds to zero yaw here.
// A uses the robot's right mount (-Y), and B uses its left mount (+Y).
const xleRobotMounts = {
  A: {position: [-0.135, -0.133, 0], yaw: 0, tint: [0.48, 0.91, 0.77]},
  B: {position: [-0.135, 0.133, 0], yaw: 0, tint: [0.56, 0.71, 0.99]},
};

function createViewer(canvas, model, resetButton = get("camera")) {
  const gl = canvas.getContext("webgl", {antialias: true});
  if (!gl) throw new Error("3D is unavailable. Try Chrome, Edge, or Safari with graphics acceleration.");
  function shader(kind, source) {
    const result = gl.createShader(kind);
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
    return result;
  }
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute vec3 position, normal;
    uniform mat4 world, camera;
    varying vec3 surfaceNormal;
    void main() {
      gl_Position = camera * world * vec4(position, 1.0);
      surfaceNormal = mat3(world) * normal;
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec3 color;
    varying vec3 surfaceNormal;
    void main() {
      vec3 n = normalize(surfaceNormal);
      float light = 0.46 + 0.54 * max(dot(n, normalize(vec3(0.2, -0.5, 1.0))), 0.0);
      gl_FragColor = vec4(color * light, 1.0);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  const positions = gl.getAttribLocation(program, "position"), normals = gl.getAttribLocation(program, "normal");
  const world = gl.getUniformLocation(program, "world"), camera = gl.getUniformLocation(program, "camera");
  const color = gl.getUniformLocation(program, "color");
  gl.enableVertexAttribArray(positions);
  gl.enableVertexAttribArray(normals);

  function upload(triangles) {
    const data = new Float32Array(triangles.length * 2);
    for (let i = 0; i < triangles.length; i += 9) {
      const a = triangles.slice(i, i+3), b = triangles.slice(i+3, i+6), c = triangles.slice(i+6, i+9);
      const face = cross(subtract(b, a), subtract(c, a));
      const normal = Math.hypot(...face) ? normalize(face) : [0, 0, 1];
      for (let j = 0; j < 3; j++) {
        data.set(triangles.slice(i+j*3, i+j*3+3), i*2+j*6);
        data.set(normal, i*2+j*6+3);
      }
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return [buffer, triangles.length / 3];
  }
  const meshes = Object.fromEntries(Object.entries(model.meshes).map(([key, packed]) => {
    const bytes = Uint8Array.from(atob(packed), letter => letter.charCodeAt(0));
    const raw = new DataView(bytes.buffer);
    const points = Array.from({length: bytes.length / 2}, (_, i) => raw.getInt16(i * 2, true) * model.meshUnit);
    return [key, upload(points)];
  }));
  const bench = upload([-.19,-.23,0, .47,-.23,0, .47,.23,0, -.19,-.23,0, .47,.23,0, -.19,.23,0]);
  const wideBench = upload([-.30,-.34,0, .42,-.34,0, .42,.34,0, -.30,-.34,0, .42,.34,0, -.30,.34,0]);
  const root = transform([0,0,0], [0,0,0]);
  const mounts = Object.fromEntries(Object.entries(xleRobotMounts).map(([key, {position, yaw}]) =>
    [key, transform(position, [0, 0, yaw])]));
  // Each SO-101 servo is mounted on the parent link of the joint it drives.
  const motorLinks = Object.fromEntries(model.joints.map(([joint, parent]) => [joint, parent]));
  let view = singleView, yaw = view.yaw, pitch = 0.47, pointer, instances = [{}];
  function part([buffer, length], matrix, tint) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(positions, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(normals, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(world, false, matrix);
    gl.uniform3fv(color, tint);
    gl.drawArrays(gl.TRIANGLES, 0, length);
  }
  function drawArm(pose, activeMotor, root, bodyTint) {
    const frames = {base_link: root};
    for (const [name, parent, child, xyz, rpy, axis] of model.joints) {
      const angle = name === "gripper"
        ? GRIP_MIN + (pose[name] ?? GRIP_HOME) / 100 * (GRIP_MAX - GRIP_MIN)
        : (HOME[name] ?? 0) + (pose[name] ?? 0) * DEGREES;
      frames[child] = multiply(multiply(frames[parent], transform(xyz, rpy)), rotate(axis, angle));
    }
    for (const [link, visuals] of Object.entries(model.links)) {
      for (const [mesh, xyz, rpy, material] of visuals) {
        const isServo = material === "sts3215";
        const highlighted = isServo && (activeMotor?.joints ?? [activeMotor?.joint])
          .some(joint => link === motorLinks[joint]);
        const highlight = activeMotor?.mode === "physical" ? [0.25,0.80,1] : [1,0.74,0.20];
        const tint = highlighted ? highlight : isServo ? [0.39,0.45,0.48] : bodyTint;
        part(meshes[mesh], multiply(frames[link], transform(xyz, rpy)), tint);
      }
    }
  }
  function drawFrame() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.062, 0.11, 0.115, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const matrix = cameraMatrix(yaw, pitch, canvas.width / canvas.height, view);
    gl.uniformMatrix4fv(camera, false, matrix);
    part(view === dualView ? wideBench : bench, transform([0,0,-0.008], [0,0,0]), [0.13,0.21,0.22]);
    for (const {label, pose = {}, motor, badge} of instances) {
      const mount = view === dualView ? xleRobotMounts[label] : undefined;
      drawArm(pose, motor, mount ? mounts[label] : root, mount?.tint ?? xleRobotMounts.A.tint);
      if (badge) {
        const point = mount?.position ?? [0, 0, 0];
        const [x, y, , w] = [0, 1, 2, 3].map(row =>
          matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 12]);
        badge.hidden = false;
        badge.style.left = (50 + 50 * x / w) + "%";
        badge.style.top = (50 - 50 * y / w) + "%";
      }
    }
  }
  function render(offsets, motor) {
    render.scene([{pose: offsets, motor}]);
  }
  function resetView() {
    yaw = view.yaw;
    pitch = .47;
    drawFrame();
  }
  render.scene = next => {
    const nextView = next.length === 2 ? dualView : singleView;
    instances = next;
    if (nextView === view) drawFrame();
    else {
      view = nextView;
      resetView();
    }
  };
  function orbit(dx, dy) {
    yaw -= dx;
    pitch = Math.max(-0.25, Math.min(1.35, pitch + dy));
    drawFrame();
  }
  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture(event.pointerId);
    pointer = [event.clientX, event.clientY];
  });
  canvas.addEventListener("pointermove", event => {
    if (!pointer) return;
    orbit((event.clientX - pointer[0]) * 0.009, (event.clientY - pointer[1]) * 0.009);
    pointer = [event.clientX, event.clientY];
  });
  canvas.addEventListener("lostpointercapture", () => { pointer = undefined; });
  canvas.addEventListener("keydown", event => {
    const moves = {ArrowLeft: [-.12,0], ArrowRight: [.12,0], ArrowUp: [0,.12], ArrowDown: [0,-.12]};
    if (!moves[event.key]) return;
    event.preventDefault();
    orbit(...moves[event.key]);
  });
  if (resetButton) resetButton.onclick = resetView;
  drawFrame();
  return render;
}
