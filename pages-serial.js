"use strict";

// Feetech STS protocol used by LeRobot’s SO-101 follower.
const SERIAL_JOINTS = Object.keys(JOINTS);
const SERVO_ID = Object.fromEntries(SERIAL_JOINTS.map((joint, index) => [joint, index + 1]));
const TICK_DEGREES = 360 / 4095;
const SERIAL_REG = Object.freeze({model: 3, limits: 9, maxLimit: 11, offset: 31, mode: 33,
  torque: 40, goal: 42, lock: 55, position: 56});
const serialDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function servoPacket(id, instruction, args) {
  const body = [id, args.length + 2, instruction, ...args];
  return Uint8Array.of(255, 255, ...body, (~body.reduce((sum, byte) => sum + byte, 0)) & 255);
}

function word(bytes, offset = 0) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

class ServoSerial {
  static async open(port) {
    if (!port.getInfo().usbVendorId) throw new Error("Choose the USB serial adapter connected to the arm.");
    await port.open({baudRate: 1_000_000});
    return new ServoSerial(port);
  }

  constructor(port) {
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.buffer = [];
    this.readTask = this.listen();
    this.closed = false;
  }

  async listen() {
    try {
      for (;;) {
        const {done, value} = await this.reader.read();
        if (done) break;
        for (const byte of value) this.buffer.push(byte);
        this.receive();
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.failure ??= new Error("The USB serial port closed.");
      this.pending?.reject(this.failure);
    }
  }

  receive() {
    while (this.buffer.length >= 6) {
      if (this.buffer[0] !== 255 || this.buffer[1] !== 255 ||
          this.buffer[3] < 2 || this.buffer[3] > 48) {
        this.buffer.shift();
        continue;
      }
      const size = this.buffer[3] + 4;
      if (this.buffer.length < size) return;
      const frame = this.buffer.splice(0, size);
      const valid = (frame.slice(2).reduce((sum, byte) => sum + byte, 0) & 255) === 255;
      const pending = this.pending;
      if (!valid || !pending || frame[2] !== pending.id) continue;
      if (frame.length === pending.echo.length && frame.every((byte, i) => byte === pending.echo[i])) continue;
      if (frame[4]) pending.reject(new Error(`Servo ${frame[2]} reported status 0x${frame[4].toString(16)}.`));
      else if (frame[3] === pending.count + 2) pending.resolve(frame.slice(5, -1));
    }
  }

  async read(id, address, count) {
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error("The serial bus is busy.");
    const packet = servoPacket(id, 2, [address, count]);
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = {id, count, resolve, reject, echo: packet};
        timer = setTimeout(() => {
          this.failure = new Error(`Servo ${id} did not respond. Check arm power, cabling, and the selected USB port.`);
          reject(this.failure);
        }, 450);
        this.writer.write(packet).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }

  async write(address, values, bytes) {
    if (this.failure) throw this.failure;
    const args = Object.entries(values).flatMap(([joint, value]) =>
      bytes === 1 ? [SERVO_ID[joint], value] : [SERVO_ID[joint], value & 255, value >> 8]);
    await this.writer.write(servoPacket(254, 131, [address, bytes, ...args]));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.reader.cancel().catch(() => {});
    await this.readTask;
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.port.close();
  }

  async calibrationRegisters() {
    const calibration = {};
    for (const [joint, id] of Object.entries(SERVO_ID)) {
      if (word(await this.read(id, SERIAL_REG.model, 2)) !== 777) {
        throw new Error(`Servo ${id} is not an STS3215. Check the selected controller.`);
      }
      const range = await this.read(id, SERIAL_REG.limits, 4);
      const config = await this.read(id, SERIAL_REG.offset, 3);
      const range_min = word(range), range_max = word(range, 2);
      const offset = word(config);
      calibration[joint] = {id, mode: config[2], homing_offset: (offset & 2048 ? -1 : 1) * (offset & 2047),
                            range_min, range_max};
    }
    return calibration;
  }

  async calibration() {
    const registers = await this.calibrationRegisters();
    return Object.fromEntries(SERIAL_JOINTS.map(joint => {
      const {id, mode, homing_offset, range_min, range_max} = registers[joint];
      if (mode !== 0 || range_max > 4095 || range_max - range_min < 20 ||
          (joint !== "wrist_roll" && range_min === 0 && range_max === 4095)) {
        throw new Error(`${JOINTS[joint]} needs calibration. Open Calibration and choose Calibrate new or Restore saved calibration.`);
      }
      return [joint, {id, drive_mode: 0, homing_offset, range_min, range_max}];
    }));
  }

  async writeVerified(register, values, bytes) {
    await this.write(register, values, bytes);
    await serialDelay(25);
    for (const [joint, expected] of Object.entries(values)) {
      const data = await this.read(SERVO_ID[joint], register, bytes);
      if ((bytes === 1 ? data[0] : word(data)) !== expected) {
        throw new Error(`${JOINTS[joint]} did not verify calibration register ${register}.`);
      }
    }
  }

  setCalibrationControl(register, value) {
    return this.writeVerified(register, Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, value])), 1);
  }

  async writeCalibration(registers, previous) {
    const values = read => Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, read(registers[joint])]));
    const writeRegisters = async data => {
      const field = key => Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, data[joint][key]]));
      await this.writeVerified(SERIAL_REG.limits, values(() => 0), 2);
      await this.writeVerified(SERIAL_REG.maxLimit, field("range_max"), 2);
      await this.writeVerified(SERIAL_REG.limits, field("range_min"), 2);
      await this.writeVerified(SERIAL_REG.offset, Object.fromEntries(SERIAL_JOINTS.map(joint => {
        const offset = data[joint].homing_offset;
        return [joint, offset < 0 ? 2048 | -offset : offset];
      })), 2);
      await this.writeVerified(SERIAL_REG.mode, field("mode"), 1);
    };
    let unlocked = false;
    try {
      await this.setCalibrationControl(SERIAL_REG.torque, 0);
      unlocked = true;
      await this.setCalibrationControl(SERIAL_REG.lock, 0);
      await writeRegisters(registers);
      await this.setCalibrationControl(SERIAL_REG.lock, 1);
    } catch (error) {
      if (!unlocked) throw error;
      try {
        await this.setCalibrationControl(SERIAL_REG.lock, 0);
        await writeRegisters(previous);
        await this.setCalibrationControl(SERIAL_REG.lock, 1);
      } catch {
        throw new Error(`${error.message} The original settings could not be verified. Reconnect and restore a saved calibration before running a route.`);
      }
      throw new Error(`${error.message} The original calibration was restored.`);
    }
  }

  async positions() {
    const pose = {};
    for (const [joint, id] of Object.entries(SERVO_ID)) {
      const position = word(await this.read(id, SERIAL_REG.position, 2));
      if (position > 4095) throw new Error(`${JOINTS[joint]} returned an invalid position.`);
      pose[joint] = position;
    }
    return pose;
  }
}

class BrowserFollower {
  constructor(bus, label, calibration, directions, current) {
    this.bus = bus;
    this.label = label;
    this.calibration = calibration;
    this.directions = directions;
    this.current = this.initial = this.rest = current;
    this.moving = false;
    this.holding = false;
  }

  scale(joint) {
    const {range_min, range_max} = this.calibration[joint];
    return joint === "gripper" ? 100 / (range_max - range_min) : TICK_DEGREES;
  }

  origin(joint) {
    const {range_min, range_max} = this.calibration[joint];
    return joint === "gripper" ? range_min : (range_min + range_max) / 2;
  }

  units(joint, raw) {
    return (raw - this.origin(joint)) * this.scale(joint);
  }

  model(raw) {
    return Object.fromEntries(SERIAL_JOINTS.map(joint => {
      const value = this.units(joint, raw[joint]), sign = this.directions[joint];
      const [min, max] = LIMITS[joint];
      return [joint, (joint === "gripper" ? (sign === 1 ? 0 : 100) : (min + max) / 2) + sign * value];
    }));
  }

  atRest(pose = this.current) {
    return SERIAL_JOINTS.every(joint => Math.abs(this.units(joint, pose[joint]) -
      this.units(joint, this.rest[joint])) <= Math.max(0.5, this.scale(joint)));
  }

  snapshot() {
    return {label: this.label,
      pose: Object.fromEntries(SERIAL_JOINTS.map(joint => [joint + ".pos", this.units(joint, this.current[joint])])),
      model_pose: this.model(this.current), preview_start: this.model(this.initial),
      at_rest: this.atRest()};
  }

  validatePositions(pose) {
    for (const [joint, raw] of Object.entries(pose)) {
      const {range_min, range_max} = this.calibration[joint];
      if (!Number.isInteger(raw) || raw < range_min || raw > range_max) {
        throw new Error(`${JOINTS[joint]} is outside its calibrated limits.`);
      }
    }
  }

  verifyStartingPose(expected, actual) {
    if (SERIAL_JOINTS.some(joint =>
      Math.abs(actual[joint] - expected[joint]) * this.scale(joint) > (joint === "gripper" ? 3 : 2))) {
      throw new Error("The arm left the reviewed starting pose. Read the pose and preview again.");
    }
  }

  async holdCurrentPose() {
    if (this.holding || this.stopped) return;
    this.validatePositions(this.current);
    await this.bus.write(SERIAL_REG.goal, this.current, 2);
    for (const [joint, id] of Object.entries(SERVO_ID)) {
      const goal = word(await this.bus.read(id, SERIAL_REG.goal, 2));
      if (goal !== this.current[joint]) throw new Error(`${JOINTS[joint]} did not accept its holding position.`);
    }
    if (this.stopped) return;
    this.holding = true;
    await this.bus.write(SERIAL_REG.torque, Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, 1])), 1);
  }

  target(joint, goal) {
    const {range_min, range_max} = this.calibration[joint];
    if (!(this.units(joint, range_min) <= goal && goal <= this.units(joint, range_max))) {
      throw new Error(`${JOINTS[joint]} target is outside its calibrated limits.`);
    }
    const raw = Math.round(this.origin(joint) + goal / this.scale(joint));
    return raw;
  }

  async moveTo(joint, target, expected) {
    const [result] = await this.moveTogether({[joint]: target}, expected);
    return result;
  }

  async moveTogether(targets, expected) {
    this.validatePositions(targets);
    this.moving = true;
    this.activeJoints = Object.keys(targets);
    try {
      this.current = await this.bus.positions();
      this.verifyStartingPose(expected, this.current);
      const axes = Object.entries(targets).map(([joint, target]) => {
        const before = this.current[joint], scale = this.scale(joint);
        return {joint, target, before, scale, bestError: Math.abs(target - before),
                tolerance: Math.max(1, Math.floor(0.5 / scale)),
                maxLead: Math.max(1, Math.floor(1 / scale)), lastProgress: undefined};
      });
      const start = performance.now();
      const duration = Math.max(2500, ...axes.map(axis => axis.bestError * axis.scale * 200));
      let finalCommanded = false;
      let settledSince;
      while (true) {
        if (this.stopped) throw new Error("Movement stopped. Review the arm pose.");
        this.current = await this.bus.positions();
        this.validatePositions(this.current);
        const stationary = {...expected};
        for (const {joint} of axes) stationary[joint] = this.current[joint];
        this.verifyStartingPose(stationary, this.current);
        if (this.stopped) throw new Error("Movement stopped. Review the arm pose.");
        const now = performance.now();
        if (axes.every(({joint, target, tolerance}) => Math.abs(this.current[joint] - target) <= tolerance)) {
          if (!finalCommanded) {
            await this.holdCurrentPose();
            if (this.stopped) throw new Error("Movement stopped. Review the arm pose.");
            // Leave the servo holding the requested target, not an interpolation step.
            await this.bus.write(SERIAL_REG.goal, targets, 2);
            for (const {joint, target} of axes) {
              if (this.stopped) throw new Error("Movement stopped. Review the arm pose.");
              const goal = word(await this.bus.read(SERVO_ID[joint], SERIAL_REG.goal, 2));
              if (goal !== target) throw new Error(`${JOINTS[joint]} did not accept its final target.`);
            }
            finalCommanded = true;
          } else {
            settledSince ??= now;
            if (now - settledSince >= 500) {
              return axes.map(({joint, before, target}) => ({joint, before: this.units(joint, before),
                measured: this.units(joint, this.current[joint]), target: this.units(joint, target)}));
            }
          }
        } else {
          settledSince = undefined;
        }
        if (!this.holding && !this.stopped) await this.holdCurrentPose();
        const progress = Math.min(1, (now - start) / duration);
        const goals = {};
        for (const axis of axes) {
          const {joint, before, target, tolerance, maxLead} = axis;
          const current = this.current[joint], error = Math.abs(target - current);
          if (error <= tolerance || error < axis.bestError) {
            axis.bestError = error;
            if (axis.lastProgress !== undefined) axis.lastProgress = now;
          }
          if (error <= tolerance) continue;
          if (now - axis.lastProgress >= 3000 || now - start >= duration + 8000) {
            throw new Error(`${JOINTS[joint]} did not reach the target. Review the live pose before trying again.`);
          }
          if (finalCommanded) continue;
          const planned = before + Math.trunc((target - before) * progress);
          const sign = Math.sign(target - current);
          const available = Math.min(error, maxLead);
          const lead = Math.min(available, (planned - current) * sign);
          if (lead > 0) {
            goals[joint] = current + sign * lead;
            if (lead === available) axis.lastProgress ??= now;
          }
        }
        if (Object.keys(goals).length && !this.stopped) await this.bus.write(SERIAL_REG.goal, goals, 2);
        await serialDelay(50);
      }
    } finally {
      this.moving = false;
      this.activeJoints = undefined;
    }
  }

  async close() {
    try {
      if (this.holding) await this.bus.write(SERIAL_REG.torque, Object.fromEntries(SERIAL_JOINTS.map(joint => [joint, 0])), 1);
    } finally {
      await this.bus.close();
    }
  }
}
