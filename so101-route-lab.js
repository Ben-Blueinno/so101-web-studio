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
const LIBRARY_KEY = "so101-route-lab:move-sets:v1";
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
function cameraMatrix(yaw, pitch, aspect) {
  const target = [0.13, 0, 0.10];
  const back = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch)];
  const eye = target.map((value, i) => value + 0.64 * back[i]);
  const right = normalize(cross([0, 0, 1], back)), up = cross(back, right);
  const view = [
    right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ];
  const f = 1 / Math.tan(21 * DEGREES), near = 0.02, far = 3;
  return multiply([f/aspect,0,0,0, 0,f,0,0, 0,0,(near+far)/(near-far),-1,
    0,0,2*near*far/(near-far),0], view);
}

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
  const root = transform([0,0,0], [0,0,0]);
  // Each SO-101 servo is mounted on the parent link of the joint it drives.
  const motorLinks = Object.fromEntries(model.joints.map(([joint, parent]) => [joint, parent]));
  let yaw = -1.05, pitch = 0.47, pose = {}, pointer, activeMotor;
  function part([buffer, length], matrix, tint) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(positions, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(normals, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(world, false, matrix);
    gl.uniform3fv(color, tint);
    gl.drawArrays(gl.TRIANGLES, 0, length);
  }
  function render(offsets, motor) {
    if (offsets !== undefined) {
      pose = offsets;
      activeMotor = motor;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.062, 0.11, 0.115, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(camera, false, cameraMatrix(yaw, pitch, canvas.width / canvas.height));
    part(bench, transform([0,0,-0.008], [0,0,0]), [0.13,0.21,0.22]);
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
        const tint = highlighted ? highlight : isServo ? [0.39,0.45,0.48] : [0.48,0.91,0.77];
        part(meshes[mesh], multiply(frames[link], transform(xyz, rpy)), tint);
      }
    }
  }
  function orbit(dx, dy) {
    yaw -= dx;
    pitch = Math.max(-0.25, Math.min(1.35, pitch + dy));
    render();
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
  if (resetButton) resetButton.onclick = () => { yaw = -1.05; pitch = .47; render(); };
  render();
  return render;
}

function setupRoute(render) {
  const list = get("steps"), status = get("status"), download = get("export");
  let token = 0, previewed;
  const report = message => { status.textContent = message; };
  function stop(message) {
    token++;
    previewed = undefined;
    download.disabled = true;
    get("stop").disabled = true;
    for (const row of list.children) row.classList.remove("active");
    render({});
    report(message);
  }
  function updateRows() {
    [...list.children].forEach((row, i) => {
      row.firstChild.textContent = i + 1;
      row.querySelector("select").setAttribute("aria-label", `Joint for step ${i + 1}`);
      const input = row.querySelector("input");
      input.id = `target-${i + 1}`;
      row.querySelector("small").id = `range-${i + 1}`;
      input.setAttribute("aria-describedby", `range-${i + 1}`);
      const gripper = row.querySelector("select").value === "gripper";
      input.setAttribute("aria-label", `${gripper ? "Gripper travel percent" : "Degrees"} for step ${i + 1}`);
      const remove = row.querySelector("button");
      remove.setAttribute("aria-label", `Remove step ${i + 1}`);
      remove.disabled = list.children.length === 1;
    });
    get("add").disabled = list.children.length >= 32;
  }
  function add(joint, angle) {
    const row = document.createElement("li");
    row.className = "row";
    const index = document.createElement("span");
    const select = document.createElement("select");
    for (const [key, label] of Object.entries(JOINTS)) select.add(new Option(label, key));
    select.value = joint;
    const offset = document.createElement("input");
    const hint = document.createElement("small");
    offset.type = "number";
    offset.step = "any"; offset.required = true;
    offset.value = angle;
    function updateLimit() {
      const [low, high] = LIMITS[select.value];
      const unit = select.value === "gripper" ? "% travel" : "° from start";
      offset.min = low;
      offset.max = high;
      hint.textContent = `${low} to ${high} ${unit}`;
    }
    updateLimit();
    let lastJoint = joint;
    select.onchange = () => {
      if (field(lastJoint) !== field(select.value)) {
        offset.value = select.value === "gripper" ? Math.round(GRIP_HOME) : 0;
      }
      lastJoint = select.value;
      updateLimit();
      updateRows();
      stop("Route changed. Run the preview again.");
    };
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "×";
    remove.onclick = () => { row.remove(); updateRows(); stop("Route changed. Run the preview again."); };
    row.append(index, select, offset, remove, hint);
    list.append(row);
    updateRows();
    return select;
  }
  for (const [joint, angle] of [
    ["shoulder_pan", 5], ["shoulder_lift", -5], ["elbow_flex", 7],
    ["elbow_flex", 0], ["shoulder_lift", 0], ["shoulder_pan", 0],
  ]) add(joint, angle);
  get("add").onclick = () => {
    add("wrist_flex", 0).focus();
    stop("Step added. Run the preview again.");
  };
  get("route").addEventListener("input", () => stop("Route changed. Run the preview again."));
  get("stop").onclick = () => stop("Preview stopped. Run the route to export.");
  function readSteps() {
    return [...list.children].map(row => {
      const joint = row.querySelector("select").value;
      return {joint, [field(joint)]: row.querySelector("input").valueAsNumber};
    });
  }
  get("route").onsubmit = event => {
    event.preventDefault();
    const rows = [...list.children], steps = readSteps();
    try {
      validateRoute({schema: V2, steps});
    } catch (error) {
      report(error.message);
      return;
    }
    stop("Starting preview.");
    get("stop").disabled = false;
    const currentToken = token;
    const pose = {};
    let i = 0;
    function runStep() {
      if (currentToken !== token) return;
      if (i === steps.length) {
        render(pose);
        previewed = steps;
        get("stop").disabled = true;
        download.disabled = false;
        report("Route complete. Download it for the teacher station.");
        return;
      }
      const row = rows[i], {joint} = steps[i], target = steps[i][field(joint)];
      const from = pose[joint] ?? (joint === "gripper" ? GRIP_HOME : 0);
      const duration = Math.max(550, Math.min(2700, Math.abs(target - from) * 85));
      row.classList.add("active");
      report(`Step ${i + 1} of ${steps.length} · ${JOINTS[joint]} to ${target}${joint === "gripper" ? "%" : "°"}`);
      let start;
      function frame(now) {
        if (currentToken !== token) return;
        start ??= now;
        const fraction = Math.min(1, (now - start) / duration);
        pose[joint] = from + (target - from) * fraction;
        render(pose, {joint, mode: "simulation"});
        if (fraction < 1) {
          requestAnimationFrame(frame);
        } else {
          row.classList.remove("active");
          i++;
          runStep();
        }
      }
      requestAnimationFrame(frame);
    }
    runStep();
  };
  const fileStatus = get("file-status"), file = get("route-file"), name = get("route-name");
  const saved = get("saved-routes");
  function readLibrary() {
    const drafts = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]");
    if (!Array.isArray(drafts) || drafts.some(item => typeof item?.name !== "string")) {
      throw new Error("Saved move sets could not be read.");
    }
    return drafts;
  }
  function refreshLibrary(selection = "") {
    const drafts = readLibrary();
    saved.replaceChildren(new Option(drafts.length ? "Choose a move set…" : "No move sets saved", ""));
    for (const {name: title} of drafts) saved.add(new Option(title, title));
    saved.value = selection;
    get("load-saved").disabled = get("delete-saved").disabled = !saved.value;
  }
  saved.onchange = () => { get("load-saved").disabled = get("delete-saved").disabled = !saved.value; };
  function libraryAction(action) {
    return () => {
      try {
        action();
      } catch (error) {
        fileStatus.textContent = `${error.message} You can use Download draft and Import JSON as a backup.`;
      }
    };
  }
  function openDraft(route, title) {
    const steps = validateRoute(route);
    list.replaceChildren();
    for (const step of steps) add(step.joint, step[field(step.joint)]);
    name.value = title.slice(0, 60);
    stop("Move set opened. Run the route when ready.");
    fileStatus.textContent = `Opened ${steps.length} steps from ${title}.`;
  }
  function save(steps, draft = false) {
    const route = {schema: draft ? DRAFT : V2, steps};
    const blob = new Blob([JSON.stringify(route, null, 2) + "\n"], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const base = name.value.trim().replace(/\.json$/i, "").replace(/-draft$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-") || "so101-route";
    link.download = base + (draft ? "-draft.json" : ".json");
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  download.onclick = () => { if (previewed) save(previewed); };
  get("save").onclick = libraryAction(() => {
    if (!get("route").reportValidity()) return;
    const title = name.value.trim();
    if (!title) throw new Error("Enter a move set name first.");
    const steps = validateRoute({schema: DRAFT, steps: readSteps()});
    const drafts = readLibrary();
    const index = drafts.findIndex(item => item.name === title);
    if (index !== -1 && !window.confirm(`Replace the saved move set “${title}”?`)) return;
    if (index === -1 && drafts.length >= 100) throw new Error("The browser library is full (100 move sets).");
    const entry = {name: title, schema: DRAFT, steps};
    if (index === -1) drafts.push(entry);
    else drafts[index] = entry;
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(drafts));
    refreshLibrary(title);
    fileStatus.textContent = `Saved “${title}” in this browser.`;
  });
  get("backup").onclick = libraryAction(() => {
    if (!get("route").reportValidity()) return;
    save(validateRoute({schema: DRAFT, steps: readSteps()}), true);
    fileStatus.textContent = "Draft ready to download.";
  });
  get("load-saved").onclick = libraryAction(() => {
    const entry = readLibrary().find(item => item.name === saved.value);
    if (!entry) throw new Error("Choose a saved move set.");
    openDraft(entry, entry.name);
  });
  get("delete-saved").onclick = libraryAction(() => {
    const title = saved.value;
    if (!title || !window.confirm(`Delete “${title}” from this browser?`)) return;
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(readLibrary().filter(item => item.name !== title)));
    refreshLibrary();
    fileStatus.textContent = `Removed “${title}” from the library. The current editor is unchanged.`;
  });
  window.addEventListener("storage", libraryAction(() => refreshLibrary(saved.value)));
  libraryAction(() => refreshLibrary())();
  get("open").onclick = () => file.click();
  file.onchange = async () => {
    const selected = file.files[0];
    file.value = "";
    if (!selected) return;
    try {
      if (selected.size > 8192) throw new Error("Route file is too large.");
      const draft = JSON.parse((await selected.text()).replace(/^\uFEFF/, ""));
      const title = selected.name.replace(/(?:-draft)?\.json$/i, "");
      openDraft(draft, title);
      fileStatus.textContent += " Select Save in browser to keep it here.";
    } catch (error) {
      fileStatus.textContent = `Could not open move set: ${error.message}`;
    }
  };
  if (location.hash.startsWith("#program=")) {
    try {
      const payload = location.hash.slice("#program=".length);
      if (payload.length > 8192) throw new Error("Program preview is too large.");
      openDraft(JSON.parse(decodeURIComponent(payload)), "python-route");
      report("Python route loaded. Select Run route to preview your program.");
    } catch (error) {
      fileStatus.textContent = `Could not load the Python route: ${error.message}`;
    }
  }
}

if (get("route")) try {
  setupRoute(createViewer(get("viewer"), SO101_MODEL));
} catch (error) {
  get("run").disabled = true;
  get("add").disabled = true;
  get("save").disabled = true;
  get("backup").disabled = true;
  get("open").disabled = true;
  get("status").classList.add("error");
  get("status").textContent = error.message;
}
