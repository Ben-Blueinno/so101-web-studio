const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../studio.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function studio(overrides = {}) {
  const nodes = new Map();
  const calls = [];
  const handlers = {};
  const context = vm.createContext({
    get: id => {
      if (!nodes.has(id)) nodes.set(id, {hidden: false});
      return nodes.get(id);
    },
    tabs: [], taskStages: new Map(), armCards: new Map(), modeSelector: {}, code: {},
    previewId: undefined, missingFollowers: [], initialized: true, armSnapshots: {},
    currentStep: undefined, render: true, moving: false, actionPending: false,
    returningToRest: false, compiling: false, simulating: false, calibrating: false,
    pythonEditor: undefined, animation: 0, deploymentStatus: {},
    updateComponentCards() {}, drawPose() {},
    hook: (id, callback) => { handlers[id] = callback; },
    selectView: view => calls.push(['view', view]),
    api: async (action, data) => { calls.push([action, data]); return {plan_id: 'plan'}; },
    showStep: step => { context.currentStep = step; },
    ...overrides,
  });
  const controls = source.slice(source.indexOf('function updateControls()'), source.indexOf('function drawScene('));
  const reset = source.slice(source.indexOf('function resetPreview('), source.indexOf('const codeLines'));
  const deploy = source.slice(source.indexOf('hook("deploy",'), source.indexOf('hook("move",'));
  vm.runInContext(controls + reset + deploy, context);
  return {context, nodes, calls, prepare: handlers.deploy};
}

test('deployment handoff is beside Play and absent from the deployment panel', () => {
  const simulation = html.slice(html.indexOf('id="program"'), html.indexOf('id="simulation-side-panel"'));
  assert.match(simulation, /id="preview"[\s\S]*?id="deploy"[^>]*hidden/);
  const deployment = html.slice(html.indexOf('id="deployment"'), html.indexOf('id="hardware"'));
  assert.doesNotMatch(deployment, /id="deploy"/);
});

test('handoff stays hidden until a simulation finishes and hides on invalidation', () => {
  const s = studio();
  s.context.updateControls();
  assert.equal(s.nodes.get('deploy').hidden, true);
  s.context.previewId = 'finished-preview';
  s.context.updateControls();
  assert.equal(s.nodes.get('deploy').hidden, false);
  assert.equal(s.nodes.get('deploy').disabled, false);
  s.context.resetPreview(false);
  assert.equal(s.nodes.get('deploy').hidden, true);
});

test('hidden or stale simulation cannot prepare a hardware route', async () => {
  for (const state of [{}, {previewId: 'p', simulating: true}, {previewId: 'p', compiling: true},
    {previewId: 'p', missingFollowers: ['B']}, {previewId: 'p', initialized: false},
    {previewId: 'p', currentStep: {plan_id: 'existing'}}, {previewId: 'p', actionPending: true}]) {
    const s = studio(state);
    await s.prepare();
    assert.deepEqual(s.calls, []);
  }
});

test('valid handoff opens Deployment and prepares exactly that preview without movement', async () => {
  const s = studio({previewId: 'finished-preview'});
  await s.prepare();
  assert.equal(s.calls[0][0], 'view');
  assert.equal(s.calls[0][1], 'deployment');
  assert.equal(s.calls[1][0], 'deploy');
  assert.equal(s.calls[1][1].preview_id, 'finished-preview');
  assert.equal(s.calls.length, 2);
  assert.equal(s.context.currentStep.plan_id, 'plan');
});

test('animation completion unlocks handoff, but a cancelled animation cannot unlock it later', () => {
  for (const cancel of [false, true]) {
    const frames = [];
    const s = studio({initialized: false, previewStatus: {},
      liveModels: () => ({}), drawScene() {}, targetText: () => 'wrist roll',
      routeActions: step => [step], field: () => 'delta', GRIP_HOME: 0,
      requestAnimationFrame: callback => frames.push(callback),
    });
    vm.runInContext(source.slice(source.indexOf('function animate('), source.indexOf('hook("preview",')), s.context);
    s.context.animate({steps: [{follower: 'A', joint: 'wrist_roll', delta: 3}]}, 'finished-preview', ['A']);
    s.context.updateControls();
    assert.equal(s.nodes.get('deploy').hidden, true);
    if (cancel) s.context.resetPreview(false);
    let now = 0;
    while (frames.length) frames.shift()(now += 1000);
    assert.equal(s.nodes.get('deploy').hidden, cancel);
    assert.equal(s.context.previewId, cancel ? undefined : 'finished-preview');
  }
});
