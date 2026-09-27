import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const bundle = readFileSync(new URL("../ui/bundle.js", import.meta.url), "utf8");
const fixtures = JSON.parse(
  readFileSync(new URL("../docs/harness/demo.json", import.meta.url), "utf8"),
);

function element(type, props, ...children) {
  return { type, props: props || {}, children };
}

function createReact() {
  let active = null;

  function hook(kind, initialValue) {
    const index = active.cursor++;
    let slot = active.hooks[index];
    if (!slot) {
      slot = { kind, value: initialValue };
      active.hooks[index] = slot;
    }
    assert.equal(slot.kind, kind, "hook order stays stable");
    return slot;
  }

  return {
    Fragment: Symbol("Fragment"),
    createElement: element,
    useState(initialValue) {
      const slot = hook("state", initialValue);
      if (!slot.initialized) {
        slot.value = typeof initialValue === "function" ? initialValue() : initialValue;
        slot.initialized = true;
      }
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useRef(initialValue) {
      const slot = hook("ref", { current: initialValue });
      return slot.value;
    },
    useEffect(effect, dependencies) {
      const slot = hook("effect", undefined);
      const changed =
        !slot.initialized ||
        dependencies === undefined ||
        dependencies.some((value, index) => !Object.is(value, slot.dependencies[index]));
      if (changed) {
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.dependencies = dependencies;
        slot.initialized = true;
        active.pending.push(() => {
          slot.cleanup = effect();
        });
      }
    },
    useCallback(callback) {
      const slot = hook("callback", callback);
      return slot.value;
    },
    render(component, props = {}) {
      const previous = active;
      active = { hooks: [], cursor: 0, pending: [] };
      const record = active;
      const tree = component(props);
      active = previous;
      for (const commit of record.pending) commit();
      return tree;
    },
  };
}

function walk(node, predicate, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, predicate, result);
    return result;
  }
  if (!node || typeof node !== "object") return result;
  if (predicate(node)) result.push(node);
  walk(node.children, predicate, result);
  return result;
}

function findRegistration(registrations, slot) {
  const matches = registrations.filter((entry) => entry.slot === slot);
  assert.equal(matches.length, 1, slot + " keeps one registration");
  return matches[0].component;
}

function createPluginHarness({ state, action = true, locale = "en" }) {
  const React = createReact();
  const catalogs = {};
  const registrations = [];
  const modalCalls = [];
  const apiCalls = [];
  const Action = function Action() {};
  let definition;
  const window = {
    location: { search: "?ghsDemo=" + state },
    open() {},
    registerKandevPlugin(id, plugin) {
      assert.equal(id, "kandev-plugin-github-status");
      definition = plugin;
    },
  };

  runInNewContext(bundle, {
    window,
    URLSearchParams,
    console,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
  });

  const ui = action ? { Action } : {};
  const host = {
    React,
    jsx: element,
    ui,
    i18n: {
      useTranslation() {
        return {
          t(key, options = {}) {
            const message =
              (catalogs[locale] && catalogs[locale][key]) ||
              options.defaultValue ||
              key;
            const values = options.values || {};
            return message.replace(/\{\{([^}]+)\}\}/g, (match, name) =>
              Object.hasOwn(values, name) ? String(values[name]) : match,
            );
          },
        };
      },
    },
    api: {
      fetch(path) {
        apiCalls.push(path);
        if (path.startsWith("webhooks/ack")) {
          return Promise.resolve({ json: async () => ({ acknowledged: true }) });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => fixtures[state],
        });
      },
    },
    openModal(options) {
      modalCalls.push(options);
      return { close() {} };
    },
  };
  const registry = {
    registerTranslations(translations) {
      Object.assign(catalogs, translations);
    },
    registerComponent(slot, component) {
      registrations.push({ slot, component });
    },
  };
  definition.initialize(registry, host);

  return { React, Action, apiCalls, catalogs, host, modalCalls, registrations };
}

async function renderWithStatus(harness, component, props) {
  const first = harness.React.render(component, props);
  await new Promise((resolve) => setImmediate(resolve));
  const current = harness.React.render(component, props);
  return current === null ? first : current;
}

test("uses one localized semantic Action for healthy status and keeps healthy topbars absent", async () => {
  const harness = createPluginHarness({ state: "healthy" });
  const chip = findRegistration(harness.registrations, "app-status-bar-right");
  const main = findRegistration(harness.registrations, "main-top-bar");
  const chat = findRegistration(harness.registrations, "chat-top-bar");
  const chipTree = await renderWithStatus(harness, chip);
  const action = walk(chipTree, (node) => node.type === harness.Action)[0];

  assert.ok(action, "the new host receives one Action");
  assert.equal(action.props.label, "GitHub status");
  assert.equal(action.props.text, "GitHub");
  assert.equal(action.props.tone, "neutral");
  assert.equal(action.props.tooltip, "All systems operational. Open GitHub status details.");
  assert.equal(action.props.className, undefined);
  assert.equal(action.props.style, undefined);
  assert.equal(action.props.variant, undefined);
  assert.equal(walk(action, (node) => node.type === "button").length, 0);
  assert.equal(await renderWithStatus(harness, main), null);
  assert.equal(await renderWithStatus(harness, chat), null);
  assert.deepEqual(harness.catalogs.en.actionTooltip, "{{status}}{{details}}{{stale}}. Open GitHub status details.");
});

test("maps degraded, critical, and stale fixtures into status text, tone, tooltip, and details action", async (t) => {
  for (const fixture of [
    { state: "degraded", text: "Degraded", tone: "warning" },
    { state: "critical", text: "Major outage", tone: "danger" },
    { state: "stale", text: "Degraded", tone: "warning", badge: "Stale" },
  ]) {
    await t.test(fixture.state, async () => {
      const harness = createPluginHarness({ state: fixture.state });
      const chip = findRegistration(harness.registrations, "app-status-bar-right");
      const main = findRegistration(harness.registrations, "main-top-bar");
      const chat = findRegistration(harness.registrations, "chat-top-bar");
      const chipTree = await renderWithStatus(harness, chip);
      const chipAction = walk(chipTree, (node) => node.type === harness.Action)[0];
      const mainTree = await renderWithStatus(harness, main);
      const chatTree = await renderWithStatus(harness, chat);
      const mainAction = walk(mainTree, (node) => node.type === harness.Action)[0];
      const chatAction = walk(chatTree, (node) => node.type === harness.Action)[0];

      assert.ok(chipAction);
      assert.ok(mainAction);
      assert.ok(chatAction);
      for (const action of [chipAction, mainAction, chatAction]) {
        assert.equal(action.props.label, "GitHub status");
        assert.equal(action.props.tone, fixture.tone);
        assert.match(action.props.tooltip, /Open GitHub status details/);
        assert.equal(action.props.style, undefined, "the host owns responsive dimensions");
        assert.equal(action.props.className, undefined, "the host owns the action shell");
      }
      assert.equal(chipAction.props.text, fixture.text);
      assert.equal(chipAction.props.badge, fixture.badge);
      assert.match(chipAction.props.tooltip, new RegExp(fixtures[fixture.state].snapshot.incidents[0].name));
      assert.equal(mainAction.props.text, fixture.text);
      assert.equal(mainAction.props.badge, fixture.badge);
      assert.equal(chatAction.props.text, fixture.text);
      assert.equal(chatAction.props.badge, fixture.badge);

      mainAction.props.onClick({ type: "keyboard-or-pointer-activation" });
      assert.equal(harness.modalCalls.length, 1, "the action opens the existing details modal");
      assert.equal(harness.modalCalls[0].title, "GitHub Status");
      assert.equal(typeof harness.modalCalls[0].content, "function");
    });
  }
});

test("uses plugin translations and values interpolation for the complete action details", async () => {
  const harness = createPluginHarness({ state: "critical", locale: "pt-pt" });
  const chip = findRegistration(harness.registrations, "app-status-bar-right");
  const action = walk(
    await renderWithStatus(harness, chip),
    (node) => node.type === harness.Action,
  )[0];

  assert.equal(action.props.label, "Estado do GitHub");
  assert.equal(action.props.text, "Interrupção grave");
  assert.match(action.props.tooltip, /^Interrupção grave/);
  assert.match(action.props.tooltip, /Widespread outage affecting github\.com/);
  assert.match(action.props.tooltip, /Abrir detalhes do estado do GitHub/);
});

test("selects exactly one legacy Button on a host without Action or plugin translations", async () => {
  const harness = createPluginHarness({ state: "critical", action: false });
  harness.host.i18n = undefined;
  const chip = findRegistration(harness.registrations, "app-status-bar-right");
  const main = findRegistration(harness.registrations, "main-top-bar");
  const chipTree = await renderWithStatus(harness, chip, {
    slotProps: { presentation: "mobile-drawer" },
  });
  const chipButtons = walk(chipTree, (node) => node.type === "button");
  const mainTree = await renderWithStatus(harness, main);
  const mainButtons = walk(mainTree, (node) => node.type === "button");

  assert.equal(chipButtons.length, 1);
  assert.equal(mainButtons.length, 1);
  assert.equal(chipButtons[0].props.className, "ghs-chip ghs-crit");
  assert.equal(chipButtons[0].props.style.minHeight, "2.75rem");
  assert.equal(mainButtons[0].props.className, "ghs-banner ghs-crit");
  assert.equal(walk(chipTree, (node) => node.type === harness.Action).length, 0);
  assert.equal(walk(mainTree, (node) => node.type === harness.Action).length, 0);

  chipButtons[0].props.onClick();
  assert.equal(harness.modalCalls.length, 1);
});
