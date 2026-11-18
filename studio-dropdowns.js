"use strict";

const studioSelections = new Map();
let activeStudioDropdown;

function closeStudioDropdown() {
  if (activeStudioDropdown?.matches(":popover-open")) activeStudioDropdown.hidePopover();
}

function positionStudioDropdown(panel, trigger) {
  const bounds = trigger.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  panel.style.minWidth = Math.min(bounds.width, viewportWidth - 16) + "px";
  const width = panel.offsetWidth;
  const anchor = panel.classList.contains("select-menu") ? bounds.left : bounds.right - width;
  const left = Math.max(8, Math.min(anchor, viewportWidth - width - 8));
  const below = innerHeight - bounds.bottom - 14;
  const above = bounds.top - 14;
  const flip = below < panel.scrollHeight && above > below;
  panel.style.maxHeight = Math.max(0, flip ? above : below) + "px";
  panel.style.left = left + "px";
  panel.style.top = (flip ? bounds.top - panel.offsetHeight - 6 : bounds.bottom + 6) + "px";
}

function attachStudioDropdown(trigger, panel, beforeOpen = () => {}) {
  const rows = () => [...panel.querySelectorAll("button:not(:disabled)")];
  const position = () => {
    if (panel.matches(":popover-open")) positionStudioDropdown(panel, trigger);
  };

  function open(direction = 1) {
    if (trigger.disabled) return;
    beforeOpen();
    panel.showPopover();
    activeStudioDropdown = panel;
    trigger.setAttribute("aria-expanded", "true");
    position();
    const options = rows();
    const selected = options.find(option => option.getAttribute("aria-selected") === "true");
    (selected ?? options.at(direction === 1 ? 0 : -1))?.focus();
  }

  trigger.addEventListener("click", () => {
    if (panel.matches(":popover-open")) panel.hidePopover();
    else open();
  });
  trigger.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!panel.matches(":popover-open")) open(event.key === "ArrowDown" ? 1 : -1);
  });
  panel.addEventListener("toggle", () => {
    const expanded = panel.matches(":popover-open");
    trigger.setAttribute("aria-expanded", String(expanded));
    if (!expanded && activeStudioDropdown === panel) activeStudioDropdown = undefined;
  });
  panel.addEventListener("click", event => {
    if (!event.target.closest("button:not(:disabled)")) return;
    panel.hidePopover();
    trigger.focus({preventScroll: true});
  }, {capture: true});
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      panel.hidePopover();
      trigger.focus({preventScroll: true});
      return;
    }
    const options = rows();
    if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const direction = {ArrowDown: 1, ArrowUp: -1}[event.key];
    let next;
    if (direction) next = options[(index + direction + options.length) % options.length];
    else if (event.key === "Home") next = options[0];
    else if (event.key === "End") next = options.at(-1);
    else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const ordered = options.slice(index + 1).concat(options.slice(0, index + 1));
      next = ordered.find(option => option.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", event => {
    if (event.target !== panel) position();
  }, {capture: true});
}

function dropdownIcon(name) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#glyph-" + name);
  icon.append(use);
  return icon;
}

function attachStudioSelect(select) {
  const label = select.labels[0];
  const name = label?.textContent.trim() ?? select.getAttribute("aria-label");
  const trigger = document.createElement("button");
  const value = document.createElement("span");
  const box = document.createElement("div");
  const panel = document.createElement("div");
  box.className = "dropdown-field";
  trigger.type = "button";
  trigger.id = select.id + "-trigger";
  trigger.className = "dropdown-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.append(value, dropdownIcon("chevron"));
  panel.id = select.id + "-options";
  panel.className = "studio-dropdown select-menu";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-label", name);
  panel.setAttribute("popover", "auto");
  trigger.setAttribute("aria-controls", panel.id);
  select.before(box);
  box.append(trigger, panel, select);
  select.hidden = true;
  if (label) label.htmlFor = trigger.id;

  function sync() {
    value.textContent = select.selectedOptions[0]?.text ?? "Choose…";
    trigger.setAttribute("aria-label", name + ": " + value.textContent);
    trigger.disabled = select.disabled || !select.options.length;
    if (trigger.disabled && panel.matches(":popover-open")) panel.hidePopover();
    for (const [index, option] of [...panel.children].entries()) {
      option.setAttribute("aria-selected", String(index === select.selectedIndex));
    }
  }

  attachStudioDropdown(trigger, panel, () => {
    panel.replaceChildren(...[...select.options].map((option, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.disabled = option.disabled;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      const text = document.createElement("span");
      text.textContent = option.text;
      item.append(text, dropdownIcon("check"));
      item.onclick = () => {
        if (select.disabled || option.disabled || select.selectedIndex === index) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event("input", {bubbles: true}));
        select.dispatchEvent(new Event("change", {bubbles: true}));
      };
      return item;
    }));
  });
  studioSelections.set(select, sync);
  new MutationObserver(sync).observe(select, {
    attributes: true, attributeFilter: ["disabled"], childList: true, subtree: true,
  });
  select.addEventListener("change", sync);
  sync();
}

function selectStudioValue(select, value) {
  select.value = value;
  studioSelections.get(select)?.();
}
