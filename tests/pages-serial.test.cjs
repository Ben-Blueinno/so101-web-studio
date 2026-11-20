const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const joints = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];
const source = fs.readFileSync(path.join(__dirname, '../pages-serial.js'), 'utf8');

function controller(options = {}) {
  let now = 0;
  let arm;
  const commands = [];
  const samples = [];
  const pose = Object.fromEntries(joints.map(joint => [joint, 2000]));
  const goals = {...pose};
  let exactAt;
  const targets = options.targets ?? {elbow_flex: 2040};
  const context = vm.createContext({
    JOINTS: Object.fromEntries(joints.map(joint => [joint, joint])),
    performance: {now: () => now},
    setTimeout: (callback, delay) => {
      now += delay;
      options.onTick?.({now, arm, exactAt});
      callback();
    },
  });
  vm.runInContext(source + '\nthis.Controller = BrowserFollower;', context);
  const bus = {
    async positions() {
      for (const joint of joints) {
        pose[joint] += Math.sign(goals[joint] - pose[joint]) * Math.min(3, Math.abs(goals[joint] - pose[joint]));
      }
      options.onSample?.({now, pose, goals, exactAt, targets});
      samples.push({now, pose: {...pose}});
      return {...pose};
    },
    async write(register, values) {
      assert.ok(register === 42 || register === 40);
      commands.push({now, register, values: {...values}});
      if (register === 42) {
        Object.assign(goals, values);
        if (Object.keys(targets).every(joint => values[joint] === targets[joint])) exactAt ??= now;
      }
      options.onWrite?.({register, arm});
    },
    async read(id, register) {
      assert.equal(register, 42);
      const goal = options.onRead?.({id, exactAt, goals}) ?? goals[joints[id - 1]];
      return Uint8Array.of(goal & 255, goal >> 8);
    },
  };
  const calibration = Object.fromEntries(joints.map(joint => [joint, {range_min: 1000, range_max: 3000}]));
  arm = new context.Controller(bus, 'A', calibration, {}, {...pose});
  arm.holding = options.holding ?? true;
  return {arm, commands, samples, targets, expected: {...pose}, clock: () => now, exactAt: () => exactAt};
}

test('commands the exact final goal and verifies it for at least 500 ms', async () => {
  const run = controller();
  await run.arm.moveTogether(run.targets, run.expected);
  assert.equal(run.commands.at(-1).values.elbow_flex, 2040);
  assert.ok(run.clock() - run.exactAt() >= 500);
  assert.ok(run.samples.at(-1).pose.elbow_flex >= 2035);
});

test('sends exact goals even when all axes start within tolerance', async () => {
  const run = controller({targets: {elbow_flex: 2003, shoulder_lift: 1997}});
  await run.arm.moveTogether(run.targets, run.expected);
  assert.deepEqual(run.commands.at(-1).values, run.targets);
  assert.ok(run.clock() >= 500);
});

test('delivers exact final goals for simultaneous axes', async () => {
  const run = controller({targets: {elbow_flex: 2040, shoulder_lift: 1960}});
  await run.arm.moveTogether(run.targets, run.expected);
  assert.deepEqual(run.commands.at(-1).values, run.targets);
  assert.ok(run.clock() - run.exactAt() >= 500);
});

test('restarts continuous hold verification after transient drift', async () => {
  const run = controller({
    targets: {elbow_flex: 2003},
    onSample({now, pose, exactAt}) {
      if (exactAt !== undefined && now - exactAt >= 150 && now - exactAt <= 250) pose.elbow_flex = 2010;
    },
  });
  await run.arm.moveTogether(run.targets, run.expected);
  assert.ok(run.clock() - run.exactAt() >= 800);
  assert.ok(run.commands.every(command => command.values.elbow_flex === 2003));
});

test('does not report success if the final goal cannot be held', async () => {
  const run = controller({
    targets: {elbow_flex: 2003},
    onSample({pose, exactAt}) {
      if (exactAt !== undefined) pose.elbow_flex = 2010;
    },
  });
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /did not reach the target/);
  assert.equal(run.arm.moving, false);
});

test('Stop interrupts settling and prevents further goal writes', async () => {
  const run = controller({
    targets: {elbow_flex: 2003},
    onTick({now, arm, exactAt}) {
      if (exactAt !== undefined && now - exactAt >= 200) arm.stopped = true;
    },
  });
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /Movement stopped/);
  assert.ok(run.commands.every(command => command.now < run.clock()));
  assert.equal(run.arm.moving, false);
});

test('establishes holding before a near-target final command', async () => {
  const run = controller({targets: {elbow_flex: 2003}, holding: false});
  await run.arm.moveTogether(run.targets, run.expected);
  assert.equal(run.commands[0].register, 42);
  assert.equal(run.commands[1].register, 40);
  assert.equal(run.commands[2].values.elbow_flex, 2003);
  assert.ok(run.clock() - run.exactAt() >= 500);
});

test('Stop during holding setup prevents the final command', async () => {
  const run = controller({
    targets: {elbow_flex: 2003}, holding: false,
    onWrite({register, arm}) {
      if (register === 40) arm.stopped = true;
    },
  });
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /Movement stopped/);
  assert.equal(run.exactAt(), undefined);
});

test('rejects out-of-range targets before any servo command', async () => {
  const run = controller({targets: {elbow_flex: 3001}});
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /outside its calibrated limits/);
  assert.equal(run.commands.length, 0);
});

test('checks stationary joints throughout settling', async () => {
  const run = controller({
    targets: {elbow_flex: 2003},
    onSample({pose, exactAt}) {
      if (exactAt !== undefined) pose.shoulder_pan = 2030;
    },
  });
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /left the reviewed starting pose/);
  assert.equal(run.arm.moving, false);
});

test('uses the gripper percentage tolerance while verifying its hold', async () => {
  const run = controller({targets: {gripper: 2080}});
  await run.arm.moveTogether(run.targets, run.expected);
  assert.equal(run.commands.at(-1).values.gripper, 2080);
  assert.ok(run.clock() - run.exactAt() >= 500);
});

test('rejects a final target that the servo did not accept', async () => {
  const run = controller({
    targets: {elbow_flex: 2003},
    onRead({id, exactAt}) {
      if (id === 3 && exactAt !== undefined) return 2002;
    },
  });
  await assert.rejects(run.arm.moveTogether(run.targets, run.expected), /did not accept its final target/);
  assert.equal(run.arm.moving, false);
});
