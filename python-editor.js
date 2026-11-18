"use strict";

const PYTHON_MODE = {name: "python", version: 3};
const PYTHON_THEME = "material-darker";

function attachPythonEditor(textarea, preview) {
  if (!window.CodeMirror) return;
  const methods = [
    {text: "send_action", displayText: "send_action(targets: dict[str, float])", className: "python-api-hint"},
    {text: "get_observation", displayText: "get_observation() → dict[str, float]", className: "python-api-hint"},
  ];
  const keywords = ["def", "for", "in", "range", "int", "float", "robot"];

  function hints(editor, explicit = false) {
    const cursor = editor.getCursor();
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const quotedKey = before.match(/["']([a-z_.]*)$/);
    const method = before.match(/\brobot\.([a-z_]*)$/);
    const token = editor.getTokenAt(cursor);
    let list, partial;
    if (token.type?.includes("comment")) return;
    if (quotedKey) {
      partial = quotedKey[1];
      list = Object.entries(JOINTS).map(([joint, name]) => ({
        text: joint + ".pos",
        displayText: joint + ".pos — " + name + (joint === "gripper" ? " (%)" : " (degrees)"),
      }));
    } else if (method) {
      partial = method[1];
      list = methods;
    } else {
      partial = before.match(/[a-z_]+$/)?.[0] ?? "";
      if (!partial && !explicit) return;
      list = keywords.map(text => ({text}));
    }
    list = list.filter(item => item.text.startsWith(partial) && item.text !== partial);
    if (!list.length) return;
    let end = cursor.ch;
    const after = editor.getLine(cursor.line).slice(end);
    end += (quotedKey ? after.match(/^[a-z_.]*/) : after.match(/^[a-z_]*/))[0].length;
    return {list, from: CodeMirror.Pos(cursor.line, cursor.ch - partial.length),
      to: CodeMirror.Pos(cursor.line, end)};
  }

  const editor = CodeMirror.fromTextArea(textarea, {
    mode: PYTHON_MODE,
    theme: PYTHON_THEME,
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    inputStyle: "contenteditable",
    screenReaderLabel: "Python program",
    extraKeys: {
      Tab: editor => editor.somethingSelected() ? editor.indentSelection("add")
        : editor.replaceSelection("    "),
      "Shift-Tab": "indentLess",
      "Ctrl-Space": editor => editor.showHint({hint: cm => hints(cm, true), completeSingle: false}),
      "Ctrl-Enter": preview,
      "Cmd-Enter": preview,
      Esc: () => document.getElementById("expand-editor").focus(),
    },
  });
  editor.on("change", () => {
    editor.save();
    textarea.dispatchEvent(new Event("input"));
  });
  editor.on("inputRead", (cm, change) => {
    if (change.origin === "+input" && !cm.state.completionActive) {
      cm.showHint({hint: hints, completeSingle: false});
    }
  });
  return editor;
}
