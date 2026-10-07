import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const bundle = readFileSync(
  new URL("../ui/bundle.js", import.meta.url),
  "utf8",
);
const fixtures = JSON.parse(
  readFileSync(new URL("../docs/harness/demo.json", import.meta.url), "utf8"),
);

function element(type, props, ...children) {
  return { type, props: props || {}, children };
}

function createReact() {
  let active = null;
  const componentRecords = new WeakMap();

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
        slot.value =
          typeof initialValue === "function" ? initialValue() : initialValue;
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
        dependencies.length !== slot.dependencies.length ||
        dependencies.some(
          (value, index) => !Object.is(value, slot.dependencies[index]),
        );
      if (changed) {
        const previousCleanup = slot.cleanup;
        slot.dependencies = dependencies;
        slot.initialized = true;
        active.pending.push(() => {
          if (typeof previousCleanup === "function") previousCleanup();
          slot.cleanup = effect();
        });
      }
    },
    useCallback(callback, dependencies) {
      const slot = hook("callback", callback);
      const changed =
        !slot.initialized ||
        dependencies === undefined ||
        dependencies.length !== slot.dependencies.length ||
        dependencies.some(
          (value, index) => !Object.is(value, slot.dependencies[index]),
        );
      if (changed) {
        slot.value = callback;
        slot.dependencies = dependencies;
        slot.initialized = true;
      }
      return slot.value;
    },
    render(component, props = {}) {
      const previous = active;
      let record = componentRecords.get(component);
      if (!record) {
        record = { hooks: [], cursor: 0, pending: [] };
        componentRecords.set(component, record);
      }
      record.cursor = 0;
      record.pending = [];
      active = record;
      let tree;
      try {
        tree = component(props);
      } finally {
        active = previous;
      }
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

function createPluginHarness({
  state,
  action = true,
  locale = "en",
  oldObjectHasOwn = false,
  payload,
  fetchStatus,
}) {
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

  const runtimeObject = oldObjectHasOwn
    ? new Proxy(Object, {
        get(target, property) {
          return property === "hasOwn"
            ? undefined
            : Reflect.get(target, property, target);
        },
      })
    : Object;
  runInNewContext(bundle, {
    Object: runtimeObject,
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
            const pluralKey =
              options.count === undefined
                ? key
                : `${key}_${options.count === 1 ? "one" : "other"}`;
            const message =
              (catalogs[locale] &&
                (catalogs[locale][pluralKey] || catalogs[locale][key])) ||
              options.defaultValue ||
              key;
            const values = { count: options.count, ...options.values };
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
          return Promise.resolve({
            json: async () => ({ acknowledged: true }),
          });
        }
        if (fetchStatus) return fetchStatus(path);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => payload || fixtures[state],
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
  assert.equal(action.props.text, undefined);
  assert.equal(action.props.badge, undefined);
  assert.ok(action.props.icon);
  assert.equal(action.props.tone, "neutral");
  assert.equal(
    action.props.tooltip,
    "All systems operational. Open GitHub status details.",
  );
  assert.equal(action.props.className, undefined);
  assert.equal(action.props.style, undefined);
  assert.equal(action.props.variant, undefined);
  assert.equal(walk(action, (node) => node.type === "button").length, 0);
  assert.equal(await renderWithStatus(harness, main), null);
  assert.equal(await renderWithStatus(harness, chat), null);
  assert.deepEqual(
    harness.catalogs.en.actionTooltip,
    "{{status}}{{details}}{{stale}}. Open GitHub status details.",
  );
});

test("keeps degraded, critical, and stale actions icon-only with tone, tooltip, and details", async (t) => {
  for (const fixture of [
    { state: "degraded", tone: "warning" },
    { state: "critical", tone: "danger" },
    { state: "stale", tone: "warning" },
  ]) {
    await t.test(fixture.state, async () => {
      const harness = createPluginHarness({ state: fixture.state });
      const chip = findRegistration(
        harness.registrations,
        "app-status-bar-right",
      );
      const main = findRegistration(harness.registrations, "main-top-bar");
      const chat = findRegistration(harness.registrations, "chat-top-bar");
      const chipTree = await renderWithStatus(harness, chip);
      const chipAction = walk(
        chipTree,
        (node) => node.type === harness.Action,
      )[0];
      const mainTree = await renderWithStatus(harness, main);
      const chatTree = await renderWithStatus(harness, chat);
      const mainAction = walk(
        mainTree,
        (node) => node.type === harness.Action,
      )[0];
      const chatAction = walk(
        chatTree,
        (node) => node.type === harness.Action,
      )[0];

      assert.ok(chipAction);
      assert.ok(mainAction);
      assert.ok(chatAction);
      for (const action of [chipAction, mainAction, chatAction]) {
        assert.equal(action.props.label, "GitHub status");
        assert.equal(action.props.tone, fixture.tone);
        assert.ok(action.props.icon);
        assert.equal(action.props.text, undefined);
        assert.equal(action.props.badge, undefined);
        assert.match(action.props.tooltip, /Open GitHub status details/);
        assert.equal(
          action.props.style,
          undefined,
          "the host owns responsive dimensions",
        );
        assert.equal(
          action.props.className,
          undefined,
          "the host owns the action shell",
        );
      }
      assert.match(
        chipAction.props.tooltip,
        new RegExp(fixtures[fixture.state].snapshot.incidents[0].name),
      );
      if (fixture.state === "stale") {
        for (const action of [chipAction, mainAction, chatAction]) {
          assert.match(action.props.tooltip, /stale data/);
        }
      }

      mainAction.props.onClick({ type: "keyboard-or-pointer-activation" });
      assert.equal(
        harness.modalCalls.length,
        1,
        "the action opens the existing details modal",
      );
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
  assert.equal(action.props.text, undefined);
  assert.match(action.props.tooltip, /^Interrupção grave/);
  assert.match(action.props.tooltip, /Widespread outage affecting github\.com/);
  assert.match(action.props.tooltip, /Abrir detalhes do estado do GitHub/);
});

test("interpolates the status tooltip without host translations or Object.hasOwn", async () => {
  const harness = createPluginHarness({
    state: "critical",
    oldObjectHasOwn: true,
  });
  harness.host.i18n = undefined;
  const chip = findRegistration(harness.registrations, "app-status-bar-right");
  const action = walk(
    await renderWithStatus(harness, chip),
    (node) => node.type === harness.Action,
  )[0];

  assert.equal(
    action.props.tooltip,
    "Major outage — Widespread outage affecting github.com. Open GitHub status details.",
  );
  assert.doesNotMatch(action.props.tooltip, /\{\{[^}]+\}\}/);
});

test("the UI hook harness preserves state, refs, and effect cleanup across rerenders", () => {
  const React = createReact();
  let initializations = 0;
  const effects = [];
  function Component({ dependency }) {
    const [value, setValue] = React.useState(() => ++initializations);
    const ref = React.useRef({ id: Symbol("stable") });
    React.useEffect(() => {
      effects.push(`effect:${dependency}`);
      return () => effects.push(`cleanup:${dependency}`);
    }, [dependency]);
    return { value, setValue, ref: ref.current };
  }

  const first = React.render(Component, { dependency: 1 });
  first.setValue((value) => value + 1);
  const second = React.render(Component, { dependency: 1 });
  assert.equal(initializations, 1);
  assert.equal(second.value, 2);
  assert.strictEqual(second.ref, first.ref);
  assert.deepEqual(effects, ["effect:1"]);

  React.render(Component, { dependency: 2 });
  assert.deepEqual(effects, ["effect:1", "cleanup:1", "effect:2"]);
});

test("selects exactly one legacy Button on a host without Action or plugin translations", async () => {
  const harness = createPluginHarness({ state: "stale", action: false });
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
  assert.equal(chipButtons[0].props.className, "ghs-chip ghs-min");
  assert.equal(chipButtons[0].props.style.minHeight, "2.75rem");
  assert.equal(mainButtons[0].props.className, "ghs-banner ghs-min");
  assert.equal(
    chipButtons[0].children.length,
    1,
    "the legacy chip shows only its icon",
  );
  assert.equal(typeof chipButtons[0].children[0].type, "function");
  const staleMark = harness.React.render(
    chipButtons[0].children[0].type,
    chipButtons[0].children[0].props,
  );
  assert.equal(staleMark.type, "svg");
  assert.equal(
    staleMark.children[1].props.className,
    "ghs-mark-stale-indicator",
  );
  assert.match(
    chipButtons[0].props.title,
    /Degraded performance.*stale data.*Open GitHub status details/,
  );
  assert.equal(
    chipButtons[0].props["aria-label"],
    "GitHub status: Degraded performance, stale data",
  );
  assert.equal(
    walk(chipTree, (node) => node.type === harness.Action).length,
    0,
  );
  assert.equal(
    walk(mainTree, (node) => node.type === harness.Action).length,
    0,
  );

  chipButtons[0].props.onClick();
  assert.equal(harness.modalCalls.length, 1);
});

function expandTree(harness, tree) {
  if (Array.isArray(tree)) return tree.map((node) => expandTree(harness, node));
  if (!tree || typeof tree !== "object") return tree;
  if (typeof tree.type === "function")
    return expandTree(harness, harness.React.render(tree.type, tree.props));
  return { ...tree, children: expandTree(harness, tree.children) };
}

function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  if (tree && typeof tree === "object") return textOf(tree.children);
  return typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : "";
}

async function openPanel(harness) {
  const chip = findRegistration(harness.registrations, "app-status-bar-right");
  const tree = await renderWithStatus(harness, chip);
  const action = walk(
    tree,
    (node) => node.type === harness.Action || node.type === "button",
  )[0];
  (action.props.onClick || action.props.onActivate)();
  const Panel = harness.modalCalls[0].content;
  await renderWithStatus(harness, Panel);
  return () => expandTree(harness, harness.React.render(Panel));
}

test("briefing partitions reported statuses without treating unknown status as healthy", async () => {
  const payload = structuredClone(fixtures.incident);
  payload.snapshot.keyComponents[2].status = "new_provider_status";
  const harness = createPluginHarness({ state: "incident", payload });
  const panel = await openPanel(harness);
  const tree = panel();
  const groups = walk(
    tree,
    (node) => node.type === "section" && node.props["data-service-group"],
  );
  assert.deepEqual(
    groups.map((g) => g.props["data-service-group"]),
    ["affected", "healthy"],
  );
  assert.match(
    textOf(groups[0]),
    /Git Operations.*API Requests.*Webhooks.*Unknown.*Actions.*Pull Requests/,
  );
  assert.doesNotMatch(textOf(groups[1]), /Webhooks/);
  assert.match(textOf(tree), /services affected/);
  assert.equal(payload.snapshot.keyComponents[0].name, "Git Operations");
});

test("briefing distinguishes active incident, maintenance, healthy, and missing service data", async (t) => {
  const cases = [
    ["healthy", null, /All monitored services operational/],
    ["maintenance", null, /maintenance/i],
    [
      "healthy",
      (p) => {
        p.overall = "major";
        p.snapshot.incidents = fixtures.incident.snapshot.incidents;
      },
      /Active GitHub incident/,
    ],
    [
      "healthy",
      (p) => {
        p.snapshot = null;
      },
      /Service status unavailable/,
    ],
  ];
  for (const [state, change, expected] of cases)
    await t.test(state + (change ? " override" : ""), async () => {
      const payload = structuredClone(fixtures[state]);
      change?.(payload);
      const panel = await openPanel(createPluginHarness({ state, payload }));
      assert.match(textOf(panel()), expected);
    });
});

test("refresh preserves snapshot age, exposes pending state, deduplicates and settles failure", async () => {
  let reject;
  let count = 0;
  const payload = structuredClone(fixtures.incident);
  payload.fetchedAt = new Date(Date.now() - 120000).toISOString();
  const harness = createPluginHarness({
    state: "incident",
    fetchStatus: () => {
      count++;
      if (count === 1)
        return Promise.resolve({
          ok: true,
          json: async () => payload,
        });
      return new Promise((_, fail) => {
        reject = fail;
      });
    },
  });
  const panel = await openPanel(harness);
  const refresh = () =>
    walk(panel(), (n) => n.props.className === "ghs-refresh")[0];
  const age = () =>
    textOf(walk(panel(), (n) => n.props.className === "ghs-checked")[0]);
  const before = age();
  assert.match(before, /Checked 2m ago/);
  refresh().props.onClick();
  refresh().props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 2);
  assert.equal(refresh().props.disabled, true);
  assert.match(textOf(refresh()), /Refreshing/);
  assert.equal(age(), before);
  reject(new Error("relay offline"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh().props.disabled, false);
  assert.match(textOf(panel()), /Could not recheck status/);
  assert.match(textOf(panel()), /Git Operations/);
  assert.equal(age(), before);
});

test("missing fetch time does not imply unavailable service status", async () => {
  const panel = await openPanel(createPluginHarness({ state: "healthy" }));
  assert.match(textOf(panel()), /Fetch time unavailable/);
  assert.match(textOf(panel()), /All monitored services operational/);
  assert.doesNotMatch(textOf(panel()), /Service status unavailable/);
});

test("briefing catalogs cover seven locales and interpolate service counts", async () => {
  const harness = createPluginHarness({ state: "incident", locale: "pt-pt" });
  const panel = await openPanel(harness);
  assert.match(textOf(panel()), /Atualizar/);
  for (const locale of ["en", "pt-pt", "zh-cn", "zh-hk", "zh-tw", "ja", "ko"]) {
    assert.ok(harness.catalogs[locale], locale);
    for (const key of Object.keys(harness.catalogs.en))
      assert.equal(
        typeof harness.catalogs[locale][key],
        "string",
        locale + ":" + key,
      );
  }
  assert.doesNotMatch(textOf(panel()), /\{\{/);
});
