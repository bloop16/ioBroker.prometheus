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
var import_alertmanager_summary = require("./alertmanager-summary");
const ALERTMANAGER_CHANNEL = "alertmanager";
const SEVERITY_FOLDER = `${ALERTMANAGER_CHANNEL}.alerts.countBySeverity`;
const CONTAINERS = [
  { id: ALERTMANAGER_CHANNEL, type: "channel", name: "Alertmanager" },
  { id: `${ALERTMANAGER_CHANNEL}.alerts`, type: "channel", name: "Active alerts" },
  { id: SEVERITY_FOLDER, type: "folder", name: "Active alerts by severity" },
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
   */
  constructor(host, source, config, onHealth) {
    this.host = host;
    this.source = source;
    this.config = config;
    this.onHealth = onHealth;
  }
  interval;
  running = Promise.resolve();
  inFlight = false;
  stopped = false;
  /** Severities with a state, so they can be reset once their alerts resolve */
  knownSeverities = /* @__PURE__ */ new Set();
  /** Creates the objects, polls once and starts the timer */
  async start() {
    var _a;
    await this.ensureObjects();
    this.knownSeverities = await this.loadSeverities();
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
      const [alerts, silences] = await this.fetch();
      if (this.stopped) {
        return;
      }
      await this.report(true, "");
      await this.writeSummary(alerts, silences);
      await this.write("lastUpdate", Date.now());
    } catch (error) {
      await this.fail(error);
    }
  }
  async fetch() {
    try {
      return await Promise.all([this.source.activeAlerts(this.config.matchers), this.source.activeSilences()]);
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
  async writeSummary(alerts, silences) {
    const alertSummary = (0, import_alertmanager_summary.summarizeAlerts)(alerts);
    const silenceSummary = (0, import_alertmanager_summary.summarizeSilences)(silences);
    await this.writeSeverities(alertSummary.bySeverity);
    await this.write("alerts.count", alertSummary.count);
    await this.write("alerts.json", JSON.stringify(alertSummary.entries));
    await this.write("silences.count", silenceSummary.count);
    await this.write("silences.json", JSON.stringify(silenceSummary.entries));
  }
  async writeSeverities(bySeverity) {
    var _a;
    for (const severity of Object.keys(bySeverity)) {
      if (!this.knownSeverities.has(severity)) {
        await this.ensureState(`${SEVERITY_FOLDER}.${severity}`, {
          name: `Active alerts with severity ${severity}`,
          type: "number",
          role: "value"
        });
        this.knownSeverities = /* @__PURE__ */ new Set([...this.knownSeverities, severity]);
      }
    }
    for (const severity of this.knownSeverities) {
      await this.host.setStateChangedAsync(`${SEVERITY_FOLDER}.${severity}`, (_a = bySeverity[severity]) != null ? _a : 0, true);
    }
  }
  async write(state, value) {
    await this.host.setStateChangedAsync(`${ALERTMANAGER_CHANNEL}.${state}`, value, true);
  }
  async ensureObjects() {
    for (const { id, type, name } of CONTAINERS) {
      await this.host.setObjectNotExistsAsync(id, { type, common: { name }, native: {} });
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
  async loadSeverities() {
    const prefix = `${this.host.namespace}.${SEVERITY_FOLDER}.`;
    const objects = await this.host.getForeignObjectsAsync(`${prefix}*`, "state");
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
  const poller = new AlertmanagerPoller(host, client, config, onHealth);
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
