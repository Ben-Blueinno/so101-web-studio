"use strict";

const motorButtons = [...document.querySelectorAll("[data-motor]")];
const motorName = document.getElementById("motor-name");
const motorRange = document.getElementById("motor-range");
const motorCamera = get("motor-camera");
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
  motorName.textContent = button.textContent;
  motorRange.textContent = defaultRange(joint);
  get("motor-motion").textContent = button.dataset.motion;
  drawMotor?.({}, {joint, mode: "simulation"});
}

for (const button of motorButtons) {
  button.closest("tr").querySelector(".default-range").textContent = defaultRange(button.dataset.motor);
  button.onclick = () => selectMotor(button);
}
selectMotor(motorButtons[0]);

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
