"use strict";

const runtimeURL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";
let pending;

async function load() {
  const {loadPyodide} = await import(runtimeURL + "pyodide.mjs");
  const python = await loadPyodide({indexURL: runtimeURL});
  for (const file of ["program_editor.py", "lerobot_export.py"]) {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`Could not load ${file}.`);
    python.FS.writeFile(file, await response.text());
  }
  python.runPython(`
import json
from program_editor import compile_program
from lerobot_export import export_lerobot

def request(source, export):
    try:
        data = export_lerobot(source, {}) if export else compile_program(source)
        return json.dumps({"data": data})
    except (ValueError, OverflowError, RecursionError) as error:
        return json.dumps({"error": str(error)})
`);
  return python.globals.get("request");
}

async function compile(source, exportFunction) {
  pending ??= load().catch(error => {
    pending = undefined;
    throw new Error("Could not load the browser Python compiler. Check your connection and try again.", {cause: error});
  });
  const request = await pending;
  const result = JSON.parse(request(source, exportFunction));
  if (Object.hasOwn(result, "error")) throw new Error(result.error);
  return result.data;
}

self.onmessage = async ({data: {id, source, exportFunction}}) => {
try {
  self.postMessage({id, value: await compile(source, exportFunction)});
} catch (error) {
  self.postMessage({id, error: error.message});
}
};
