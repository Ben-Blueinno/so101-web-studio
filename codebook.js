"use strict";

const motorButtons = [...document.querySelectorAll("[data-motor]")];
const motorName = document.getElementById("motor-name");
const motorRange = document.getElementById("motor-range");
const motorCamera = document.getElementById("camera");
let drawMotor;
try {
  drawMotor = createViewer(document.getElementById("motor-viewer"), SO101_MODEL, motorCamera);
} catch {
  motorCamera.disabled = true;
  document.getElementById("motor-view-error").hidden = false;
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
  drawMotor?.({}, {joint, mode: "simulation"});
}

for (const button of motorButtons) {
  button.closest("tr").querySelector(".default-range").textContent = defaultRange(button.dataset.motor);
  button.onclick = () => selectMotor(button);
}
selectMotor(motorButtons[0]);
