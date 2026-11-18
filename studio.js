"use strict";

const code = get("code");
const key = "so101-web-studio:programs:v1";
const programStatus = get("program-status");
const armStatus = get("arm-status");
const settingsStatus = get("settings-status");
const previewStatus = get("preview-status");
const stepStatus = get("step-status");
const motorStatus = get("active-motor");
const programLibrary = get("program-library");
const calibrationLibrary = get("cal-library");
let render, initialized, currentStep, previewId;
let animation = 0, settings, moving = false, calibrating = false, actionPending = false;
let compiling = false;
let simulating = false;
let returningToRest = false;

async function api(action, data = {}) {
  return hostedArm.request(action, data);
}

function hook(id, fn, status = programStatus) {
  get(id).onclick = async () => {
    try {
      await fn();
    } catch (error) {
      status.textContent = error.message;
    }
  };
}

function confirmAction(message) {
  const dialog = get("confirm-dialog");
  dialog.returnValue = "";
  get("confirm-message").textContent = message;
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {once: true});
    dialog.showModal();
  });
}

function selectView(view) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const current = button.dataset.view === view;
    get(button.dataset.view).hidden = !current;
    button.setAttribute("aria-pressed", current);
  }
}

for (const button of document.querySelectorAll("[data-view]")) {
  button.onclick = () => selectView(button.dataset.view);
}

function updateControls() {
  get("deploy").disabled = !initialized || !previewId || Boolean(currentStep) || moving || actionPending;
  get("preview").disabled = !render || compiling || moving || Boolean(currentStep) || actionPending;
  get("move").disabled = moving || !currentStep;
  get("stop-motion").disabled = !moving;
  get("discard").disabled = moving || !currentStep;
  get("init").disabled = Boolean(initialized) || calibrating || actionPending;
  get("read-pose").disabled = !initialized || moving || Boolean(currentStep) || actionPending;
  get("disconnect").disabled = !initialized || moving || actionPending;
  for (const id of ["save-rest", "return-rest"]) {
    get(id).disabled = !initialized || moving || Boolean(currentStep) || actionPending;
  }
  get("stop-rest").hidden = !returningToRest;
  for (const id of ["cal-read", "cal-apply", "cal-start", "arm-profile"]) {
    get(id).disabled = Boolean(initialized) || calibrating || actionPending;
  }
  code.readOnly = Boolean(currentStep) || actionPending;
  const bridge = hostedArm.mode === "bridge";
  const paired = Boolean(hostedArm.mode);
  const blocked = paired || actionPending || compiling || simulating;
  get("connect-usb").disabled = blocked || !hostedArm.supportsUSB;
  get("pair-bridge").disabled = blocked;
  get("init").disabled ||= !bridge;
  get("cal-read").disabled ||= !paired && !hostedArm.supportsUSB;
  get("cal-apply").disabled ||= !bridge;
  get("cal-start").disabled ||= !bridge;
  get("scan").disabled = !bridge;
}

function drawPose(pose, joint, mode) {
  if (render) render(pose, joint ? {joint, mode} : undefined);
  motorStatus.hidden = !joint;
  motorStatus.dataset.mode = mode ?? "";
  motorStatus.textContent = joint ? `${mode === "physical" ? "Physical move" : "Simulation"} · ${JOINTS[joint]}` : "";
}

function resetPreview(resetModel = true) {
  animation++;
  simulating = false;
  previewId = undefined;
  get("stop-preview").disabled = true;
  if (resetModel) drawPose(initialized?.model_pose ?? {});
  updateControls();
}

code.oninput = () => {
  resetPreview();
  get("export-code").hidden = true;
  get("copy-function").disabled = get("download-function").disabled = true;
  previewStatus.textContent = "Program changed. Preview the current version.";
};
code.onkeydown = event => {
  if (event.key !== "Tab" || event.shiftKey || code.readOnly) return;
  event.preventDefault();
  code.setRangeText("    ", code.selectionStart, code.selectionEnd, "end");
  code.dispatchEvent(new Event("input"));
};

function animate(route, id) {
  const generation = animation;
  simulating = true;
  const start = initialized?.preview_start ?? {};
  const pose = {...start};
  drawPose(pose);
  get("stop-preview").disabled = false;
  function next(index) {
    if (generation !== animation) return;
    if (index === route.steps.length) {
      simulating = false;
      drawPose(initialized?.model_pose ?? pose);
      previewId = id;
      get("stop-preview").disabled = true;
      previewStatus.textContent = initialized ? "Preview complete. Prepare deployment to review each move." : "Preview complete.";
      updateControls();
      return;
    }
    const {joint, [field(route.steps[index].joint)]: target} = route.steps[index];
    const isGripper = joint === "gripper";
    const end = isGripper ? target : (start[joint] ?? 0) + target;
    const from = pose[joint] ?? (isGripper ? GRIP_HOME : 0);
    const duration = Math.max(550, Math.min(2700, Math.abs(end - from) * 85));
    let started;
    drawPose(pose, joint, "simulation");
    previewStatus.textContent = `Step ${index + 1}/${route.steps.length} · ${JOINTS[joint]} to ${target}${isGripper ? "%" : "°"}`;
    function frame(now) {
      if (generation !== animation) return;
      started ??= now;
      const progress = Math.min(1, (now - started) / duration);
      pose[joint] = from + (end - from) * progress;
      render(pose, {joint, mode: "simulation"});
      if (progress === 1) next(index + 1);
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  next(0);
}

hook("preview", async () => {
  if (currentStep) return;
  resetPreview();
  compiling = true;
  updateControls();
  const version = animation;
  try {
    if (initialized) connected(await api("read-pose"));
    const result = await api("compile", {source: code.value, label: get("arm-profile").value});
    if (version !== animation) return;
    programStatus.textContent = `Validated ${result.route.steps.length} moves.`;
    animate(result.route, result.preview_id);
  } finally {
    compiling = false;
    updateControls();
  }
});
hook("stop-preview", () => {
  resetPreview();
  previewStatus.textContent = "Preview stopped.";
});

function showStep(step) {
  currentStep = step?.plan_id ? step : undefined;
  get("replay").hidden = !step;
  if (currentStep) {
    const unit = step.joint === "gripper" ? "%" : "°";
    stepStatus.textContent = `Step ${step.index + 1}/${step.count} · ${JOINTS[step.joint]} → ${step.target.toFixed(2)}${unit} on follower ${initialized.label}. Select Confirm and move this step to send the command.`;
  } else if (step?.done) {
    stepStatus.textContent = "Deployment complete.";
  }
  updateControls();
}

hook("deploy", async () => {
  actionPending = true;
  updateControls();
  try {
    get("move-result").textContent = "";
    showStep(await api("deploy", {preview_id: previewId}));
  } finally {
    actionPending = false;
    updateControls();
  }
});

hook("move", async () => {
  const reviewed = currentStep;
  if (!reviewed) return;
  actionPending = true;
  updateControls();
  try {
    const {plan_id, index, joint, target} = reviewed;
    const unit = joint === "gripper" ? "%" : "°";
    if (!await confirmAction(`Follower ${initialized.label} will move ${JOINTS[joint]} to ${target.toFixed(2)}${unit}. Confirm the path is clear.`)) return;
    moving = true;
    updateControls();
    drawPose(initialized.model_pose, joint, "physical");
    const response = await api("move", {plan_id, index});
    connected(response.arm);
    drawPose(response.arm.model_pose);
    const result = response.result;
    const moved = Math.abs(result.measured - result.before) > 0.001;
    get("move-result").textContent = `Step ${result.index + 1} · ${JOINTS[result.joint]} · measured ${result.before.toFixed(2)}${unit} → ${result.measured.toFixed(2)}${unit}. Target ${result.target.toFixed(2)}${unit}.`
      + (moved ? "" : " No change in the encoder reading. The joint was within tolerance.");
    showStep(response);
  } catch (error) {
    drawPose(initialized?.model_pose ?? {});
    showStep({});
    stepStatus.textContent = error.message;
  } finally {
    moving = false;
    actionPending = false;
    updateControls();
  }
}, stepStatus);

hook("stop-motion", async () => {
  await api("stop");
  stepStatus.textContent = "Stop requested. The arm can retain torque.";
}, stepStatus);

hook("discard", async () => {
  await api("discard");
  showStep();
  programStatus.textContent = "Remaining steps discarded.";
});

function listing() {
  return JSON.parse(localStorage.getItem(key) || "[]");
}
function listPrograms(selected = "") {
  programLibrary.replaceChildren(new Option("Saved programs…", ""));
  for (const item of listing()) programLibrary.add(new Option(item.name, item.name));
  programLibrary.value = selected;
}
hook("program-save", async () => {
  const name = get("program-name").value.trim();
  if (!name) throw new Error("Enter a program name.");
  const programs = listing();
  const existing = programs.findIndex(item => item.name === name);
  if (existing >= 0 && !await confirmAction(`Replace “${name}”?`)) return;
  if (existing >= 0) programs[existing].text = code.value;
  else programs.push({name, text: code.value});
  localStorage.setItem(key, JSON.stringify(programs));
  listPrograms(name);
  programStatus.textContent = `Saved “${name}” in this browser.`;
});
function openCode(text, name) {
  if (code.readOnly) throw new Error("Finish or discard the active deployment first.");
  code.value = text;
  get("program-name").value = name.slice(0, 60);
  code.dispatchEvent(new Event("input"));
}

hook("program-open", () => {
  const saved = listing().find(item => item.name === programLibrary.value);
  if (!saved) throw new Error("Choose a saved program.");
  openCode(saved.text, saved.name);
});
hook("program-delete", async () => {
  const name = programLibrary.value;
  if (!name || !await confirmAction(`Delete “${name}” from this browser?`)) return;
  localStorage.setItem(key, JSON.stringify(listing().filter(item => item.name !== name)));
  listPrograms();
});
function downloadPython(source, filename) {
  const url = URL.createObjectURL(new Blob([source], {type: "text/plain"}));
  const link = document.createElement("a");
  link.download = filename + ".py";
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
hook("program-download", () => {
  const filename = get("program-name").value.replace(/[^\w-]/g, "-") || "my-route";
  downloadPython(code.value, filename);
});
const exportStatus = get("export-status");
const exportCode = get("export-code");
hook("generate-function", async () => {
  const source = code.value;
  const {code: generated} = await api("export-lerobot", {source, label: get("arm-profile").value});
  if (source !== code.value) return;
  exportCode.value = generated;
  exportCode.hidden = false;
  get("copy-function").disabled = get("download-function").disabled = false;
  exportStatus.textContent = "Import run_route from the downloaded module and pass your connected follower.";
}, exportStatus);
hook("copy-function", async () => {
  try {
    await navigator.clipboard.writeText(exportCode.value);
    exportStatus.textContent = "Copied the LeRobot function and its route data.";
  } catch {
    exportCode.focus();
    exportCode.select();
    exportStatus.textContent = "Code selected. Copy it with Ctrl+C or Command+C.";
  }
}, exportStatus);
hook("download-function", () => {
  const filename = get("program-name").value.replace(/\W+/g, "_").replace(/^\d/, "_$&") || "my_route";
  downloadPython(exportCode.value, filename + "_lerobot");
}, exportStatus);
hook("program-import", () => get("program-file").click());
get("program-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 20000) throw new Error("This file is too large.");
    let text = await file.text();
    if (/\.json$/i.test(file.name)) {
      const steps = validateRoute(JSON.parse(text));
      text = steps.map(step => step.joint === "gripper" ? `grip(${step.position_pct})`
        : `move(${JSON.stringify(step.joint)}, ${step.offset_deg})`).join("\n") + "\n";
    }
    openCode(text, file.name.replace(/\.(py|json)$/i, ""));
  } catch (error) {
    programStatus.textContent = error.message;
  }
};

function connected(arm) {
  initialized = arm;
  get("connection").textContent = arm ? `Follower ${arm.label} initialized` : "Browser simulator";
  if (arm) get("arm-profile").value = arm.label;
  get("arm-sample").textContent = arm ? Object.entries(arm.pose).map(([name, value]) =>
    `${JOINTS[name.replace(".pos", "")]}: ${value.toFixed(2)}${name === "gripper.pos" ? "%" : "°"}`).join("\n") : "";
  updateControls();
}

async function pollLivePose() {
  const status = get("live-pose-status");
  try {
    if (initialized) {
      const previous = initialized;
      const result = await api("telemetry");
      if (initialized === previous && result.arm) {
        connected(result.arm);
        if (!simulating) drawPose(result.arm.model_pose, result.joint, "physical");
        status.hidden = simulating;
        const label = result.arm.at_rest ? "At rest" : "Away from rest";
        const source = result.live ? "Live encoder pose" : "Last measured pose";
        const message = `${source} · ${label}`;
        if (status.textContent !== message) status.textContent = message;
      }
    } else {
      status.hidden = true;
    }
  } catch (error) {
    status.hidden = false;
    status.textContent = "Live readings unavailable. Showing the last measured pose.";
  }
  setTimeout(pollLivePose, 300);
}
function armAction(id, fn) {
  hook(id, async () => {
    actionPending = true;
    updateControls();
    try {
      await fn();
    } finally {
      actionPending = false;
      updateControls();
    }
  }, armStatus);
}
const armLabel = () => ({label: get("arm-profile").value});
armAction("init", async () => {
  const result = await api("init", armLabel());
  connected(result);
  resetPreview();
  previewStatus.textContent = "Preview updated from the arm. Run your program from this pose.";
  armStatus.textContent = "Calibration matches. The current pose is the starting point for replay.";
});
armAction("read-pose", async () => {
  connected(await api("read-pose"));
  resetPreview();
  previewStatus.textContent = "Preview updated from the arm. Run your program from this pose.";
  armStatus.textContent = "Read all six joints and updated the 3D starting pose.";
});
armAction("save-rest", async () => {
  if (!await confirmAction("Save the current arm position as the rest pose for this follower?")) return;
  connected(await api("save-rest"));
  armStatus.textContent = "Saved the current position as rest for this follower.";
});
armAction("return-rest", async () => {
  const plan = await api("prepare-rest");
  connected(plan.arm);
  if (!plan.token) {
    armStatus.textContent = "The arm is already at rest.";
    return;
  }
  const order = plan.joints.map(joint => JOINTS[joint]).join(", ");
  if (!await confirmAction(`The arm will move to its rest pose, one joint at a time: ${order}. Confirm the entire path is clear before continuing.`)) {
    armStatus.textContent = "Return to rest cancelled.";
    return;
  }
  returningToRest = moving = true;
  resetPreview();
  armStatus.textContent = "Returning to rest…";
  try {
    connected(await api("return-rest", {token: plan.token}));
    drawPose(initialized.model_pose);
    armStatus.textContent = "The arm reached its rest pose. Preview your route again before deployment.";
  } finally {
    returningToRest = moving = false;
  }
});
hook("stop-rest", async () => {
  await api("stop");
  armStatus.textContent = "Stop requested.";
}, armStatus);
armAction("disconnect", async () => {
  if (!await confirmAction("Support the arm before disconnecting. Continue?")) return;
  await api("disconnect");
  connected();
  showStep();
  resetPreview();
  previewStatus.textContent = "Arm disconnected. The 3D model uses its reference pose.";
  get("arm-sample").textContent = "";
  armStatus.textContent = "Arm disconnected.";
  if (!hostedArm.mode) get("bridge-status").textContent = "";
});
armAction("cal-read", async () => {
  const result = await api("cal-read", armLabel());
  get("cal-name").value = result.name;
  get("cal-text").value = result.text;
  get("settings-profile").value = get("arm-profile").value;
  populateProfile();
  selectView("settings");
  settingsStatus.textContent = "Review the readback, then save it as a calibration copy if desired.";
});
armAction("cal-apply", async () => {
  if (!await confirmAction("Support the arm. Applying calibration releases torque. Proceed?")) return;
  armStatus.textContent = (await api("cal-apply", {...armLabel(), confirmed: true})).message;
});
armAction("cal-start", async () => {
  if (!await confirmAction("Support the arm. Calibration releases torque and requires moving the joints by hand. Proceed?")) return;
  await api("cal-start", {...armLabel(), confirmed: true});
  calibrating = true;
  updateControls();
  pollCalibration();
});
hook("cal-next", async () => {
  get("cal-next").disabled = true;
  await api("cal-next");
}, armStatus);
hook("cal-cancel", async () => {
  get("cal-cancel").disabled = true;
  await api("cal-cancel");
}, armStatus);

async function pollCalibration() {
  try {
    const {phase, message, sample} = await api("cal-status");
    armStatus.textContent = message;
    get("arm-sample").textContent = sample;
    calibrating = !["done", "error", "idle"].includes(phase);
    get("cal-controls").hidden = !calibrating;
    get("cal-next").textContent = phase === "range" ? "Save range" : "Capture midpoint";
    get("cal-next").disabled = !["midpoint", "range"].includes(phase);
    get("cal-cancel").disabled = !calibrating;
    updateControls();
  } catch (error) {
    armStatus.textContent = error.message;
  }
  if (calibrating) setTimeout(pollCalibration, 400);
}

const profileFields = {port: "profile-port", id: "profile-id", calibration_file: "profile-calibration"};
for (const [joint, name] of Object.entries(JOINTS)) {
  const id = "direction-" + joint;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = name + " direction";
  const select = document.createElement("select");
  select.id = id;
  select.add(new Option("Unverified", ""));
  select.add(new Option("Same (+1)", "1"));
  select.add(new Option("Reversed (−1)", "-1"));
  get("joint-fields").append(label, select);
  profileFields[joint] = id;
}
function populateProfile() {
  if (!settings) return;
  const profile = settings.profiles[get("settings-profile").value];
  for (const [fieldName, id] of Object.entries(profileFields)) get(id).value = profile[fieldName];
}
get("settings-profile").onchange = populateProfile;
function showSettings(data, selection = "") {
  settings = data;
  get("ports").replaceChildren(...data.ports.map(port => new Option(port)));
  calibrationLibrary.replaceChildren(new Option("Select calibration…", ""));
  for (const name of data.files) calibrationLibrary.add(new Option(name, name));
  calibrationLibrary.value = selection;
}
hook("scan", async () => {
  showSettings(await api("settings"), calibrationLibrary.value);
  settingsStatus.textContent = settings.ports.length ? settings.ports.join(" · ") : "No serial ports found. You can enter a port manually.";
}, settingsStatus);
hook("profile-save", async () => {
  const label = get("settings-profile").value;
  const values = Object.fromEntries(Object.entries(profileFields).map(([f, id]) => [f, get(id).value]));
  showSettings(await api("profile-save", {label, values}), calibrationLibrary.value);
  get("arm-profile").value = label;
  settingsStatus.textContent = `Follower ${label} saved.`;
}, settingsStatus);
hook("profile-remove", async () => {
  const label = get("settings-profile").value;
  if (!await confirmAction(`Remove follower ${label}'s saved profile?`)) return;
  showSettings(await api("profile-remove", {label}), calibrationLibrary.value);
  populateProfile();
  settingsStatus.textContent = `Follower ${label} removed.`;
}, settingsStatus);
hook("cal-view", async () => {
  const name = calibrationLibrary.value;
  if (!name) throw new Error("Select a calibration file first.");
  get("cal-text").value = (await api("cal-view", {name})).text;
  get("cal-name").value = name.replace(/\.json$/i, "");
}, settingsStatus);
hook("cal-import", () => get("cal-file").click(), settingsStatus);
get("cal-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 16384) {
    settingsStatus.textContent = "Calibration file is too large.";
    return;
  }
  get("cal-text").value = await file.text();
  get("cal-name").value = file.name.replace(/\.json$/i, "");
  settingsStatus.textContent = "Save calibration to create a managed copy.";
};
hook("cal-new", () => {
  get("cal-text").value = "";
  get("cal-name").value = "";
}, settingsStatus);
hook("cal-save", async () => {
  const name = get("cal-name").value.trim();
  const replace = settings.files.some(file => file.toLowerCase() === (name + ".json").toLowerCase());
  if (replace && !await confirmAction("Replace this copy and archive the earlier version?")) return;
  showSettings(await api("cal-save", {name, text: get("cal-text").value, replace}), name + ".json");
  settingsStatus.textContent = "Calibration copy saved.";
}, settingsStatus);
hook("cal-use", () => {
  if (!calibrationLibrary.value) throw new Error("Select a saved calibration file.");
  get("profile-calibration").value = "calibrations/" + calibrationLibrary.value;
  settingsStatus.textContent = "Select Save profile to assign this calibration.";
}, settingsStatus);
hook("cal-archive", async () => {
  const name = calibrationLibrary.value;
  if (!name || !await confirmAction(`Archive ${name}?`)) return;
  showSettings(await api("cal-archive", {name}));
  settingsStatus.textContent = "Calibration copy archived.";
}, settingsStatus);

async function boot() {
  code.value = hostedPython.example;
  showSettings(await api("settings"));
  populateProfile();
  try {
    listPrograms();
  } catch {
    programStatus.textContent = "Browser storage is unavailable. You can download your program.";
  }
  render = createViewer(get("viewer"), SO101_MODEL);
  pollLivePose();
  if (!hostedArm.supportsUSB) get("usb-help").textContent = "USB connection requires desktop Chrome or Edge and browser permission.";
  updateControls();
}

armAction("connect-usb", async () => {
  const result = await hostedArm.connectUSB(get("arm-profile").value);
  showSettings(await api("settings"));
  populateProfile();
  connected(result);
  resetPreview();
  get("bridge-status").textContent = "USB connected. Preview your route to prepare a move.";
});

get("bridge-form").onsubmit = event => {
  event.preventDefault();
  if (actionPending || hostedArm.mode) return;
  actionPending = true;
  updateControls();
  hostedArm.pair(get("bridge-code").value.trim()).then(async session => {
    get("bridge-code").value = "";
    const bridgeSettings = await api("settings");
    showSettings(bridgeSettings);
    populateProfile();
    connected(session.arm);
    if (session.step) showStep(session.step);
    resetPreview();
    get("bridge-status").textContent = "Bridge connected. Local profiles and calibration settings are available.";
    get("settings-scope").textContent = "Changes apply to profiles and calibration copies on the connected computer.";
    const calibration = await api("cal-status");
    if (["working", "midpoint", "range"].includes(calibration.phase)) {
      calibrating = true;
      pollCalibration();
    }
  }).catch(error => {
    get("bridge-status").textContent = error.message;
  }).finally(() => {
    actionPending = false;
    updateControls();
  });
};
function startLimitPreview(payload) {
  get("studio").hidden = true;
  get("limit-preview").hidden = false;
  const status = get("limit-status");
  const {rest, ranges} = JSON.parse(payload);
  const joints = Object.keys(JOINTS);
  if (!rest || !Array.isArray(ranges) || ranges.length !== joints.length ||
      !joints.every(joint => Number.isFinite(rest[joint]) &&
        ranges.filter(range => range.joint === joint).length === 1) ||
      !ranges.every(({min, max, low, high}) =>
        [min, max, low, high].every(Number.isFinite) && min <= max)) {
    throw new Error("The preview needs a saved rest pose and calibrated limits for all six joints.");
  }

  get("limit-viewer").firstElementChild.append(get("camera"));
  get("limit-viewer").append(get("viewer"), motorStatus);
  const draw = createViewer(get("viewer"), SO101_MODEL);
  const selection = get("limit-joint");
  const play = get("play-limits");
  const stop = get("stop-limits");
  const format = (value, joint) => value.toFixed(2) + (joint === "gripper" ? "%" : "°");
  let frame = 0;

  for (const {joint, min, max} of ranges) {
    selection.add(new Option(JOINTS[joint], joint));
    const item = document.createElement("li");
    item.textContent = `${JOINTS[joint]} · ${format(min, joint)} to ${format(max, joint)}`;
    get("limit-ranges").append(item);
  }

  function reset(message) {
    cancelAnimationFrame(frame);
    draw(rest);
    motorStatus.hidden = true;
    play.disabled = selection.disabled = false;
    stop.disabled = true;
    status.textContent = message;
  }

  play.onclick = () => {
    const selected = ranges.filter(({joint}) => selection.value === "all" || selection.value === joint);
    const segments = selected.flatMap(({joint, min, max, low, high}) => [
      {joint, from: rest[joint], to: low, label: `Minimum ${format(min, joint)}`},
      {joint, from: low, to: rest[joint], label: "Return to saved rest"},
      {joint, from: rest[joint], to: high, label: `Maximum ${format(max, joint)}`},
      {joint, from: high, to: rest[joint], label: "Return to saved rest"},
    ]);
    let index = 0;
    let started;
    play.disabled = selection.disabled = true;
    stop.disabled = false;

    function tick(now) {
      const {joint, from, to, label} = segments[index];
      if (started === undefined) {
        started = now;
        motorStatus.textContent = JOINTS[joint];
        motorStatus.hidden = false;
        status.textContent = label;
      }
      const elapsed = now - started;
      const progress = Math.min(elapsed / 650, 1);
      draw({...rest, [joint]: from + (to - from) * progress}, {joint, mode: "simulation"});
      if (elapsed >= 1000) {
        index++;
        started = undefined;
        if (index === segments.length) {
          reset("Preview complete. All six joints are shown at saved rest.");
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);
  };
  stop.onclick = () => reset("Preview stopped at saved rest.");
  reset("Ready at the saved rest pose.");
}

const limitPayload = new URLSearchParams(location.hash.slice(1)).get("limit-preview");
if (limitPayload !== null) {
  try {
    startLimitPreview(limitPayload);
  } catch (error) {
    get("limit-status").textContent = error.message;
  }
} else {
  boot().catch(error => { programStatus.textContent = error.message; });
}
