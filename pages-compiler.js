"use strict";

const hostedPython = (() => {
  let worker, nextId = 0;
  const requests = new Map();
  const scriptURL = new URL(document.currentScript.src);
  const workerURL = new URL("pages-python-worker.js", scriptURL);
  workerURL.search = scriptURL.search;

  function startWorker() {
    const runtime = new Worker(workerURL, {type: "module"});
    runtime.onmessage = ({data: {id, value, error}}) => {
      const request = requests.get(id);
      if (!request) return;
      requests.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(value);
    };
    runtime.onerror = () => {
      const error = new Error("The browser Python compiler stopped. Try the preview again.");
      for (const request of requests.values()) request.reject(error);
      requests.clear();
      runtime.terminate();
      worker = undefined;
    };
    return runtime;
  }

  function run(source, exportFunction) {
    worker ??= startWorker();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      requests.set(id, {resolve, reject});
      worker.postMessage({id, source, exportFunction});
    });
  }

  return {
    example: `def route(robot):
    robot.send_action({"wrist_roll.pos": -5})
    robot.send_action({"wrist_roll.pos": 0})
`,
    parse: source => run(source, false),
    exportFunction: source => run(source, true),
  };
})();
