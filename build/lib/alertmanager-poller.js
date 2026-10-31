"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var alertmanager_poller_exports = {};
__export(alertmanager_poller_exports, {
  ALERTMANAGER_CHANNEL: () => ALERTMANAGER_CHANNEL,
  AlertmanagerPoller: () => AlertmanagerPoller,
  startAlertmanagerPoller: () => startAlertmanagerPoller
});
module.exports = __toCommonJS(alertmanager_poller_exports);
var import_alertmanager_client = require("./alertmanager-client");
var import_alertmanager_config = require("./alertmanager-config");
var import_alertmanager_groups = require("./alertmanager-groups");
var import_alertmanager_summary = require("./alertmanager-summary");
var import_prometheus_client = require("./prometheus-client");
var import_source_config = require("./source-config");
const ALERTMANAGER_CHANNEL = "alertmanager";
const ALERT_FOLDER = `${ALERTMANAGER_CHANNEL}.alerts`;
const LEGACY_OBJECTS = [`${ALERTMANAGER_CHANNEL}.info`, `${ALERT_FOLDER}.byName`, `${ALERT_FOLDER}.countBySeverity`];
const CONTAINERS = [
  { id: ALERTMANAGER_CHANNEL, type: "channel", name: "Alertmanager" },
  { id: ALERT_FOLDER, type: "folder", name: "Alerts" },
  { id: `${ALERTMANAGER_CHANNEL}.silences`, type: "channel", name: "Active silences" }
];
const STATES = {
  error: { name: "Last error (empty if ok)", type: "string", role: "text" },
  lastUpdate: { name: "Last successful update", type: "number", role: "date" },
  "alerts.count": { name: "Active alerts (not silenced)", type: "number", role: "value" },
  "alerts.json": { name: "Active alerts as JSON", type: "string", role: "json" },
  "silences.count": { name: "Active silences", type: "number", role: "value" },
  "silences.json": { name: "Active silences as JSON", type: "string", role: "json" }
};
const ALERT_STATES = {
  active: { name: "Alert is firing", type: "boolean", role: "indicator.alarm" },
  silenced: { name: "Alert is firing but silenced or inhibited", type: "boolean", role: "indicator" },
  count: { name: "Firing instances", type: "number", role: "value" },
  severity: { name: "Severity", type: "string", role: "text" },
  summary: { name: "Summary of the newest instance", type: "string", role: "text" },
  startsAt: { name: "Start of the newest instance", type: "number", role: "date" },
  json: { name: "Firing instances as JSON", type: "string", role: "json" }
};
class RequestError extends Error {
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
class AlertmanagerPoller {
  /**
   * @param host - The adapter instance
   * @param source - Data source, usually an AlertmanagerClient
   * @param config - The validated settings
   * @param onHealth - Called with the reachability after each poll
   * @param rules - Optional source of the alert rules
   */
  constructor(host, source, config, onHealth, rules) {
    this.host = host;
    this.source = source;
    this.config = config;
    this.onHealth = onHealth;
    this.rules = rules;
  }
  interval;
  running = Promise.resolve();
  inFlight = false;
  stopped = false;
  /** Alerts with a folder, so they can be reset once they resolve */
  knownAlerts = /* @__PURE__ */ new Set();
  /** Creates the objects, polls once and starts the timer */
  async start() {
    var _a;
    await this.removeLegacyObjects();
    await this.ensureObjects();
    this.knownAlerts = await this.loadAlertKeys();
    for (const key of this.knownAlerts) {
      await this.ensureAlertFolder(key, key);
    }
    this.interval = (_a = this.host.setInterval(() => this.trigger(), this.config.pollIntervalMs)) != null ? _a : void 0;
    this.trigger();
  }
  /** Stops polling; a poll already running finishes without further effect */
  stop() {
    this.stopped = true;
    if (this.interval) {
      this.host.clearInterval(this.interval);
      this.interval = void 0;
    }
  }
  /** Resolves once the current poll has finished */
  idle() {
    return this.running;
  }
  trigger() {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.running = this.poll().finally(() => {
      this.inFlight = false;
    });
  }
  /** Runs one poll cycle; never rejects */
  async poll() {
    try {
      const { alerts, suppressed, silences } = await this.fetch();
      if (this.stopped) {
        return;
      }
      await this.report(true, "");
      await this.writeSummary(alerts, suppressed, silences);
      await this.write("lastUpdate", Date.now());
    } catch (error) {
      await this.fail(error);
    }
  }
  async fetch() {
    try {
      const [alerts, suppressed, silences] = await Promise.all([
        this.source.activeAlerts(this.config.matchers),
        this.source.suppressedAlerts(this.config.matchers),
        this.source.activeSilences()
      ]);
      return { alerts, suppressed, silences };
    } catch (error) {
      throw new RequestError(errorText(error));
    }
  }
  async fail(error) {
    const message = errorText(error);
    this.host.log.warn(`Polling Alertmanager failed: ${message}`);
    try {
      await this.report(!(error instanceof RequestError), message);
    } catch (reportError) {
      this.host.log.warn(`Cannot write Alertmanager status: ${errorText(reportError)}`);
    }
  }
  async report(healthy, error) {
    if (this.stopped) {
      return;
    }
    this.onHealth(healthy);
    await this.write("error", error);
  }
  async writeSummary(alerts, suppressed, silences) {
    const alertSummary = (0, import_alertmanager_summary.summarizeAlerts)(alerts);
    const silenceSummary = (0, import_alertmanager_summary.summarizeSilences)(silences);
    await this.write("alerts.count", alertSummary.count);
    await this.write("alerts.json", JSON.stringify(alertSummary.entries));
    await this.write("silences.count", silenceSummary.count);
    await this.write("silences.json", JSON.stringify(silenceSummary.entries));
    await this.writeGroups((0, import_alertmanager_groups.groupAlerts)(alerts, await this.fetchRules(), suppressed));
  }
  /** Rules only add folders, so a failure must not affect the alerts */
  async fetchRules() {
    var _a, _b;
    try {
      return (_b = await ((_a = this.rules) == null ? void 0 : _a.alertRules())) != null ? _b : [];
    } catch (error) {
      this.host.log.debug(`Cannot read the alert rules: ${errorText(error)}`);
      return [];
    }
  }
  async writeGroups(groups) {
    for (const group of groups) {
      if (!this.knownAlerts.has(group.key)) {
        await this.ensureAlertFolder(group.key, group.name);
        this.knownAlerts = /* @__PURE__ */ new Set([...this.knownAlerts, group.key]);
      }
      await this.writeAlert(group.key, {
        active: group.active,
        silenced: group.silenced,
        count: group.count,
        severity: group.severity,
        summary: group.summary,
        startsAt: group.startsAt,
        json: JSON.stringify(group.entries)
      });
    }
    const current = new Set(groups.map((group) => group.key));
    for (const key of [...this.knownAlerts].filter((known) => !current.has(known))) {
      await this.writeAlert(key, {
        active: false,
        silenced: false,
        count: 0,
        summary: "",
        startsAt: null,
        json: "[]"
      });
    }
  }
  async writeAlert(key, values) {
    for (const [state, value] of Object.entries(values)) {
      await this.host.setStateChangedAsync(`${ALERT_FOLDER}.${key}.${state}`, value, true);
    }
  }
  async ensureAlertFolder(key, name) {
    const id = `${ALERT_FOLDER}.${key}`;
    await this.host.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
    for (const [state, spec] of Object.entries(ALERT_STATES)) {
      await this.ensureState(`${id}.${state}`, spec);
    }
  }
  async write(state, value) {
    await this.host.setStateChangedAsync(`${ALERTMANAGER_CHANNEL}.${state}`, value, true);
  }
  async ensureObjects() {
    for (const { id, type, name } of CONTAINERS) {
      await this.host.extendObjectAsync(id, { type, common: { name }, native: {} });
    }
    for (const [state, spec] of Object.entries(STATES)) {
      await this.ensureState(`${ALERTMANAGER_CHANNEL}.${state}`, spec);
    }
  }
  async ensureState(id, spec) {
    await this.host.setObjectNotExistsAsync(id, {
      type: "state",
      common: { ...spec, read: true, write: false },
      native: {}
    });
  }
  async removeLegacyObjects() {
    for (const id of LEGACY_OBJECTS) {
      if (await this.host.getObjectAsync(id)) {
        await this.host.delObjectAsync(id, { recursive: true });
      }
    }
  }
  async loadAlertKeys() {
    const prefix = `${this.host.namespace}.${ALERT_FOLDER}.`;
    const objects = await this.host.getForeignObjectsAsync(`${prefix}*`, "channel");
    return new Set(Object.keys(objects).map((id) => id.slice(prefix.length)));
  }
}
async function startAlertmanagerPoller(host, settings, timeoutMs, onHealth) {
  const { config, errors } = (0, import_alertmanager_config.normalizeAlertmanagerConfig)({
    url: settings.alertmanagerUrl,
    pollInterval: settings.alertmanagerPollInterval,
    filters: settings.alertmanagerFilters
  });
  for (const error of errors) {
    host.log.warn(`Alertmanager: ${error}`);
  }
  if (!config) {
    return void 0;
  }
  const client = new import_alertmanager_client.AlertmanagerClient({
    baseUrl: config.url,
    timeoutMs,
    username: settings.alertmanagerUsername || void 0,
    password: settings.alertmanagerPassword || void 0
  });
  const prometheusUrl = (0, import_source_config.validateUrl)(settings.url);
  const rules = prometheusUrl && config.matchers.length === 0 ? new import_prometheus_client.PrometheusClient({
    baseUrl: prometheusUrl,
    timeoutMs,
    username: settings.username || void 0,
    password: settings.password || void 0
  }) : void 0;
  const poller = new AlertmanagerPoller(host, client, config, onHealth, rules);
  await poller.start();
  host.log.info(`Polling Alertmanager every ${config.pollIntervalMs / 1e3}s: ${new URL(config.url).origin}`);
  return poller;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ALERTMANAGER_CHANNEL,
  AlertmanagerPoller,
  startAlertmanagerPoller
});
//# sourceMappingURL=alertmanager-poller.js.map
