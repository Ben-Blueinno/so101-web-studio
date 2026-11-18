"use strict";

const pageArm = (() => {
  const bridgeAddress = "http://127.0.0.1:8765";
  const card = get("bridge-status");
  const live = get("live-pose");
  const profile = get("arm-profile");
  let pairingCode, arm, preview, step, timer;
  let busy = false, moving = false, reviewing = false;

  async function request(action, data = {}) {
    let response;
    try {
      response = await fetch(`${bridgeAddress}/api/${action}`, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: {"Content-Type": "application/json", "X-Studio-Token": pairingCode},
        body: JSON.stringify(data),
      });
    } catch {
      throw new Error("Cannot reach the bridge. Check that it is running and allow local access in the browser.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  function refresh() {
    const blocked = busy || reviewing || compiling;
    get("pair-bridge").disabled = blocked || Boolean(pairingCode);
    get("arm-controls").hidden = !pairingCode;
    get("arm-replay").hidden = !arm;
    profile.disabled = blocked || Boolean(arm);
    get("init-arm").disabled = blocked || Boolean(arm);
    get("disconnect-arm").disabled = blocked || !arm;
    get("return-rest").disabled = blocked || !arm || Boolean(step);
    get("prepare-arm").disabled = blocked || !arm || Boolean(step) || !preview ||
      preview.source !== code.value || preview.generation !== animation;
    get("run-arm-step").disabled = blocked || !step;
    get("discard-arm").disabled = blocked || !step;
    get("stop-arm").disabled = !moving;
    code.readOnly = busy || reviewing || Boolean(step);
    updateControls();
    if (busy || reviewing || step) get("preview").disabled = true;
  }

  function showArm(measured, joint) {
    arm = measured;
    live.hidden = !arm;
    if (!arm) {
      get("connection").textContent = "Browser simulator";
      return;
    }
    profile.value = arm.label;
    get("connection").textContent = `Follower ${arm.label} initialized`;
    live.textContent = `Live encoder pose · ${arm.at_rest ? "At rest" : "Away from rest"}\n` +
      Object.entries(arm.pose).map(([name, value]) => {
        const joint = name.replace(/\.pos$/, "");
        return `${JOINTS[joint]} ${format(joint, value)}`;
      }).join(" · ");
    if (!playingPreview) {
      render(arm.model_pose, joint ? {joint, mode: "physical"} : undefined);
      motorStatus.hidden = !joint;
      motorStatus.textContent = joint ? `Physical move · ${JOINTS[joint]}` : "";
    }
  }

  async function poll() {
    if (!pairingCode || !arm) return;
    try {
      const update = await request("telemetry");
      if (!arm) return;
      if (update.arm) showArm(update.arm, update.joint);
      else if (update.live === false && !busy) {
        showStep(null);
        showArm(null);
        refresh();
      }
    } catch {
      live.textContent = "Live readings unavailable. Showing the last measured pose.";
    } finally {
      timer = setTimeout(poll, 400);
    }
  }

  function startPolling() {
    clearTimeout(timer);
    timer = setTimeout(poll, 0);
  }

  function format(joint, value) {
    return value.toFixed(2) + (joint === "gripper" ? "%" : "°");
  }

  function showStep(next) {
    step = next?.plan_id ? next : null;
    get("arm-step").textContent = step
      ? `Step ${step.index + 1}/${step.count} · ${JOINTS[step.joint]} → ${format(step.joint, step.target)}`
      : next?.done ? "Replay complete." : "";
  }

  async function operation(fn) {
    if (busy || reviewing || compiling) return;
    busy = true;
    refresh();
    try {
      await fn();
    } catch (error) {
      card.textContent = error.message;
    } finally {
      busy = false;
      moving = false;
      refresh();
    }
  }

  function onClick(id, fn) {
    get(id).onclick = () => operation(fn);
  }

  get("bridge-form").onsubmit = event => {
    event.preventDefault();
    operation(async () => {
      if (pairingCode) return;
      pairingCode = get("bridge-code").value.trim();
      try {
        const session = await request("session");
        if (session.step) throw new Error("Finish or discard the active replay in the local Studio before pairing.");
        get("bridge-code").value = "";
        get("bridge-form").hidden = true;
        showArm(session.arm);
        card.textContent = session.arm ? "Bridge connected." : "Bridge connected. Choose a calibrated follower and initialize it.";
        startPolling();
      } catch (error) {
        pairingCode = undefined;
        throw error;
      }
    });
  };

  onClick("init-arm", async () => {
    preview = undefined;
    showArm(await request("init", {label: profile.value}));
    card.textContent = "Arm initialized. Preview your Python route to prepare a replay.";
    startPolling();
  });
  onClick("disconnect-arm", async () => {
    if (!await confirmAction("Support the arm before disconnecting. Disconnect now?")) return;
    await request("disconnect");
    preview = undefined;
    showStep(null);
    showArm(null);
    card.textContent = "Arm disconnected. The bridge is still paired.";
  });
  onClick("prepare-arm", async () => {
    if (!preview || preview.source !== code.value || preview.generation !== animation || step) return;
    showStep(await request("deploy", {preview_id: preview.id}));
    get("arm-result").textContent = "";
    card.textContent = "Review and confirm each move at the arm.";
  });
  onClick("run-arm-step", async () => {
    if (!step) return;
    const reviewed = step;
    if (!await confirmAction(`Follower ${arm.label} will move ${JOINTS[reviewed.joint]} to ${format(reviewed.joint, reviewed.target)}. Confirm the path is clear.`)) return;
    moving = true;
    refresh();
    try {
      const reply = await request("move", {plan_id: reviewed.plan_id, index: reviewed.index});
      showArm(reply.arm);
      showStep(reply);
      const {joint, measured, target} = reply.result;
      get("arm-result").textContent = `${JOINTS[joint]} measured ${format(joint, measured)}. Target ${format(joint, target)}.`;
      card.textContent = "Move verified by the bridge.";
    } catch (error) {
      showStep(null);
      preview = undefined;
      throw error;
    }
  });
  onClick("discard-arm", async () => {
    await request("discard");
    showStep(null);
    preview = undefined;
    card.textContent = "Remaining moves discarded.";
  });
  onClick("return-rest", async () => {
    const plan = await request("prepare-rest");
    showArm(plan.arm);
    if (!plan.token) {
      card.textContent = "The arm is already at saved rest.";
      return;
    }
    const joints = plan.joints.map(joint => JOINTS[joint]).join(", ");
    if (!await confirmAction(`The arm will return these joints to saved rest in order. ${joints}. Confirm their paths are clear.`)) return;
    moving = true;
    preview = undefined;
    refresh();
    showArm(await request("return-rest", {token: plan.token}));
    card.textContent = "Return complete. Check the live encoder pose.";
  });
  get("stop-arm").onclick = async () => {
    try {
      await request("stop");
      card.textContent = "Stop requested. The arm can retain holding torque.";
    } catch (error) {
      card.textContent = error.message;
    }
  };

  code.addEventListener("input", () => {
    preview = undefined;
    refresh();
  });
  get("stop-preview").addEventListener("click", () => {
    preview = undefined;
    refresh();
  });

  return {
    async preview(source) {
      preview = undefined;
      refresh();
      if (!arm) return {route: await hostedPython.compile(source)};
      showArm(await request("read-pose"));
      const result = await request("compile", {source, label: arm.label});
      const generation = animation;
      return {route: result.route, start: arm.preview_start, ready() {
        preview = {id: result.preview_id, source, generation};
        refresh();
      }};
    },
    refresh,
  };
})();

pageArm.refresh();
