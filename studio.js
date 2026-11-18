"use strict";

const code = get("code");
const key = "so101-web-studio:programs:v1";
const programStatus = get("program-status");
const previewStatus = get("preview-status");
const motorStatus = get("active-motor");
const programLibrary = get("program-library");
let render;
let animation = 0;
let compiling = false;

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

function updateControls() {
  get("preview").disabled = !render || compiling;
}

function drawPose(pose, joint) {
  if (render) render(pose, joint ? {joint, mode: "simulation"} : undefined);
  motorStatus.hidden = !joint;
  motorStatus.textContent = joint ? `Simulation · ${JOINTS[joint]}` : "";
}

function resetPreview() {
  animation++;
  get("stop-preview").disabled = true;
  drawPose({});
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

function animate(route) {
  const generation = animation;
  const pose = {};
  drawPose(pose);
  get("stop-preview").disabled = false;
  function next(index) {
    if (generation !== animation) return;
    if (index === route.steps.length) {
      drawPose(pose);
      get("stop-preview").disabled = true;
      previewStatus.textContent = "Preview complete.";
      updateControls();
      return;
    }
    const {joint, [field(route.steps[index].joint)]: target} = route.steps[index];
    const isGripper = joint === "gripper";
    const end = target;
    const from = pose[joint] ?? (isGripper ? GRIP_HOME : 0);
    const duration = Math.max(550, Math.min(2700, Math.abs(end - from) * 85));
    let started;
    drawPose(pose, joint);
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
  resetPreview();
  compiling = true;
  updateControls();
  const version = animation;
  try {
    programStatus.textContent = "Checking the Python route…";
    const route = await hostedPython.compile(code.value);
    if (version !== animation) return;
    programStatus.textContent = `Validated ${route.steps.length} moves.`;
    animate(route);
  } finally {
    compiling = false;
    updateControls();
  }
});
hook("stop-preview", () => {
  resetPreview();
  previewStatus.textContent = "Preview stopped.";
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
  const generated = await hostedPython.exportFunction(source);
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


function boot() {
  code.value = hostedPython.example;
  try {
    listPrograms();
  } catch {
    programStatus.textContent = "Browser storage is unavailable. You can download your program.";
  }
  render = createViewer(get("viewer"), SO101_MODEL);
  updateControls();
}
try {
  boot();
} catch (error) {
  programStatus.textContent = error.message;
}
