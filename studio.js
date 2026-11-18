"use strict";

const code = get("code");
const key = "so101-web-studio:programs:v1";
const programStatus = get("program-status");
const armStatus = get("arm-status");
const calStatusMessage = get("cal-status-message");
const deploymentStatus = get("deployment-status");
const settingsStatus = get("settings-status");
const previewStatus = get("preview-status");
const stepStatus = get("step-status");
const motorStatus = get("active-motor");
const programLibrary = get("program-library");
const calibrationLibrary = get("cal-library");
let render, renderB, initialized, currentStep, previewId;
let armSnapshots = {}, simulatedPoses = {}, missingFollowers = [];
let animation = 0, settings, moving = false, calibrating = false, actionPending = false;
let compiling = false;
let simulating = false;
let returningToRest = false;
let routeStopped = false;
let pythonEditor;

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

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectView(view) {
  if (moving && !returningToRest && view !== "deployment") return;
  closeStudioDropdown();
  for (const tab of tabs) {
    const current = tab.dataset.view === view;
    get(tab.dataset.view).hidden = !current;
    tab.setAttribute("aria-selected", current);
    tab.tabIndex = current ? 0 : -1;
  }
  get("codebook-switch").hidden = view !== "program";
  if (view === "deployment") setCodebook(false);
  if (view === "program" || view === "deployment") {
    get(view).append(get("simulation-side-panel"));
  }
  if (view === "calibration") showArmSetup();
  if (view === "program") pythonEditor?.refresh();
  if (view === "getting-started") initGuideDemo();
}

for (const [index, tab] of tabs.entries()) {
  tab.onclick = () => selectView(tab.dataset.view);
  tab.onkeydown = event => {
    const direction = {ArrowLeft: -1, ArrowRight: 1}[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : direction ? (index + direction + tabs.length) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    if (tabs[next].disabled) return;
    selectView(tabs[next].dataset.view);
    tabs[next].focus();
  };
}
for (const button of document.querySelectorAll("[data-open-tab]")) {
  button.onclick = () => {
    const tab = get("tab-" + button.dataset.openTab);
    if (tab.disabled) return;
    selectView(tab.dataset.view);
    tab.focus();
  };
}

function setCodebook(open) {
  get("codebook-switch").setAttribute("aria-checked", open);
  get("program").classList.toggle("has-codebook", open);
  get("codebook-panel").hidden = !open;
  if (open) {
    expandEditor(false);
    initCodebookModel();
  } else {
    pythonEditor?.refresh();
  }
}

get("codebook-switch").onclick = () => {
  const opening = get("codebook-panel").hidden;
  setCodebook(opening);
  if (opening && matchMedia("(max-width: 820px)").matches) get("codebook-title").focus();
};
get("close-codebook").onclick = () => {
  setCodebook(false);
  get("codebook-switch").focus();
};

get("show-help").onclick = () => {
  const tab = tabs.find(item => item.getAttribute("aria-selected") === "true");
  get("help-title").textContent = tab.textContent;
  get("help-content").replaceChildren(get("help-" + tab.dataset.view).content.cloneNode(true));
  get("help-dialog").showModal();
};

let guideReady = false;
function initGuideDemo() {
  if (guideReady) return;
  guideReady = true;
  const play = get("guide-play"), status = get("guide-status");
  try {
    const draw = createViewer(get("guide-model"), SO101_MODEL, get("guide-camera"));
    play.disabled = false;
    play.onclick = () => {
      play.disabled = true;
      const motor = {joints: ["wrist_roll", "gripper"], mode: "simulation"};
      status.textContent = "Moving wrist roll and gripper together…";
      let started;
      function frame(now) {
        started ??= now;
        const progress = Math.min(1, (now - started) / 1000);
        draw({wrist_roll: -15 * progress, gripper: GRIP_HOME + (55 - GRIP_HOME) * progress}, motor);
        if (progress < 1) requestAnimationFrame(frame);
        else {
          play.disabled = false;
          status.textContent = "Wrist roll reached −15°. Gripper reached 55%.";
        }
      }
      requestAnimationFrame(frame);
    };
  } catch {
    get("guide-camera").disabled = true;
    status.textContent = "3D preview is unavailable in this browser.";
  }
}

function updateControls() {
  for (const tab of tabs) tab.disabled = moving && !returningToRest && tab.dataset.view !== "deployment";
  get("deploy").disabled = !previewId || missingFollowers.length > 0 || (!initialized && !Object.keys(armSnapshots).length)
    || Boolean(currentStep) || moving || actionPending;
  if (!currentStep && !moving) {
    deploymentStatus.textContent = previewId && missingFollowers.length ? `Connect ${missingFollowers.map(label => "follower " + label).join(" and ")} and preview again.`
      : !previewId ? "Preview your program in Simulation to prepare a route."
      : "Preview ready. Prepare deployment to review the joint targets.";
  }
  get("preview").disabled = !render || compiling || moving || Boolean(currentStep) || actionPending;
  get("move").disabled = moving || !currentStep || get("route-targets").hidden;
  get("stop-motion").disabled = !moving || !currentStep;
  get("discard").disabled = moving || !currentStep;
  get("init").disabled = Boolean(initialized) || calibrating || actionPending;
  get("read-pose").disabled = !initialized || moving || Boolean(currentStep) || actionPending;
  get("disconnect").disabled = !initialized || moving || actionPending;
  for (const id of ["save-rest", "return-rest"]) {
    get(id).disabled = !initialized || moving || Boolean(currentStep) || actionPending;
  }
  get("rest-actions").hidden = !initialized && !returningToRest;
  get("stop-rest").hidden = !returningToRest;
  const anyConnected = Boolean(initialized) || Object.keys(armSnapshots).length > 0;
  for (const id of ["cal-read", "cal-apply", "cal-start"]) {
    get(id).disabled = anyConnected || calibrating || actionPending;
  }
  get("arm-profile").disabled = calibrating || actionPending || compiling || simulating || Boolean(currentStep) || moving;
  code.readOnly = Boolean(currentStep) || actionPending;
  if (pythonEditor && pythonEditor.getOption("readOnly") !== code.readOnly) {
    pythonEditor.setOption("readOnly", code.readOnly);
  }
  const bridge = hostedArm.mode === "bridge";
  if (bridge && initialized) get("arm-profile").disabled = true;
  const paired = Boolean(hostedArm.mode);
  const blocked = paired || calibrating || actionPending || compiling || simulating;
  get("connect-usb").disabled = bridge || Boolean(initialized) || calibrating || actionPending
    || compiling || simulating || Boolean(currentStep) || moving || !hostedArm.supportsUSB;
  get("pair-bridge").disabled = blocked;
  get("init").disabled ||= !bridge;
  get("cal-read").disabled ||= !paired && !hostedArm.supportsUSB;
  get("cal-apply").disabled ||= !bridge && (!hostedArm.supportsUSB || !assignedCalibration());
  get("cal-start").disabled ||= !bridge && !hostedArm.supportsUSB;
  get("cal-default").disabled = anyConnected || calibrating || actionPending;
  get("cal-use").disabled = get("cal-default").disabled;
  get("bridge-port-options").hidden = !bridge;
  get("scan-ports").disabled = calibrating || actionPending || Boolean(initialized);
  get("save-port").disabled = get("scan-ports").disabled;
}

function drawScene(poses, active = {}, mode) {
  const selected = get("arm-profile").value;
  const labels = Object.keys(poses).sort();
  if (!labels.length) labels.push(selected);
  const dual = labels.length > 1;
  get("dual-viewport").classList.toggle("has-two-arms", dual);
  get("arm-b-view").hidden = !dual;
  const title = "Follower " + labels[0];
  if (get("arm-a-title").textContent !== title) get("arm-a-title").textContent = title;
  const options = label => active[label]?.length ? {joints: active[label], mode} : undefined;
  render?.(poses[labels[0]] ?? {}, options(labels[0]));
  if (dual && !renderB) {
    try {
      renderB = createViewer(get("viewer-b"), SO101_MODEL, get("camera-b"));
    } catch {
      renderB = () => {};
      get("arm-b-status").textContent = "Follower B’s 3D view is unavailable.";
      get("camera-b").disabled = true;
    }
  }
  if (dual) renderB?.(poses.B ?? {}, options("B"));
  const motors = Object.entries(active).flatMap(([label, joints]) =>
    joints.map(joint => `${label} · ${JOINTS[joint]}`));
  motorStatus.hidden = !motors.length;
  motorStatus.dataset.mode = mode ?? "";
  motorStatus.textContent = motors.length
    ? `${mode === "physical" ? "Physical move" : "Simulation"} · ${motors.join(", ")}` : "";
}

const liveModels = () => Object.fromEntries(Object.entries(armSnapshots).map(([label, arm]) => [label, arm.model_pose]));
function drawPose(pose, joints, mode) {
  const label = get("arm-profile").value;
  const poses = liveModels();
  if (pose && (initialized || !Object.keys(poses).length)) poses[label] = pose;
  const active = Array.isArray(joints) ? joints : joints ? [joints] : [];
  drawScene(poses, active.length ? {[label]: active} : {}, mode);
}

const targetText = ({follower, joint, target}) => `${follower ? follower + " · " : ""}${JOINTS[joint]} → ${Number(target.toFixed(2))}${joint === "gripper" ? "%" : "°"}`;

function resetPreview(resetModel = true) {
  animation++;
  simulating = false;
  previewId = undefined;
  missingFollowers = [];
  get("stop-preview").disabled = true;
  if (resetModel) {
    simulatedPoses = {};
    drawPose(initialized?.model_pose ?? {});
  }
  updateControls();
}

const codeLines = get("code-lines");
function updateLineNumbers() {
  codeLines.textContent = Array.from({length: code.value.split("\n").length}, (_, i) => i + 1).join("\n");
  codeLines.scrollTop = code.scrollTop;
}
code.onscroll = () => { codeLines.scrollTop = code.scrollTop; };

function expandEditor(expanded) {
  get("program").classList.toggle("editor-expanded", expanded);
  const button = get("expand-editor");
  button.setAttribute("aria-pressed", expanded);
  button.setAttribute("aria-label", expanded ? "Collapse editor" : "Expand editor");
  button.querySelector("use").setAttribute("href", expanded ? "#glyph-collapse" : "#glyph-expand");
  pythonEditor?.refresh();
}
hook("expand-editor", () => {
  const expanded = get("expand-editor").getAttribute("aria-pressed") !== "true";
  if (expanded) setCodebook(false);
  expandEditor(expanded);
  (pythonEditor ?? code).focus();
});

code.oninput = () => {
  updateLineNumbers();
  resetPreview();
  previewStatus.textContent = "Program changed. Preview the current version.";
};
code.onkeydown = event => {
  if (event.key === "Escape") {
    event.preventDefault();
    get("expand-editor").focus();
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    get("preview").click();
    return;
  }
  if (code.readOnly || event.altKey || event.isComposing || event.ctrlKey || event.metaKey) return;
  const {value, selectionStart: start, selectionEnd: end} = code;
  const lineStart = value.slice(0, start).lastIndexOf("\n") + 1;
  if (event.key === "Enter" && !event.shiftKey) {
    const before = value.slice(lineStart, start);
    const indent = before.match(/^[ \t]*/)[0];
    const more = before.trimEnd().endsWith(":") ? "    " : "";
    event.preventDefault();
    code.setRangeText("\n" + indent + more, start, end, "end");
  } else if (event.key === "Tab" && (event.shiftKey || start !== end)) {
    event.preventDefault();
    const block = value.slice(lineStart, end);
    const contents = block.replace(/^[^\n]+/gm, line =>
      event.shiftKey ? line.replace(/^(?: {1,4}|\t)/, "") : "    " + line);
    code.setRangeText(contents, lineStart, end, start === end ? "end" : "select");
  } else if (event.key === "Tab") {
    event.preventDefault();
    code.setRangeText("    ", start, end, "end");
  } else {
    return;
  }
  code.dispatchEvent(new Event("input"));
};

function animate(route, id, missing) {
  const generation = animation;
  const defaultLabel = get("arm-profile").value;
  const labelFor = action => action.follower ?? defaultLabel;
  const routedLabels = new Set(route.steps.flatMap(step => routeActions(step).map(labelFor)));
  const labels = new Set([...Object.keys(armSnapshots), ...routedLabels]);
  const starts = Object.fromEntries([...labels].map(label => [label, armSnapshots[label]?.preview_start ?? {}]));
  const poses = Object.fromEntries([...labels].map(label => [label, {...starts[label]}]));
  simulating = true;
  get("live-pose-status").hidden = true;
  drawScene(poses);
  get("stop-preview").disabled = false;
  function finish() {
    if (generation !== animation) return;
    simulating = false;
    const live = liveModels();
    simulatedPoses = Object.fromEntries(Object.entries(poses).filter(([label]) => !armSnapshots[label]));
    drawScene({...simulatedPoses, ...live});
    previewId = id;
    missingFollowers = missing;
    get("stop-preview").disabled = true;
    get("live-pose-status").hidden = !Object.keys(live).length;
    previewStatus.textContent = missing.length
      ? `Preview complete. Connect ${missing.map(label => "follower " + label).join(" and ")} to deploy.`
      : "Preview complete. Open Deployment to review the route.";
    updateControls();
  }
  function next(index) {
    if (generation !== animation) return;
    if (index === route.steps.length) {
      if ([...routedLabels].some(label => armSnapshots[label])) {
        // Give the last simulated frame time to paint before switching back to live readings.
        previewStatus.textContent = "Final simulated pose. Returning to live readings…";
        setTimeout(finish, 450);
      } else {
        finish();
      }
      return;
    }
    const active = {};
    const axes = routeActions(route.steps[index]).map((action, i) => {
      const {joint} = action;
      const follower = labelFor(action);
      (active[follower] ??= []).push(joint);
      const target = action[field(joint)];
      const isGripper = joint === "gripper";
      return {follower, joint, from: poses[follower][joint] ?? (isGripper ? GRIP_HOME : 0),
        end: isGripper ? target : (starts[follower][joint] ?? 0) + target,
        target: route.fixed_angles?.[index]?.[i] ?? target};
    });
    const duration = Math.max(550, Math.min(2700, Math.max(...axes.map(axis => Math.abs(axis.end - axis.from))) * 85));
    let started;
    previewStatus.textContent = `Step ${index + 1}/${route.steps.length} · ${axes.map(targetText).join(" · ")}`;
    function frame(now) {
      if (generation !== animation) return;
      started ??= now;
      const progress = Math.min(1, (now - started) / duration);
      for (const {follower, joint, from, end} of axes) poses[follower][joint] = from + (end - from) * progress;
      drawScene(poses, active, "simulation");
      if (progress === 1) next(index + 1);
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  next(0);
}

hook("preview", async () => {
  if (currentStep) return;
  expandEditor(false);
  resetPreview(false);
  compiling = true;
  updateControls();
  const version = animation;
  try {
    if (hostedArm.mode === "usb") acceptArms((await api("read-poses")).arms);
    else if (initialized) connected(await api("read-pose"));
    const result = await api("compile", {source: code.value, label: get("arm-profile").value});
    if (version !== animation) return;
    programStatus.textContent = `Validated ${result.route.steps.length} moves.`;
    if (!get("program").hidden && (!get("codebook-panel").hidden || matchMedia("(max-width: 820px)").matches)) {
      get("side-panel-heading").scrollIntoView({block: "nearest"});
    }
    animate(result.route, result.preview_id, result.missing ?? (initialized ? [] : [get("arm-profile").value]));
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
  const list = get("route-targets");
  if (!currentStep) {
    list.replaceChildren();
    list.hidden = true;
  } else if (step.targets) {
    const items = step.targets.slice(step.index).map(group => {
      const item = document.createElement("li");
      item.textContent = routeActions(group).map(targetText).join(" · ");
      return item;
    });
    list.replaceChildren(...items);
    list.start = step.index + 1;
    list.hidden = moving;
  }
  if (currentStep) {
    const labels = new Set((step.targets ?? [step]).flatMap(group => routeActions(group)
      .map(action => action.follower ?? get("arm-profile").value)));
    stepStatus.textContent = moving
      ? `Running step ${step.index + 1}/${step.count}.`
      : `Follower ${[...labels].join(" and ")} will move. Check the full paths, including clearance between the arms. Keep hands clear before confirming.`;
    if (list.hidden && !moving) stepStatus.textContent = "Update and reconnect the Studio bridge to review and run a full route.";
  } else if (step?.done) {
    stepStatus.textContent = `Route complete. Verified ${step.count} of ${step.count} moves from encoder readings.`;
  }
  updateControls();
}

hook("deploy", async () => {
  actionPending = true;
  updateControls();
  try {
    get("move-result").textContent = "";
    showStep(await api("deploy", {preview_id: previewId}));
    deploymentStatus.textContent = "Route ready for review.";
  } finally {
    actionPending = false;
    updateControls();
  }
}, deploymentStatus);

hook("move", async () => {
  if (!currentStep || moving || get("route-targets").hidden) return;
  actionPending = true;
  moving = true;
  routeStopped = false;
  get("route-targets").hidden = true;
  get("move-result").textContent = "";
  const feedback = get("route-feedback");
  feedback.hidden = false;
  updateControls();
  try {
    while (currentStep && !routeStopped) {
      const {plan_id, index, count} = currentStep;
      showRouteFeedback();
      const active = {};
      for (const {follower, joint} of routeActions(currentStep)) {
        (active[follower ?? get("arm-profile").value] ??= []).push(joint);
      }
      drawScene(liveModels(), active, "physical");
      const response = await api("move", {plan_id, index});
      if (response.arms) acceptArms(response.arms);
      else connected(response.arm);
      drawScene(liveModels());
      for (const result of response.results ?? [response.result]) {
        const unit = result.joint === "gripper" ? "%" : "°";
        get("move-result").textContent += `Step ${index + 1} · ${result.follower ? result.follower + " · " : ""}${JOINTS[result.joint]} · measured ${result.measured.toFixed(2)}${unit}, target ${result.target.toFixed(2)}${unit}.\n`;
      }
      showStep({...response, count});
    }
    if (routeStopped) {
      await api("discard");
      showStep({});
      resetPreview();
      stepStatus.textContent = "Route stopped. Read the arm pose before preparing another route.";
    }
  } catch (error) {
    drawPose(initialized?.model_pose ?? {});
    showStep({});
    resetPreview();
    stepStatus.textContent = error.message;
  } finally {
    feedback.hidden = true;
    moving = false;
    actionPending = false;
    updateControls();
  }
}, stepStatus);

function showRouteFeedback(pose, live) {
  if (!currentStep || !moving || routeStopped) return;
  const {index, count} = currentStep;
  const actions = routeActions(currentStep);
  const status = `Running step ${index + 1}/${count} · ${actions.map(targetText).join(" · ")}.`;
  if (stepStatus.textContent !== status) stepStatus.textContent = status;
  const readings = actions.map(({follower, joint}) => ({
    follower, joint, target: (follower ? armSnapshots[follower]?.pose : pose)?.[joint + ".pos"],
  }));
  get("route-feedback").textContent = live && readings.every(({target}) => Number.isFinite(target))
    ? `Live encoder readings · ${readings.map(targetText).join(" · ")}`
    : "Waiting for live encoder feedback…";
}

hook("stop-motion", async () => {
  routeStopped = true;
  stepStatus.textContent = "Stopping route…";
  await api("stop");
}, stepStatus);

hook("discard", async () => {
  await api("discard");
  showStep();
  programStatus.textContent = "Remaining steps discarded.";
});

function listing() {
  return JSON.parse(localStorage.getItem(key) || "[]");
}
function routeToPython(route) {
  return validateRoute(route).map(step => step.joint === "gripper"
    ? `grip(${step.position_pct})`
    : `move(${JSON.stringify(step.joint)}, ${step.offset_deg})`).join("\n") + "\n";
}

function migrateSavedMoveSets() {
  const oldKey = "so101-route-lab:move-sets:v1";
  const old = localStorage.getItem(oldKey);
  if (!old) return;
  const drafts = JSON.parse(old);
  const programs = listing();
  for (const draft of drafts) {
    if (typeof draft?.name !== "string" || !draft.name.trim()) throw new Error("Invalid saved move set name.");
    const text = routeToPython(draft);
    let name = draft.name;
    let copy = 2;
    while (programs.some(program => program.name === name && program.text !== text)) {
      name = `${draft.name} (${copy++})`;
    }
    if (!programs.some(program => program.name === name)) programs.push({name, text});
  }
  localStorage.setItem(key, JSON.stringify(programs));
  localStorage.removeItem(oldKey);
}

function listPrograms(selected = "") {
  const programs = listing();
  programLibrary.replaceChildren(new Option(programs.length ? "Choose a program…" : "No saved programs", ""));
  for (const item of programs) programLibrary.add(new Option(item.name, item.name));
  selectStudioValue(programLibrary, selected);
  updateSavedProgramActions();
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
  if (pythonEditor) pythonEditor.setValue(text);
  else {
    code.value = text;
    code.dispatchEvent(new Event("input"));
  }
  get("program-name").value = name.slice(0, 60);
}

const savedProgramsDialog = get("saved-programs-dialog");
const savedProgramsStatus = get("saved-programs-status");
function updateSavedProgramActions() {
  get("program-open").disabled = get("program-delete").disabled = !programLibrary.value;
}
programLibrary.onchange = updateSavedProgramActions;
get("saved-programs").onclick = () => {
  savedProgramsStatus.textContent = "";
  try {
    listPrograms(programLibrary.value);
  } catch {
    savedProgramsStatus.textContent = "Could not read saved programs.";
  }
  savedProgramsDialog.showModal();
};
hook("program-open", () => {
  const saved = listing().find(item => item.name === programLibrary.value);
  if (!saved) throw new Error("Choose a saved program.");
  openCode(saved.text, saved.name);
  savedProgramsDialog.close();
}, savedProgramsStatus);
hook("program-delete", async () => {
  const name = programLibrary.value;
  if (!name || !await confirmAction(`Delete “${name}” from this browser?`)) return;
  localStorage.setItem(key, JSON.stringify(listing().filter(item => item.name !== name)));
  listPrograms();
  savedProgramsStatus.textContent = `Deleted “${name}”.`;
}, savedProgramsStatus);
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
const exportDialog = get("export-dialog");
const exportStatus = get("export-status");
const exportCode = get("export-code");
const exportFrame = get("export-frame");
const exportLoading = get("export-loading");
let exportEditor, exportGeneration = 0;

get("generate-function").onclick = async () => {
  const source = code.value;
  const generation = ++exportGeneration;
  const isCurrent = () => generation === exportGeneration && exportDialog.open;
  exportStatus.textContent = "";
  exportFrame.hidden = true;
  exportLoading.hidden = false;
  get("copy-function").disabled = get("download-function").disabled = true;
  exportDialog.showModal();
  try {
    const {code: generated} = await api("export-lerobot", {source, label: get("arm-profile").value});
    if (!isCurrent()) return;
    exportCode.value = generated;
    exportFrame.hidden = false;
    if (exportEditor) {
      exportEditor.setValue(generated);
      exportEditor.clearHistory();
    } else {
      exportEditor = attachPythonEditor(exportCode, {escape: () => exportDialog.close()});
      exportFrame.classList.toggle("enhanced", Boolean(exportEditor));
    }
    exportEditor?.refresh();
    get("copy-function").disabled = get("download-function").disabled = false;
  } catch (error) {
    if (isCurrent()) exportStatus.textContent = error.message;
  } finally {
    if (isCurrent()) exportLoading.hidden = true;
  }
};

function generatedCode() {
  return exportEditor?.getValue() ?? exportCode.value;
}

hook("copy-function", async () => {
  try {
    await navigator.clipboard.writeText(generatedCode());
    if (exportDialog.open) exportStatus.textContent = "Copied.";
  } catch {
    if (!exportDialog.open) return;
    if (exportEditor) {
      exportEditor.focus();
      exportEditor.execCommand("selectAll");
    } else {
      exportCode.focus();
      exportCode.select();
    }
    exportStatus.textContent = "Code selected. Copy it with Ctrl+C or Command+C.";
  }
}, exportStatus);
hook("download-function", () => {
  const filename = get("program-name").value.replace(/\W+/g, "_").replace(/^\d/, "_$&") || "my_route";
  downloadPython(generatedCode(), filename + "_lerobot");
}, exportStatus);
hook("program-import", () => get("program-file").click());
get("program-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 20000) throw new Error("This file is too large.");
    let text = await file.text();
    if (/\.json$/i.test(file.name)) text = routeToPython(JSON.parse(text));
    openCode(text, file.name.replace(/\.(py|json)$/i, ""));
  } catch (error) {
    programStatus.textContent = error.message;
  }
};

function acceptArms(arms) {
  armSnapshots = arms;
  initialized = arms[get("arm-profile").value];
  const labels = Object.keys(arms).sort();
  const status = labels.length ? `Connected · ${labels.join(" and ")}` : "Browser simulator";
  if (get("connection").textContent !== status) get("connection").textContent = status;
  for (const label of ["A", "B"]) {
    const indicator = get("usb-status-" + label);
    const text = arms[label] ? "Connected" : "Disconnected";
    if (indicator.textContent !== text) indicator.textContent = text;
  }
  get("pose-sample").textContent = initialized ? Object.entries(initialized.pose).map(([name, value]) =>
    `${JOINTS[name.replace(".pos", "")]}: ${value.toFixed(2)}${name === "gripper.pos" ? "%" : "°"}`).join("\n") : "";
  updateControls();
}
function connected(arm) {
  const label = get("arm-profile").value;
  const arms = {...armSnapshots};
  if (arm) arms[arm.label] = arm;
  else delete arms[label];
  acceptArms(arms);
}

async function pollLivePose() {
  const status = get("live-pose-status");
  try {
    if (Object.keys(armSnapshots).length) {
      const previous = armSnapshots;
      const result = await api("telemetry");
      if (armSnapshots === previous && (result.arms || result.arm)) {
        if (result.arms) acceptArms(result.arms);
        else connected(result.arm);
        showRouteFeedback(result.arm?.pose, result.live);
        if (!simulating) {
          const active = result.active ?? {[result.arm.label]: result.joints ?? (result.joint ? [result.joint] : [])};
          drawScene({...simulatedPoses, ...liveModels()}, active, "physical");
        }
        status.hidden = simulating;
        const source = result.live ? "Live encoder pose" : "Last measured pose";
        const details = Object.values(armSnapshots).map(arm => `${arm.label} ${arm.at_rest ? "at rest" : "away from rest"}`);
        const message = `${source} · ${details.join(" · ")}`;
        if (status.textContent !== message) status.textContent = message;
      }
    } else {
      status.hidden = true;
    }
  } catch {
    showRouteFeedback();
    status.hidden = false;
    status.textContent = "Live readings unavailable. Showing the last measured poses.";
  }
  setTimeout(pollLivePose, 300);
}
function armAction(id, fn, status = armStatus) {
  hook(id, async () => {
    actionPending = true;
    updateControls();
    try {
      await fn();
    } finally {
      actionPending = false;
      updateControls();
    }
  }, status);
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
  const result = await api("disconnect");
  if (result?.arms) acceptArms(result.arms);
  else connected();
  showStep();
  resetPreview();
  previewStatus.textContent = "Follower disconnected. Preview again before deploying.";
  get("pose-sample").textContent = "";
  armStatus.textContent = "Arm disconnected.";
  if (!hostedArm.mode) get("bridge-status").textContent = "";
});
armAction("cal-read", async () => {
  const result = await api("cal-read", armLabel());
  get("cal-name").value = result.name;
  get("cal-text").value = result.text;
  calFilesStatus.textContent = "Review the readback, then save a copy if needed.";
  get("cal-text").focus();
}, calStatusMessage);
armAction("cal-apply", async () => {
  if (!await confirmAction("Restore calibration to this same arm from the selected follower profile? Support the arm before continuing because torque will be released.")) return;
  calStatusMessage.textContent = (await api("cal-apply", {...armLabel(), confirmed: true})).message;
}, calStatusMessage);
armAction("cal-start", async () => {
  if (!await confirmAction("Support the arm. Calibration releases torque and requires moving the joints by hand. Proceed?")) return;
  await api("cal-start", {...armLabel(), confirmed: true});
  calibrating = true;
  updateControls();
  pollCalibration();
}, calStatusMessage);
hook("cal-next", async () => {
  get("cal-next").disabled = true;
  await api("cal-next");
}, calStatusMessage);
hook("cal-cancel", async () => {
  get("cal-cancel").disabled = true;
  await api("cal-cancel");
}, calStatusMessage);

async function pollCalibration() {
  try {
    const {phase, message, sample, file} = await api("cal-status");
    calStatusMessage.textContent = message;
    get("arm-sample").textContent = sample;
    calibrating = !["done", "error", "idle"].includes(phase);
    get("cal-controls").hidden = !calibrating;
    get("cal-next").textContent = phase === "range" ? "Save range" : "Capture midpoint";
    get("cal-next").disabled = !["midpoint", "range"].includes(phase);
    get("cal-cancel").disabled = !calibrating;
    updateControls();
    if (phase === "done" && hostedArm.mode !== "bridge") {
      showSettings(await api("settings"), file ?? calibrationLibrary.value);
      updateControls();
    }
  } catch (error) {
    calStatusMessage.textContent = error.message;
  }
  if (calibrating) setTimeout(pollCalibration, 400);
}

const profileFields = {id: "profile-id"};
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
  for (const [fieldName, id] of Object.entries(profileFields)) selectStudioValue(get(id), profile[fieldName]);
}
get("settings-profile").onchange = populateProfile;
function assignedCalibration() {
  return settings?.profiles[get("arm-profile").value]?.calibration_file ?? "";
}
function showArmSetup() {
  const label = get("arm-profile").value;
  const assigned = assignedCalibration();
  get("cal-follower").textContent = "Follower " + label;
  const source = get("profile-calibration");
  source.textContent = assigned.split(/[/\\]/).at(-1) || (hostedArm.mode === "bridge"
    ? "Default · LeRobot calibration" : "Default · calibration stored on the arm");
  source.title = assigned;
  get("cal-default").hidden = !assigned;
  get("profile-port").value = settings?.profiles[label]?.port ?? "";
}
get("arm-profile").onchange = () => {
  if (hostedArm.mode !== "bridge") hostedArm.selectUSB(get("arm-profile").value);
  acceptArms(armSnapshots);
  showArmSetup();
  resetPreview();
};

async function saveFollowerFields(label, fields) {
  const values = {...settings.profiles[label], ...fields};
  showSettings(await api("profile-save", {label, values}), calibrationLibrary.value);
  updateControls();
}
function showSettings(data, selection = "") {
  settings = data;
  get("ports").replaceChildren(new Option("Scanned ports…", ""), ...data.ports.map(port => new Option(port)));
  calibrationLibrary.replaceChildren(new Option("Select calibration…", ""));
  for (const name of data.files) calibrationLibrary.add(new Option(name, name));
  selectStudioValue(calibrationLibrary, selection || "");
  showArmSetup();
}
armAction("scan-ports", async () => {
  showSettings(await api("settings"), calibrationLibrary.value);
  get("bridge-status").textContent = settings.ports.length
    ? "Choose a scanned port, then select Save port."
    : "No serial ports found. You can enter a port manually.";
}, get("bridge-status"));
armAction("save-port", async () => {
  const label = get("arm-profile").value;
  await saveFollowerFields(label, {port: get("profile-port").value});
  get("bridge-status").textContent = `Port saved for follower ${label}.`;
}, get("bridge-status"));
hook("profile-save", async () => {
  const label = get("settings-profile").value;
  const values = Object.fromEntries(Object.entries(profileFields).map(([f, id]) => [f, get(id).value]));
  await saveFollowerFields(label, values);
  settingsStatus.textContent = `Follower ${label} saved.`;
}, settingsStatus);
hook("profile-remove", async () => {
  const label = get("settings-profile").value;
  if (!await confirmAction(`Remove follower ${label}'s saved profile?`)) return;
  showSettings(await api("profile-remove", {label}), calibrationLibrary.value);
  populateProfile();
  updateControls();
  settingsStatus.textContent = `Follower ${label} removed.`;
}, settingsStatus);
const calFilesStatus = get("cal-files-status");
hook("cal-view", async () => {
  const name = calibrationLibrary.value;
  if (!name) throw new Error("Select a calibration file first.");
  get("cal-text").value = (await api("cal-view", {name})).text;
  get("cal-name").value = name.replace(/\.json$/i, "");
}, calFilesStatus);
hook("cal-import", () => get("cal-file").click(), calFilesStatus);
get("cal-file").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 16384) {
    calFilesStatus.textContent = "Calibration file is too large.";
    return;
  }
  get("cal-text").value = await file.text();
  get("cal-name").value = file.name.replace(/\.json$/i, "");
  calFilesStatus.textContent = "Save calibration to create a managed copy.";
};
hook("cal-new", () => {
  get("cal-text").value = "";
  get("cal-name").value = "";
  get("cal-name").focus();
  calFilesStatus.textContent = "";
}, calFilesStatus);
hook("cal-save", async () => {
  const name = get("cal-name").value.trim();
  const replace = settings.files.some(file => file.toLowerCase() === (name + ".json").toLowerCase());
  if (replace && !await confirmAction("Replace this copy and archive the earlier version?")) return;
  showSettings(await api("cal-save", {name, text: get("cal-text").value, replace}), name + ".json");
  calFilesStatus.textContent = "Calibration copy saved.";
}, calFilesStatus);
armAction("cal-use", async () => {
  const file = calibrationLibrary.value;
  if (!file) throw new Error("Select a saved calibration file.");
  const label = get("arm-profile").value;
  await saveFollowerFields(label, {calibration_file: "calibrations/" + file});
  calFilesStatus.textContent = `Assigned to follower ${label}. Use Restore saved calibration to write it to the arm.`;
}, calFilesStatus);
armAction("cal-default", async () => {
  await saveFollowerFields(get("arm-profile").value, {calibration_file: ""});
  calStatusMessage.textContent = "Default calibration selected.";
}, calStatusMessage);
hook("cal-archive", async () => {
  const name = calibrationLibrary.value;
  if (!name || !await confirmAction(`Archive ${name}?`)) return;
  showSettings(await api("cal-archive", {name}));
  calFilesStatus.textContent = "Calibration copy archived.";
}, calFilesStatus);

async function boot() {
  code.value = hostedPython.example;
  pythonEditor = attachPythonEditor(code, {
    preview: () => get("preview").click(),
    escape: () => get("expand-editor").focus(),
  });
  get("editor-frame").classList.toggle("enhanced", Boolean(pythonEditor));
  updateLineNumbers();
  showSettings(await api("settings"));
  populateProfile();
  try {
    migrateSavedMoveSets();
  } catch {
    programStatus.textContent = "Previous move sets could not be imported.";
  }
  try {
    listPrograms();
  } catch {
    programStatus.textContent = "Browser storage is unavailable. You can download your program.";
  }
  render = createViewer(get("viewer"), SO101_MODEL);
  const views = {"#codebook": "program", "#simulation": "program", "#coming-soon": "roadmap", "#about": "about"};
  selectView(views[location.hash] ?? "getting-started");
  if (location.hash === "#codebook") setCodebook(true);
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
  armStatus.textContent = `Follower ${result.label} connected. Preview your route before deploying.`;
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
    if (session.arm) selectStudioValue(get("arm-profile"), session.arm.label);
    connected(session.arm);
    if (session.step) showStep(session.step);
    resetPreview();
    get("bridge-status").textContent = "Bridge connected. Local profiles and calibration settings are available.";
    get("settings-scope").textContent = "Profile changes apply on the connected computer.";
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

get("ports").onchange = () => {
  const port = get("ports").value;
  if (port) get("profile-port").value = port;
  selectStudioValue(get("ports"), "");
};
for (const trigger of document.querySelectorAll("[data-studio-menu]")) {
  attachStudioDropdown(trigger, get(trigger.getAttribute("aria-controls")));
}
for (const select of document.querySelectorAll("select")) attachStudioSelect(select);

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
