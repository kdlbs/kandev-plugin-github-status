// Screenshot harness driver.
//
// Loads the real ui/bundle.js against a stub host SDK and the real backend
// payloads in demo.json (regenerate with
// `GHS_DUMP_DEMO=../docs/harness go test ./server/ -run TestDumpDemoJSON`),
// then mounts a minimal kandev app shell around the plugin's three slots.

(function () {
  const params = new URLSearchParams(window.location.search);
  const STATE = params.get("state") || "healthy";
  const THEME = params.get("theme") === "dark" ? "dark" : "light";
  const VIEW = params.get("view") || "app";
  const SHOW_TOAST = params.get("toast") === "1";

  document.documentElement.dataset.theme = THEME;

  const React = window.React;
  const ReactDOM = window.ReactDOM;
  const h = React.createElement;

  // ── stub host SDK ────────────────────────────────────────────────────────
  let payloads = {};
  let settings = { notifyOnTransition: true };
  let modalRequest = null;
  const slots = {};

  function jsonResponse(body, ok) {
    return Promise.resolve({
      ok: ok !== false,
      status: ok === false ? 500 : 200,
      json: () => Promise.resolve(body),
    });
  }

  const host = {
    pluginId: "kandev-plugin-github-status",
    React,
    jsx: React.createElement,
    theme: THEME,
    store: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
    api: {
      baseUrl: "",
      fetch(path, init) {
        const method = (init && init.method) || "GET";
        if (path.startsWith("webhooks/status")) {
          const payload = JSON.parse(JSON.stringify(payloads[STATE] || payloads.healthy));
          payload.settings = settings;
          // The toast is opt-in in the harness so the default screenshots
          // show the resting state.
          if (!SHOW_TOAST) delete payload.transition;
          return jsonResponse(payload);
        }
        if (path.startsWith("webhooks/ack")) return jsonResponse({ acknowledged: true });
        if (path.startsWith("webhooks/settings")) {
          if (method === "POST" && init && init.body) {
            settings = { ...settings, ...JSON.parse(init.body) };
          }
          return jsonResponse(settings);
        }
        return jsonResponse({ error: `unstubbed path ${path}` }, false);
      },
    },
    ui: {
      Switch: ({ id, checked, disabled, onCheckedChange }) =>
        h("button", {
          id,
          type: "button",
          className: "u-switch",
          "data-checked": String(Boolean(checked)),
          disabled,
          onClick: () => onCheckedChange && onCheckedChange(!checked),
          "aria-label": "Toggle",
        }),
      Label: ({ htmlFor, className, children }) =>
        h("label", { htmlFor, className: `u-label ${className || ""}` }, children),
    },
    navigate: (href) => console.log("navigate", href),
    openModal: (options) => {
      modalRequest = options;
      render();
      return { close: () => { modalRequest = null; render(); } };
    },
  };

  const registry = {
    registerComponent: (slot, Component) => {
      slots[slot] = Component;
    },
    registerRoute: () => {},
    registerNavItem: () => {},
    registerWsHandler: () => {},
    registerKeybinding: () => {},
    registerSettingsRoute: () => {},
  };

  window.registerKandevPlugin = function (id, plugin) {
    window.__ghsPlugin = { id, plugin };
  };

  // ── app shell ────────────────────────────────────────────────────────────
  function GhostBoard() {
    const cols = ["Backlog", "In progress", "In review", "Done"];
    return h(
      "div",
      { className: "canvas" },
      cols.map((name, i) =>
        h(
          "div",
          { className: "ghost-col", key: name },
          h("div", { className: "ghost-head" }),
          Array.from({ length: [3, 2, 2, 1][i] }, (_, j) =>
            h("div", { className: "ghost-card", key: j }),
          ),
        ),
      ),
    );
  }

  function Shell() {
    const Chip = slots["app-status-bar-right"];
    const Banner = slots["main-top-bar"];
    const SettingsPanel = slots["plugin-settings"];

    if (VIEW === "settings") {
      return h(
        "div",
        { className: "settings-page" },
        h("h1", { className: "settings-h1" }, "GitHub Status"),
        h(
          "p",
          { className: "settings-sub" },
          "Is it me or is it GitHub? A quiet status-bar chip that turns loud when Git Operations, Actions, or the API degrade.",
        ),
        SettingsPanel ? h(SettingsPanel, { slotProps: { pluginId: host.pluginId, status: "active" } }) : null,
      );
    }

    return h(
      "div",
      { className: "app" },
      h(
        "div",
        { className: "app-main" },
        h(
          "div",
          { className: "sidebar" },
          h("div", { className: "brand" }, "kandev"),
          ["Home", "Kanban", "Tasks", "Office", "Settings"].map((label, i) =>
            h("div", { className: `navitem${i === 1 ? " active" : ""}`, key: label }, label),
          ),
        ),
        h(
          "div",
          { className: "content" },
          h(
            "div",
            { className: "topbar" },
            h("span", { className: "topbar-title" }, "Kanban"),
            h("span", { className: "spacer" }),
            Banner
              ? h(Banner, {
                  slotProps: { workspaceId: "ws1", workspaceLabel: "kandev", currentPage: "kanban" },
                })
              : null,
          ),
          h(GhostBoard),
        ),
      ),
      h(
        "div",
        { className: "statusbar" },
        h("span", null, "main · 3 sessions"),
        h(
          "div",
          { className: "sb-right" },
          h("span", null, "CI ●●"),
          Chip
            ? h(Chip, {
                slotProps: { placement: "right", presentation: "desktop", density: "compact" },
              })
            : null,
        ),
      ),
      modalRequest ? h(Modal, { request: modalRequest }) : null,
    );
  }

  function Modal({ request }) {
    const Content = request.content;
    return h(
      "div",
      { className: "scrim" },
      h(
        "div",
        { className: "dialog" },
        h(
          "div",
          { className: "dialog-head" },
          h("span", { className: "dialog-title" }, request.title || ""),
          h("button", { className: "dialog-x", onClick: () => { modalRequest = null; render(); } }, "✕"),
        ),
        h("div", { className: "dialog-body" }, h(Content)),
      ),
    );
  }

  let root = null;
  function render() {
    if (!root) root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(h(Shell));
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function loadBundle() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "../../ui/bundle.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("failed to load ui/bundle.js"));
      document.body.appendChild(script);
    });
  }

  fetch("demo.json")
    .then((r) => r.json())
    .then((data) => {
      payloads = data;
      return loadBundle();
    })
    .then(() => {
      window.__ghsPlugin.plugin.initialize(registry, host);
      render();
      if (VIEW === "modal") {
        // Open it the way a user does — by clicking the chip — so the modal
        // screenshot exercises the real openModal path rather than a
        // harness-only shortcut. The timeout lets the store's first fetch
        // land so the panel opens with data instead of "Checking…".
        setTimeout(() => {
          const chip = document.querySelector(".ghs-chip");
          if (chip) chip.click();
        }, 120);
      }
    })
    .catch((err) => {
      document.getElementById("root").textContent = `harness failed: ${err}`;
      console.error(err);
    });
})();
