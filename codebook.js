"use strict";

const motorButtons = [...document.querySelectorAll("[data-motor]")];
const motorName = document.getElementById("motor-name");
const motorRange = document.getElementById("motor-range");
const motorCamera = get("motor-camera");
const codebookCopyStatus = get("codebook-copy-status");
let drawMotor;
function initCodebookModel() {
  if (drawMotor || motorCamera.disabled) return;
  try {
    drawMotor = createViewer(get("motor-viewer"), SO101_MODEL, motorCamera);
    selectMotor(motorButtons.find(button => button.getAttribute("aria-pressed") === "true"));
  } catch {
    motorCamera.disabled = true;
    get("motor-view-error").hidden = false;
  }
}

function defaultRange(joint) {
  const unit = joint === "gripper" ? "%" : "°";
  return LIMITS[joint].map(value => String(value).replace("-", "−") + unit).join(" to ");
}

function selectMotor(button) {
  const joint = button.dataset.motor;
  for (const choice of motorButtons) choice.setAttribute("aria-pressed", choice === button);
  motorName.textContent = button.querySelector(".motor-label").textContent;
  motorRange.textContent = defaultRange(joint);
  get("motor-motion").textContent = button.dataset.motion;
  drawMotor?.({}, {joint, mode: "simulation"});
}

for (const button of motorButtons) {
  button.closest("tr").querySelector(".default-range").textContent = defaultRange(button.dataset.motor);
  button.onclick = () => selectMotor(button);
}
selectMotor(motorButtons[0]);

for (const button of document.querySelectorAll(".copy-codebook")) {
  const example = button.dataset.copyExample ? get(button.dataset.copyExample) : undefined;
  const key = button.dataset.copyKey;
  const icon = button.querySelector("use");
  let feedbackTimer;
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(example?.textContent ?? key);
      codebookCopyStatus.textContent = example ? "Python example copied." : `Copied ${key}`;
      icon.setAttribute("href", "#glyph-check");
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => icon.setAttribute("href", "#glyph-copy"), 1400);
    } catch {
      if (example) {
        window.getSelection()?.selectAllChildren(example);
        codebookCopyStatus.textContent = "Code selected. Press Ctrl+C or Command+C to copy.";
      } else {
        codebookCopyStatus.textContent = `Clipboard unavailable. Copy this key manually: ${key}`;
      }
    }
  };
}

function highlightCodebookExamples() {
  const mirror = window.CodeMirror;
  if (!mirror?.modes.python) return;
  const mode = mirror.getMode({indentUnit: 4, tabSize: 4}, PYTHON_MODE);
  for (const example of document.querySelectorAll(".codebook-body pre > code")) {
    const state = mirror.startState(mode);
    const fragment = document.createDocumentFragment();
    const lines = example.textContent.split("\n");
    for (const [index, line] of lines.entries()) {
      if (index) fragment.append("\n");
      const stream = new mirror.StringStream(line, 4);
      if (stream.eol()) mode.blankLine?.(state);
      while (!stream.eol()) {
        stream.start = stream.pos;
        const style = mode.token(stream, state);
        if (stream.pos <= stream.start) stream.next();
        const text = stream.current();
        if (style) {
          const span = document.createElement("span");
          span.className = style.split(" ").map(name => "cm-" + name).join(" ");
          span.textContent = text;
          fragment.append(span);
        } else {
          fragment.append(text);
        }
      }
    }
    example.parentElement.classList.add("cm-s-" + PYTHON_THEME);
    example.replaceChildren(fragment);
  }
}

highlightCodebookExamples();
