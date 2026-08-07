// kandev-plugin-github-status UI bundle (no-build ES module).
//
// Quiet when healthy, loud when not:
//   • app-status-bar-right — always. A recessed dot + "GitHub" while all is
//     well; a colored pill the moment a component kandev depends on degrades.
//   • main-top-bar        — only during a degradation, so Home/Kanban/Tasks
//     carry an unmissable banner.
//   • click either        — a modal with the six components that matter, the
//     unresolved incident, and upcoming maintenance.
//   • toast               — only on a transition, acknowledged by id so a
//     page reload never replays it.
//   • plugin-settings     — the notification toggle.
//
// Data flow: everything reads one module-level store, which polls
//   host.api.fetch("webhooks/status")
//   (= GET /api/plugins/kandev-plugin-github-status/webhooks/status)
// -> kandev relays over gRPC HandleWebhook -> the plugin backend answers from
// its own 60s poller's cache. One request per interval for the whole SPA, not
// one per mounted surface. Colors live in /ui/plugin.css and are all derived
// from host theme tokens.

(function () {
  const PLUGIN_ID = "kandev-plugin-github-status";
  // Matches the backend's own poll cadence — polling the relay faster than
  // the poller refills its cache would just re-read the same bytes.
  const POLL_MS = 60000;
  const TOAST_MS = 15000;

  // ── vocabulary ───────────────────────────────────────────────────────────
  // Keys are the severity names the backend marshals (server/statuspage.go).
  const SEVERITY = {
    operational: { cls: "ghs-ok", label: "Operational", headline: "All systems operational" },
    maintenance: { cls: "ghs-mnt", label: "Maintenance", headline: "Maintenance in progress" },
    minor: { cls: "ghs-min", label: "Degraded", headline: "Degraded performance" },
    major: { cls: "ghs-maj", label: "Partial outage", headline: "Partial outage" },
    critical: { cls: "ghs-crit", label: "Major outage", headline: "Major outage" },
  };
  const sev = (name) => SEVERITY[name] || SEVERITY.operational;

  // Raw Statuspage component statuses -> the same visual vocabulary.
  const COMPONENT_LABEL = {
    operational: "Operational",
    degraded_performance: "Degraded",
    partial_outage: "Partial outage",
    major_outage: "Major outage",
    under_maintenance: "Maintenance",
  };
  const componentLabel = (status) => COMPONENT_LABEL[status] || "Unknown";

  const INCIDENT_STATUS_LABEL = {
    investigating: "Investigating",
    identified: "Identified",
    monitoring: "Monitoring",
    resolved: "Resolved",
    scheduled: "Scheduled",
    in_progress: "In progress",
    verifying: "Verifying",
    completed: "Completed",
  };
  const incidentStatusLabel = (status) =>
    INCIDENT_STATUS_LABEL[status] || (status ? status.replace(/_/g, " ") : "");

  function relTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const secs = Math.round((Date.now() - t) / 1000);
    if (secs < 0) return "just now";
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  // Absolute local time for a maintenance window, where "in 2 days" is less
  // useful than the actual clock time the user has to plan around.
  function windowLabel(from, until) {
    const start = from ? new Date(from) : null;
    const end = until ? new Date(until) : null;
    if (!start || Number.isNaN(start.getTime())) return "";
    const opts = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
    const startText = start.toLocaleString(undefined, opts);
    if (!end || Number.isNaN(end.getTime())) return startText;
    const sameDay = start.toDateString() === end.toDateString();
    const endText = end.toLocaleString(
      undefined,
      sameDay ? { hour: "2-digit", minute: "2-digit" } : opts,
    );
    return `${startText} – ${endText}`;
  }

  // ── store ────────────────────────────────────────────────────────────────
  // One poll for the whole SPA. Every surface subscribes to this.
  function createStore(host) {
    let state = { loading: true, error: null, payload: null };
    const listeners = new Set();
    let timer = null;
    let inFlight = null;
    // The demo fixture to render instead of live data, driven by the
    // ?ghsDemo= URL parameter. See README "Seeing the degraded states".
    let demo = "";

    function readDemoParam() {
      try {
        return new URLSearchParams(window.location.search).get("ghsDemo") || "";
      } catch (_) {
        return "";
      }
    }

    function emit() {
      listeners.forEach((fn) => {
        try {
          fn(state);
        } catch (err) {
          console.error(`[${PLUGIN_ID}] listener failed`, err);
        }
      });
    }

    function set(next) {
      state = { ...state, ...next };
      emit();
    }

    function load() {
      if (inFlight) return inFlight;
      const nextDemo = readDemoParam();
      if (nextDemo !== demo) demo = nextDemo;
      const path = demo ? `webhooks/status?demo=${encodeURIComponent(demo)}` : "webhooks/status";
      inFlight = host.api
        .fetch(path)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          set({ loading: false, error: null, payload: body });
        })
        .catch((err) => {
          // Keep the last good payload on screen. A single failed relay call
          // must not flap the chip to "unknown" — the same rule the backend
          // applies to githubstatus.com itself.
          set({ loading: false, error: String((err && err.message) || err) });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }

    function start() {
      if (timer) return;
      load();
      timer = setInterval(load, POLL_MS);
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    // acknowledge tells the backend a toast was shown, so it is not delivered
    // again after a reload.
    function acknowledge(sourceId, transitionId) {
      return host.api
        .fetch("webhooks/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId, transitionId }),
        })
        .catch((err) => console.error(`[${PLUGIN_ID}] ack failed`, err));
    }

    function saveSettings(patch) {
      return host.api
        .fetch("webhooks/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        })
        .then((res) => res.json())
        .then((settings) => {
          if (state.payload) set({ payload: { ...state.payload, settings } });
          return settings;
        });
    }

    return {
      getState: () => state,
      subscribe(fn) {
        listeners.add(fn);
        start();
        return () => {
          listeners.delete(fn);
          if (listeners.size === 0) stop();
        };
      },
      refresh: load,
      acknowledge,
      saveSettings,
      stop,
    };
  }

  // ── shared building blocks ───────────────────────────────────────────────
  function makeUI(host, store) {
    const { React, jsx: h } = host;

    // useStatus subscribes a component to the shared store.
    function useStatus() {
      const [snapshot, setSnapshot] = React.useState(store.getState);
      React.useEffect(() => store.subscribe(setSnapshot), []);
      return snapshot;
    }

    // Pill is the shared status token: a dot plus a label, tinted by severity.
    function Pill({ severity, label, size }) {
      const meta = sev(severity);
      return h(
        "span",
        { className: `ghs-pill ${meta.cls}${size === "sm" ? " ghs-pill-sm" : ""}` },
        h("span", { className: "ghs-dot" }),
        label || meta.label,
      );
    }

    function ComponentRow({ component }) {
      const severity = component.severity;
      return h(
        "div",
        { className: `ghs-comp ${sev(severity).cls}` },
        h(
          "div",
          { className: "ghs-comp-main" },
          h("span", { className: "ghs-comp-name" }, component.name),
          component.description
            ? h("span", { className: "ghs-comp-desc" }, component.description)
            : null,
        ),
        h(Pill, { severity, label: componentLabel(component.status), size: "sm" }),
      );
    }

    function IncidentCard({ incident, kind }) {
      const isMaintenance = kind === "maintenance";
      const severity = isMaintenance ? "maintenance" : incident.severity;
      const when = isMaintenance
        ? windowLabel(incident.scheduledFor, incident.scheduledUntil)
        : relTime(incident.latestUpdateAt || incident.startedAt);
      return h(
        "div",
        { className: `ghs-inc ${sev(severity).cls}` },
        h(
          "div",
          { className: "ghs-inc-head" },
          h(Pill, {
            severity,
            label: incidentStatusLabel(incident.status),
            size: "sm",
          }),
          incident.url
            ? h(
                "a",
                {
                  className: "ghs-inc-title",
                  href: incident.url,
                  target: "_blank",
                  rel: "noreferrer",
                },
                incident.name,
              )
            : h("span", { className: "ghs-inc-title" }, incident.name),
          h("span", { className: "ghs-spacer" }),
          when ? h("span", { className: "ghs-inc-when" }, when) : null,
        ),
        incident.latestUpdate
          ? h("p", { className: "ghs-inc-body" }, incident.latestUpdate)
          : null,
        incident.components && incident.components.length
          ? h(
              "div",
              { className: "ghs-inc-comps" },
              incident.components.map((name) =>
                h("span", { key: name, className: "ghs-tag" }, name),
              ),
            )
          : null,
      );
    }

    // ── modal panel ────────────────────────────────────────────────────────
    // Note: host.ui has no TooltipProvider inside modal content, so nothing
    // here relies on a tooltip — every label is rendered inline instead.
    function StatusPanel() {
      const { loading, error, payload } = useStatus();

      if (loading && !payload) {
        return h("div", { className: "ghs-root ghs-empty" }, "Checking githubstatus.com…");
      }
      if (!payload) {
        return h(
          "div",
          { className: "ghs-root ghs-error" },
          error || "GitHub status is unavailable.",
        );
      }

      const snap = payload.snapshot;
      const meta = sev(payload.overall);
      const incidents = (snap && snap.incidents) || [];
      const maintenances = (snap && snap.maintenances) || [];
      const upcoming = maintenances.filter((m) => m.status !== "completed");
      const others = (snap && snap.otherComponents) || [];
      const degradedOthers = others.filter((c) => c.severity !== "operational");

      const header = h(
        "div",
        { className: `ghs-hero ${meta.cls}` },
        h("span", { className: "ghs-hero-dot" }),
        h(
          "div",
          { className: "ghs-hero-text" },
          h("div", { className: "ghs-hero-title" }, meta.headline),
          h(
            "div",
            { className: "ghs-hero-sub" },
            snap && snap.indicatorDescription
              ? `${payload.displayName} reports “${snap.indicatorDescription}”`
              : payload.displayName,
          ),
        ),
        h("span", { className: "ghs-spacer" }),
        h(
          "div",
          { className: "ghs-hero-meta" },
          payload.stale
            ? h("span", { className: "ghs-stale" }, "Stale")
            : h("span", null, payload.fetchedAt ? `Checked ${relTime(payload.fetchedAt)}` : ""),
          h(
            "button",
            {
              type: "button",
              className: "ghs-refresh",
              onClick: () => store.refresh(),
              "aria-label": "Refresh GitHub status",
            },
            "⟳",
          ),
        ),
      );

      const problem = payload.error
        ? h(
            "div",
            { className: "ghs-notice" },
            payload.stale
              ? `Showing the last known status — githubstatus.com has been unreachable for ${payload.consecutiveFailures} attempt${payload.consecutiveFailures === 1 ? "" : "s"}.`
              : `Last refresh failed: ${payload.error}`,
          )
        : null;

      return h(
        "div",
        { className: "ghs-root" },
        header,
        problem,
        h(
          "section",
          { className: "ghs-section" },
          h("h3", { className: "ghs-h3" }, "What kandev depends on"),
          h(
            "div",
            { className: "ghs-comps" },
            ((snap && snap.keyComponents) || []).map((c) =>
              h(ComponentRow, { key: c.name, component: c }),
            ),
          ),
        ),
        incidents.length
          ? h(
              "section",
              { className: "ghs-section" },
              h(
                "h3",
                { className: "ghs-h3" },
                incidents.length === 1 ? "Active incident" : `Active incidents (${incidents.length})`,
              ),
              h(
                "div",
                { className: "ghs-incs" },
                incidents.map((inc) => h(IncidentCard, { key: inc.id, incident: inc })),
              ),
            )
          : null,
        upcoming.length
          ? h(
              "section",
              { className: "ghs-section" },
              h("h3", { className: "ghs-h3" }, "Scheduled maintenance"),
              h(
                "div",
                { className: "ghs-incs" },
                upcoming.map((m) =>
                  h(IncidentCard, { key: m.id, incident: m, kind: "maintenance" }),
                ),
              ),
            )
          : null,
        h(
          "footer",
          { className: "ghs-foot" },
          h(
            "span",
            { className: "ghs-foot-others" },
            others.length
              ? degradedOthers.length
                ? h(
                    React.Fragment,
                    null,
                    "Also affected: ",
                    degradedOthers
                      .map((c) => `${c.name} (${componentLabel(c.status).toLowerCase()})`)
                      .join(", "),
                  )
                : `${others.length} other component${others.length === 1 ? "" : "s"} operational`
              : null,
          ),
          h("span", { className: "ghs-spacer" }),
          h(
            "a",
            {
              className: "ghs-foot-link",
              href: payload.pageUrl,
              target: "_blank",
              rel: "noreferrer",
            },
            "githubstatus.com ↗",
          ),
        ),
      );
    }

    function openStatusModal() {
      if (typeof host.openModal === "function") {
        return host.openModal({ title: "GitHub Status", content: StatusPanel, size: "lg" });
      }
      // No host modal on this build: fall back to the source of truth rather
      // than silently doing nothing.
      const state = store.getState();
      const url = (state.payload && state.payload.pageUrl) || "https://www.githubstatus.com";
      window.open(url, "_blank", "noopener");
      return null;
    }

    // ── toast stack ────────────────────────────────────────────────────────
    // Rendered by the status-bar chip so there is no extra mount point, and
    // the toasts follow the app rather than a route. Only ONE chip instance
    // owns it (desktop bar and mobile drawer can both be mounted).
    let toastOwner = null;

    function useToasts(instanceId) {
      const { payload } = useStatus();
      const [toasts, setToasts] = React.useState([]);
      const seen = React.useRef(new Set());

      const owns = toastOwner === instanceId;
      React.useEffect(() => {
        if (toastOwner === null) toastOwner = instanceId;
        return () => {
          if (toastOwner === instanceId) toastOwner = null;
        };
      }, [instanceId]);

      const transition = payload && payload.transition;
      React.useEffect(() => {
        if (!owns || !transition || seen.current.has(transition.id)) return undefined;
        seen.current.add(transition.id);
        setToasts((prev) => [...prev, transition]);
        // Acknowledge immediately: the backend's job is "deliver once", the
        // dismiss timer below is purely cosmetic.
        store.acknowledge(transition.sourceId, transition.id);
        const timer = setTimeout(
          () => setToasts((prev) => prev.filter((t) => t.id !== transition.id)),
          TOAST_MS,
        );
        return () => clearTimeout(timer);
      }, [owns, transition && transition.id]);

      const dismiss = React.useCallback(
        (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
        [],
      );
      return { toasts: owns ? toasts : [], dismiss };
    }

    function ToastStack({ toasts, dismiss }) {
      if (!toasts.length) return null;
      return h(
        "div",
        { className: "ghs-toasts" },
        toasts.map((t) =>
          h(
            "div",
            { key: t.id, className: `ghs-toast ${sev(t.to).cls}`, role: "status" },
            h("span", { className: "ghs-dot" }),
            h(
              "div",
              { className: "ghs-toast-text" },
              h("div", { className: "ghs-toast-title" }, t.title),
              t.detail ? h("div", { className: "ghs-toast-detail" }, t.detail) : null,
            ),
            h(
              "button",
              {
                type: "button",
                className: "ghs-toast-open",
                onClick: () => {
                  dismiss(t.id);
                  openStatusModal();
                },
              },
              "Details",
            ),
            h(
              "button",
              {
                type: "button",
                className: "ghs-toast-x",
                onClick: () => dismiss(t.id),
                "aria-label": "Dismiss",
              },
              "×",
            ),
          ),
        ),
      );
    }

    // ── status-bar chip ────────────────────────────────────────────────────
    let nextInstanceId = 0;

    function StatusChip({ slotProps }) {
      const instanceId = React.useRef(++nextInstanceId).current;
      const { payload, loading } = useStatus();
      const { toasts, dismiss } = useToasts(instanceId);
      const mobile = slotProps && slotProps.presentation === "mobile-drawer";

      const severity = (payload && payload.overall) || "operational";
      const loud = Boolean(payload && payload.loud);
      const meta = sev(severity);
      const stale = Boolean(payload && payload.stale);

      const label = loud ? `GitHub · ${meta.label}` : "GitHub";
      const title = loading && !payload ? "Checking GitHub status…" : `${meta.headline} — click for details`;

      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            type: "button",
            className: `ghs-chip ${meta.cls}`,
            "data-loud": String(loud),
            "data-stale": String(stale),
            style: mobile
              ? {
                  minHeight: "2.75rem",
                  width: "100%",
                  justifyContent: "flex-start",
                  padding: "0 0.75rem",
                  fontSize: "0.85rem",
                }
              : null,
            onClick: () => openStatusModal(),
            "aria-label": `GitHub status: ${meta.headline}`,
            title,
          },
          h("span", { className: "ghs-dot" }),
          h("span", { className: "ghs-chip-label" }, label),
          stale ? h("span", { className: "ghs-chip-stale" }, "stale") : null,
        ),
        h(ToastStack, { toasts, dismiss }),
      );
    }

    // ── main top bar banner ────────────────────────────────────────────────
    // Renders nothing at all while GitHub is healthy. That silence is the
    // feature: this slot is only worth its pixels during an incident.
    function StatusBanner() {
      const { payload } = useStatus();
      if (!payload || !payload.loud) return null;

      const meta = sev(payload.overall);
      const snap = payload.snapshot;
      const incident = ((snap && snap.incidents) || [])[0];
      const affected = ((snap && snap.keyComponents) || [])
        .filter((c) => c.severity !== "operational")
        .map((c) => c.name);
      const detail = incident ? incident.name : affected.join(", ");

      return h(
        "button",
        {
          type: "button",
          className: `ghs-banner ${meta.cls}`,
          onClick: () => openStatusModal(),
          "aria-label": `GitHub status: ${meta.headline}. Open details.`,
        },
        h("span", { className: "ghs-dot" }),
        h("span", { className: "ghs-banner-title" }, `GitHub — ${meta.headline}`),
        detail ? h("span", { className: "ghs-banner-detail" }, detail) : null,
        payload.stale ? h("span", { className: "ghs-chip-stale" }, "stale") : null,
      );
    }

    // ── plugin settings ────────────────────────────────────────────────────
    function SettingsPanel() {
      const { payload } = useStatus();
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);
      const enabled = payload && payload.settings ? payload.settings.notifyOnTransition : true;

      const Switch = host.ui && host.ui.Switch;
      const Label = host.ui && host.ui.Label;

      const toggle = (next) => {
        setSaving(true);
        setError(null);
        store
          .saveSettings({ notifyOnTransition: next })
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setSaving(false));
      };

      const control = Switch
        ? h(Switch, {
            id: "ghs-notify",
            checked: enabled,
            disabled: saving,
            onCheckedChange: toggle,
          })
        : h("input", {
            id: "ghs-notify",
            type: "checkbox",
            checked: enabled,
            disabled: saving,
            onChange: (e) => toggle(e.target.checked),
          });

      const text = h(
        "div",
        { className: "ghs-set-text" },
        Label
          ? h(Label, { htmlFor: "ghs-notify", className: "ghs-set-title" }, "Notify on status changes")
          : h("span", { className: "ghs-set-title" }, "Notify on status changes"),
        h(
          "p",
          { className: "ghs-set-desc" },
          "Show a toast when GitHub degrades or recovers. Only on a change — a steady outage is announced once, not every minute. The status-bar chip and the top-bar banner are always live.",
        ),
      );

      return h(
        "div",
        { className: "ghs-settings" },
        h("div", { className: "ghs-set-row" }, text, h("span", { className: "ghs-spacer" }), control),
        error ? h("div", { className: "ghs-set-error" }, error) : null,
      );
    }

    return { StatusChip, StatusBanner, SettingsPanel, StatusPanel, openStatusModal };
  }

  // ── registration ─────────────────────────────────────────────────────────
  let activeStore = null;

  window.registerKandevPlugin(PLUGIN_ID, {
    initialize(registry, host) {
      // initialize can run again across disable/enable cycles in the same
      // tab; drop the previous store's interval before creating a new one.
      if (activeStore) activeStore.stop();
      activeStore = createStore(host);

      const ui = makeUI(host, activeStore);

      registry.registerComponent("app-status-bar-right", ui.StatusChip);
      registry.registerComponent("main-top-bar", ui.StatusBanner);
      registry.registerComponent("plugin-settings", ui.SettingsPanel);
    },
    destroy() {
      if (activeStore) activeStore.stop();
      activeStore = null;
    },
  });
})();
