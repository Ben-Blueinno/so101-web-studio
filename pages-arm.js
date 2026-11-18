"use strict";

const hostedArm = (() => {
  const address = "http://127.0.0.1:8765";
  const storageKey = "so101-web-studio:usb-setup:v1";
  const emptyProfile = () => Object.fromEntries([
    ["port", ""], ["id", ""], ["calibration_file", ""], ...SERIAL_JOINTS.map(joint => [joint, ""]),
  ]);
  let stored = {profiles: {A: emptyProfile(), B: emptyProfile()}, files: {}, rests: {}};
  try {
    const previous = localStorage.getItem(storageKey);
    if (previous) stored = JSON.parse(previous);
  } catch { /* A new profile can still be used for this session. */ }

  let code, follower, preview, replay, offer, scan, selectedUSB, busy = false;

  function save() {
    localStorage.setItem(storageKey, JSON.stringify(stored));
  }

  function settings() {
    return {profiles: stored.profiles, ports: [], files: Object.keys(stored.files).sort()};
  }

  async function bridge(action, data = {}) {
    let response;
    try {
      response = await fetch(`${address}/api/${action}`, {
        method: "POST", credentials: "omit", redirect: "error",
        headers: {"Content-Type": "application/json", "X-Studio-Token": code},
        body: JSON.stringify(data),
      });
    } catch {
      throw new Error("Cannot reach the bridge. Start the updated bridge and allow local access in Chrome.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  async function chooseUSB() {
    try {
      const port = await navigator.serial.requestPort();
      if (!port.getInfo().usbVendorId) throw new Error("Choose the SO-101 USB serial adapter.");
      return port;
    } catch (error) {
      if (error.name === "NotFoundError") throw new Error("No USB port was selected.");
      throw error;
    }
  }

  function restKey(arm) {
    return JSON.stringify([arm.label, stored.profiles[arm.label].id, arm.calibration]);
  }

  function getCalibration(name) {
    const key = name?.split(/[/\\]/).at(-1);
    if (!Object.hasOwn(stored.files, key)) throw new Error("Save or import that calibration in this browser first.");
    return stored.files[key];
  }

  function validateCalibration(raw) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).length !== SERIAL_JOINTS.length) {
      throw new Error("A calibration file must contain all six SO-101 joints.");
    }
    return Object.fromEntries(SERIAL_JOINTS.map(joint => {
      const motor = raw[joint];
      if (!motor || motor.id !== SERVO_ID[joint] || ![0, 1].includes(motor.drive_mode) ||
          ![motor.homing_offset, motor.range_min, motor.range_max].every(Number.isInteger) ||
          Math.abs(motor.homing_offset) > 2047 || motor.range_min < 0 ||
          motor.range_max > 4095 || motor.range_min >= motor.range_max) {
        throw new Error(`${JOINTS[joint]} has invalid calibration values.`);
      }
      return [joint, {id: motor.id, drive_mode: motor.drive_mode, homing_offset: motor.homing_offset,
                      range_min: motor.range_min, range_max: motor.range_max}];
    }));
  }

  async function connectUSB(label) {
    if (code || follower || busy) throw new Error("Disconnect the active arm first.");
    busy = true;
    let bus;
    try {
      const port = selectedUSB?.label === label ? selectedUSB.port : undefined;
      selectedUSB = undefined;
      bus = await ServoSerial.open(port && port.connected !== false ? port : await chooseUSB());
      const calibration = await bus.calibration();
      const profile = stored.profiles[label];
      if (profile.calibration_file &&
          JSON.stringify(getCalibration(profile.calibration_file)) !== JSON.stringify(calibration)) {
        throw new Error("The servo calibration differs from the selected copy. Check the follower and its calibration file in Settings.");
      }
      const directions = Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, profile[joint] === "-1" ? -1 : 1]));
      const arm = new BrowserFollower(bus, label, calibration, directions, await bus.positions());
      arm.validatePositions(arm.current);
      const rest = stored.rests[restKey(arm)];
      if (rest) {
        arm.validatePositions(rest);
        arm.rest = rest;
      }
      follower = arm;
      return arm.snapshot();
    } catch (error) {
      if (bus) await bus.close().catch(() => {});
      throw error;
    } finally {
      busy = false;
    }
  }

  function nextStep() {
    if (replay.index === replay.targets.length) {
      replay = undefined;
      return {done: true};
    }
    return {plan_id: replay.id, index: replay.index, count: replay.targets.length,
            ...reviewTargets(replay.targets[replay.index])};
  }

  function reviewTargets(group) {
    return {actions: Object.entries(group).map(([joint, raw]) => ({joint, target: follower.units(joint, raw)}))};
  }

  async function compile(data) {
    if (replay) throw new Error("Finish or discard the active replay first.");
    const original = await hostedPython.parse(data.source);
    const directions = follower?.directions ?? Object.fromEntries(SERIAL_JOINTS.map(joint =>
      [joint, stored.profiles[data.label]?.[joint] === "-1" ? -1 : 1]));
    const toModelAction = step => {
      if (original.coordinates !== "lerobot") return step;
      const {joint, position_deg} = step;
      const sign = directions[joint];
      if (position_deg !== undefined) {
        return {joint, offset_deg: sign * position_deg};
      }
      if (sign === 1) return step;
      return joint === "gripper" ? {...step, position_pct: 100 - step.position_pct}
        : {...step, offset_deg: -step.offset_deg};
    };
    const route = {...original, steps: original.steps.map(step =>
      step.actions ? {actions: step.actions.map(toModelAction)} : toModelAction(step))};
    if (!follower || original.coordinates !== "lerobot") validateRoute(route, {grouped: true});
    route.fixed_angles = original.steps.map(step => routeActions(step).map(action => action.position_deg ?? null));
    let targets;
    if (follower) {
      targets = [];
      route.steps = route.steps.map((step, index) => {
        const raw = {};
        const actions = routeActions(step).map((action, actionIndex) => {
          const {joint} = action;
          const fixedAngle = route.fixed_angles[index][actionIndex];
          raw[joint] = follower.target(joint, hardwareGoal(follower, action, fixedAngle));
          if (fixedAngle === null) return action;
          const start = follower.units(joint, follower.initial[joint]);
          return {joint, offset_deg: directions[joint] * (fixedAngle - start)};
        });
        targets.push(raw);
        return step.actions ? {actions} : actions[0];
      });
    }
    preview = {targets, id: crypto.randomUUID()};
    return {route, preview_id: preview.id};
  }

  function hardwareGoal(arm, step, fixedAngle) {
    if (fixedAngle != null) return fixedAngle;
    const {joint} = step;
    const sign = arm.directions[joint];
    if (joint === "gripper") return sign === 1 ? step.position_pct : 100 - step.position_pct;
    return arm.units(joint, arm.initial[joint]) + sign * step.offset_deg;
  }

  async function dispatch(action, data) {
    if (action === "settings") return settings();
    if (action === "compile") return compile(data);
    if (action === "export-lerobot") return {code: await hostedPython.exportFunction(data.source)};
    if (action === "cal-view") return {text: JSON.stringify(getCalibration(data.name), null, 2)};
    if (action === "cal-status") return {phase: "idle"};
    if (action === "scan-usb") {
      if (follower) throw new Error("Disconnect the active arm before selecting another USB port.");
      selectedUSB = undefined;
      selectedUSB = {label: data.label, port: await chooseUSB()};
      return {};
    }
    if (["profile-save", "profile-remove", "cal-save", "cal-archive"].includes(action) && follower) {
      throw new Error("Support and disconnect the arm before changing its profile or calibration copies.");
    }
    if (action === "profile-save") {
      const values = data.values;
      if (values.calibration_file) getCalibration(values.calibration_file);
      stored.profiles[data.label] = Object.fromEntries(Object.keys(emptyProfile()).map(field =>
        [field, String(values[field] ?? "").trim()]));
      save();
      return settings();
    }
    if (action === "profile-remove") {
      stored.profiles[data.label] = emptyProfile();
      save();
      return settings();
    }
    if (action === "cal-save") {
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(data.name)) throw new Error("Use letters, numbers, underscores, or hyphens.");
      const name = data.name + ".json";
      if (Object.hasOwn(stored.files, name) && !data.replace) throw new Error("Choose a new calibration name.");
      stored.files[name] = validateCalibration(JSON.parse(data.text));
      save();
      return settings();
    }
    if (action === "cal-archive") {
      for (const profile of Object.values(stored.profiles)) {
        if (profile.calibration_file.split(/[/\\]/).at(-1) === data.name) {
          throw new Error("Remove the calibration from its profile first.");
        }
      }
      delete stored.files[data.name];
      save();
      return settings();
    }
    if (action === "cal-read") {
      if (follower) throw new Error("Support and disconnect the arm before reading calibration.");
      const bus = await ServoSerial.open(await chooseUSB());
      try {
        return {text: JSON.stringify(await bus.calibration(), null, 2), name: `follower-${data.label}-readback`};
      } finally {
        await bus.close();
      }
    }
    if (!follower) throw new Error("Connect your SO-101 in Arm setup first.");
    const arm = follower;
    switch (action) {
      case "disconnect":
        try { await arm.close(); }
        finally { follower = preview = replay = offer = undefined; }
        return {};
      case "read-pose":
      case "save-rest":
      case "prepare-rest":
        if (replay) throw new Error("Finish or discard the active replay first.");
        arm.current = await arm.bus.positions();
        if (action === "read-pose") {
          arm.initial = arm.current;
          preview = offer = undefined;
        } else if (action === "save-rest") {
          arm.validatePositions(arm.current);
          stored.rests[restKey(arm)] = arm.current;
          save();
          arm.rest = arm.current;
          offer = undefined;
        } else {
          const joints = SERIAL_JOINTS.toReversed().filter(joint =>
            Math.abs(arm.current[joint] - arm.rest[joint]) * arm.scale(joint) > Math.max(0.5, arm.scale(joint)));
          const token = joints.length ? crypto.randomUUID() : null;
          offer = token ? {token, joints, pose: arm.current} : undefined;
          return {token, joints, arm: arm.snapshot()};
        }
        return arm.snapshot();
      case "return-rest": {
        if (replay || !offer || offer.token !== data.token) throw new Error("Review the return to rest again.");
        const reviewed = offer;
        offer = preview = undefined;
        arm.stopped = false;
        const expected = {...reviewed.pose};
        for (const joint of reviewed.joints) {
          if (arm.stopped) throw new Error("Movement stopped. Review the arm pose.");
          await arm.moveTo(joint, arm.rest[joint], expected);
          expected[joint] = arm.rest[joint];
        }
        arm.current = await arm.bus.positions();
        arm.initial = arm.current;
        if (!arm.atRest()) throw new Error("The live pose is outside the saved rest tolerance.");
        return arm.snapshot();
      }
      case "deploy": {
        if (replay || !preview?.targets || preview.id !== data.preview_id) throw new Error("Preview the current program first.");
        arm.current = await arm.bus.positions();
        arm.verifyStartingPose(arm.initial, arm.current);
        const {targets} = preview;
        replay = {id: crypto.randomUUID(), index: 0, targets, expected: {...arm.initial}};
        arm.stopped = false;
        return {...nextStep(), targets: targets.map(reviewTargets)};
      }
      case "move": {
        if (!replay || replay.id !== data.plan_id || replay.index !== data.index) throw new Error("This step is no longer current.");
        const targets = replay.targets[replay.index];
        try {
          const results = await arm.moveTogether(targets, replay.expected);
          Object.assign(replay.expected, targets);
          replay.index++;
          return {...nextStep(), arm: arm.snapshot(), results, result_index: data.index};
        } catch (error) {
          replay = preview = undefined;
          throw error;
        }
      }
      case "discard":
        replay = preview = undefined;
        return {};
      default:
        throw new Error("Use the local bridge for this arm setup operation.");
    }
  }

  async function request(action, data = {}) {
    if (code) {
      if (action === "compile") {
        const route = await hostedPython.parse(data.source);
        if (route.steps.some(step => step.actions)) {
          throw new Error("For simultaneous moves, disconnect the bridge and reconnect the calibrated arm by USB.");
        }
      }
      if (action === "export-lerobot") return {code: await hostedPython.exportFunction(data.source)};
      return bridge(action, data);
    }
    if (action === "stop") {
      if (follower) follower.stopped = true;
      return {};
    }
    if (action === "telemetry") {
      if (!follower) return {arm: null, live: false};
      if (busy) return {arm: follower.snapshot(), joints: follower.activeJoints, live: follower.moving};
      if (scan) return {arm: follower.snapshot(), live: false};
      try {
        scan = follower.bus.positions();
        follower.current = await scan;
        return {arm: follower.snapshot(), live: true};
      } finally {
        scan = undefined;
      }
    }
    if (busy) throw new Error("The USB connection is busy. Try again.");
    busy = true;
    try {
      if (scan) await scan.catch(() => {});
      return await dispatch(action, data);
    }
    finally { busy = false; }
  }

  return {
    get mode() { return code ? "bridge" : follower ? "usb" : null; },
    supportsUSB: "serial" in navigator,
    async pair(pairingCode) {
      if (follower || code || !pairingCode) throw new Error("Enter the bridge’s pairing code with USB disconnected.");
      code = pairingCode;
      try {
        const session = await bridge("session");
        await bridge("settings");
        return session;
      } catch (error) {
        code = undefined;
        throw error;
      }
    },
    request,
    connectUSB,
  };
})();
