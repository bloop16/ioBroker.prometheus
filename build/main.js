"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var http = __toESM(require("node:http"));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_query_builder = require("./lib/query-builder");
var import_exporter = require("./lib/exporter");
var import_prometheus_client = require("./lib/prometheus-client");
var import_source_config = require("./lib/source-config");
const DEFAULT_REQUEST_TIMEOUT_SEC = 10;
const MAX_DROPDOWN_ENTRIES = 2e3;
const MAX_STARTUP_JITTER_MS = 5e3;
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
class Prometheus extends utils.Adapter {
  pollIntervals = [];
  startupTimeouts = [];
  isShuttingDown = false;
  /** Health of each source (by target path), used for info.connection */
  sourceHealth = /* @__PURE__ */ new Map();
  /** Current values of all states exported via the /metrics endpoint */
  registry = new import_exporter.MetricsRegistry();
  exporterServer;
  /** Ids of the states currently exported */
  exportedIds = /* @__PURE__ */ new Set();
  systemLanguage = "en";
  constructor(options = {}) {
    super({
      ...options,
      name: "prometheus"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    if (this.config.exporterEnabled) {
      try {
        await this.startExporter();
      } catch (error) {
        this.log.error(`Failed to start the /metrics exporter: ${this.errorText(error)}`);
      }
    }
    const { sources, errors } = (0, import_source_config.normalizeSources)(this.config.sources, this.config.url);
    for (const error of errors) {
      this.log.warn(`Ignoring misconfigured source - ${error}`);
    }
    if (sources.length === 0) {
      this.log.info("No (valid) Prometheus sources configured. Please configure sources in the Admin UI.");
      return;
    }
    for (const source of sources) {
      try {
        await this.ensureSourceObjects(source);
      } catch (error) {
        this.log.error(`Failed to create objects for "${source.name}": ${this.errorText(error)}`);
        continue;
      }
      this.startPolling(source);
    }
  }
  /**
   * Creates the object tree for one source (all levels explicitly)
   *
   * @param source - The validated source configuration
   */
  async ensureSourceObjects(source) {
    const segments = source.targetPath.split(".");
    for (let depth = 0; depth < segments.length; depth++) {
      const id = segments.slice(0, depth + 1).join(".");
      const isLast = depth === segments.length - 1;
      await this.setObjectNotExistsAsync(id, {
        type: isLast ? "channel" : "folder",
        common: { name: isLast ? source.name : segments[depth] },
        native: {}
      });
    }
    await this.setObjectNotExistsAsync(`${source.targetPath}.query`, {
      type: "state",
      common: { name: "Generated PromQL query", type: "string", role: "text", read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(`${source.targetPath}.lastUpdate`, {
      type: "state",
      common: { name: "Last successful update", type: "number", role: "date", read: true, write: false },
      native: {}
    });
    await this.setObjectNotExistsAsync(`${source.targetPath}.error`, {
      type: "state",
      common: { name: "Last error (empty if ok)", type: "string", role: "text", read: true, write: false },
      native: {}
    });
    if (source.groupBy.length === 0) {
      await this.setObjectNotExistsAsync(`${source.targetPath}.value`, {
        type: "state",
        common: { name: "Query result", type: "number", role: "value", read: true, write: false },
        native: {}
      });
    }
    await this.setState(`${source.targetPath}.query`, source.query, true);
  }
  /**
   * Starts the poll timer for one source with a random startup jitter
   *
   * @param source - The validated source configuration
   */
  startPolling(source) {
    const polling = {
      source,
      client: new import_prometheus_client.PrometheusClient({
        baseUrl: source.url,
        timeoutMs: this.requestTimeoutMs(),
        username: this.config.username || void 0,
        password: this.config.password || void 0
      }),
      inFlight: false
    };
    const jitter = Math.floor(Math.random() * MAX_STARTUP_JITTER_MS);
    const startupTimeout = this.setTimeout(() => {
      void this.pollSource(polling);
      const interval = this.setInterval(() => void this.pollSource(polling), source.pollIntervalMs);
      if (interval) {
        this.pollIntervals.push(interval);
      }
    }, jitter);
    if (startupTimeout) {
      this.startupTimeouts.push(startupTimeout);
    }
    this.log.info(
      `Polling "${source.name}" every ${source.pollIntervalMs / 1e3}s: ${source.query} -> ${source.targetPath}`
    );
  }
  /**
   * Runs one poll cycle for one source; never throws
   *
   * @param polling - Poll state of the source
   */
  async pollSource(polling) {
    if (this.isShuttingDown || polling.inFlight) {
      return;
    }
    polling.inFlight = true;
    const { source } = polling;
    try {
      const samples = await polling.client.instantQuery(source.query);
      this.setSourceHealth(source, true);
      try {
        await this.writeSamples(source, samples);
        await this.setState(`${source.targetPath}.error`, "", true);
        await this.setState(`${source.targetPath}.lastUpdate`, Date.now(), true);
      } catch (dataError) {
        const message = this.errorText(dataError);
        this.log.debug(`"${source.name}": ${message}`);
        await this.setState(`${source.targetPath}.error`, message, true);
      }
    } catch (error) {
      const message = this.errorText(error);
      this.log.warn(`Polling "${source.name}" failed: ${message}`);
      await this.setState(`${source.targetPath}.error`, message, true);
      this.setSourceHealth(source, false);
    } finally {
      polling.inFlight = false;
    }
  }
  /**
   * Writes the query result samples below the source's target path
   *
   * @param source - The validated source configuration
   * @param samples - Samples returned by the instant query
   */
  async writeSamples(source, samples) {
    if (source.groupBy.length === 0) {
      if (samples.length === 0) {
        throw new Error("Query returned no data");
      }
      if (samples.length > 1) {
        this.log.debug(
          `"${source.name}" returned ${samples.length} series; writing the first one. Add an aggregation or filters for a deterministic result.`
        );
      }
      await this.setState(`${source.targetPath}.value`, samples[0].value, true);
      return;
    }
    const usedKeys = /* @__PURE__ */ new Set();
    for (const sample of samples) {
      const key = source.groupBy.map((label) => {
        var _a;
        return (0, import_source_config.sanitizeIdSegment)((_a = sample.labels[label]) != null ? _a : "unknown");
      }).join("_");
      if (usedKeys.has(key)) {
        this.log.warn(
          `"${source.name}": series key "${key}" appears more than once after sanitizing the group-by label values; skipping the duplicate series`
        );
        continue;
      }
      usedKeys.add(key);
      const id = `${source.targetPath}.${key}`;
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
          name: source.groupBy.map((label) => {
            var _a;
            return `${label}=${(_a = sample.labels[label]) != null ? _a : "?"}`;
          }).join(", "),
          type: "number",
          role: "value",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setState(id, sample.value, true);
    }
    if (samples.length === 0) {
      this.log.debug(`"${source.name}" returned no series in this cycle`);
    }
  }
  /**
   * Tracks per-source health and aggregates it into info.connection
   *
   * @param source - The validated source configuration
   * @param healthy - Whether the last poll succeeded
   */
  setSourceHealth(source, healthy) {
    this.sourceHealth.set(source.targetPath, healthy);
    const allHealthy = [...this.sourceHealth.values()].every((value) => value);
    void this.setState("info.connection", this.sourceHealth.size > 0 && allHealthy, true);
  }
  /**
   * Handles requests from the Admin UI (dynamic dropdowns and live preview).
   *
   * @param obj - The received ioBroker message
   */
  onMessage(obj) {
    if (!(obj == null ? void 0 : obj.command)) {
      return;
    }
    void this.handleMessage(obj);
  }
  async handleMessage(obj) {
    const raw = typeof obj.message === "object" && obj.message !== null ? obj.message : {};
    const message = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => {
        var _a;
        return [
          key,
          typeof value === "string" ? (_a = (0, import_source_config.cleanAdminValue)(value)) != null ? _a : "" : value
        ];
      })
    );
    try {
      switch (obj.command) {
        case "testConnection": {
          const client = this.clientForUrl(message.url, message.username, message.password);
          if (!client) {
            this.respond(obj, { error: "Invalid Prometheus URL (expected e.g. http://host:9090)" });
            break;
          }
          await client.labelNames();
          this.respond(obj, { result: "connected" });
          break;
        }
        case "getMetricNames":
          this.respond(obj, await this.listForDropdown(message, (client) => client.metricNames()));
          break;
        case "getLabels": {
          const options = await this.listForDropdown(
            message,
            (client) => {
              var _a;
              return client.labelNames((_a = message.metric) == null ? void 0 : _a.trim());
            }
          );
          if (message.withEmpty) {
            options.unshift({ label: "\u2014 no filter \u2014", value: "" });
          }
          this.respond(obj, options);
          break;
        }
        case "getLabelValues":
          this.respond(
            obj,
            await this.listForDropdown(
              message,
              (client) => {
                var _a, _b;
                return client.labelValues((_a = message.label) != null ? _a : "", (_b = message.metric) == null ? void 0 : _b.trim());
              }
            )
          );
          break;
        case "previewQuery":
          this.respond(obj, await this.previewQuery(message));
          break;
        case "describeMetric":
          this.respond(obj, await this.describeMetric(message));
          break;
        default:
          this.log.warn(`Unknown command: ${obj.command}`);
          this.respond(obj, { error: `Unknown command: ${obj.command}` });
      }
    } catch (error) {
      const text = this.errorText(error);
      this.log.warn(`Command ${obj.command} failed: ${text}`);
      if (obj.command === "previewQuery" || obj.command === "describeMetric") {
        this.respond(obj, { text: `Error: ${text}` });
      } else if (obj.command === "testConnection") {
        this.respond(obj, { error: text });
      } else {
        this.respond(obj, []);
      }
    }
  }
  respond(obj, result) {
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, result, obj.callback);
    }
  }
  /**
   * Fetches a string list and converts it into selectSendTo options
   *
   * @param message - Payload of the Admin UI request
   * @param fetch - Function fetching the string list from the client
   */
  async listForDropdown(message, fetch) {
    const client = this.clientForUrl(message.url);
    if (!client) {
      this.log.warn(
        "Cannot load values for the Admin UI: no valid Prometheus server URL configured. Enter and save the server URL first."
      );
      return [];
    }
    const values = await fetch(client);
    return values.sort((a, b) => a.localeCompare(b)).slice(0, MAX_DROPDOWN_ENTRIES).map((value) => ({ label: value, value }));
  }
  /**
   * Renders a live overview of the selected metric (series count, labels
   * and their values) so the user can build filters without guessing.
   *
   * @param message - Payload of the Admin UI request
   */
  async describeMetric(message) {
    var _a;
    const metric = (_a = message.metric) == null ? void 0 : _a.trim();
    const client = this.clientForUrl(message.url);
    if (!client || !metric || !(0, import_query_builder.isValidMetricName)(metric)) {
      return { text: "" };
    }
    const samples = await client.instantQuery(metric);
    if (samples.length === 0) {
      return { text: `<b>${escapeHtml(metric)}</b>: no active series right now` };
    }
    const maxSeries = 500;
    const maxValues = 8;
    const labelValues = /* @__PURE__ */ new Map();
    for (const sample of samples.slice(0, maxSeries)) {
      for (const [label, value] of Object.entries(sample.labels)) {
        if (label === "__name__") {
          continue;
        }
        let values = labelValues.get(label);
        if (!values) {
          values = /* @__PURE__ */ new Set();
          labelValues.set(label, values);
        }
        values.add(value);
      }
    }
    const rows = [...labelValues.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, values]) => {
      const list = [...values].slice(0, maxValues).map(escapeHtml).join(", ");
      const more = values.size > maxValues ? ` \u2026 (+${values.size - maxValues} more)` : "";
      return `<tr><td style="padding:2px 12px 2px 0;vertical-align:top"><b>${escapeHtml(label)}</b></td><td>${list}${more}</td></tr>`;
    }).join("");
    const truncated = samples.length > maxSeries ? ` (labels from first ${maxSeries})` : "";
    return {
      text: `<div style="font-size:0.9em"><b>${escapeHtml(metric)}</b>: ${samples.length} series${truncated}, current value e.g. ${samples[0].value}<table style="margin-top:4px">${rows}</table></div>`
    };
  }
  /**
   * Builds the PromQL query from the (possibly unsaved) row data and runs it once
   *
   * @param message - Payload of the Admin UI request
   */
  async previewQuery(message) {
    var _a;
    const metric = (_a = message.metric) == null ? void 0 : _a.trim();
    const client = this.clientForUrl(message.url);
    if (!client || !metric) {
      return { text: "Configure URL and metric first" };
    }
    const aggregation = import_query_builder.AGGREGATIONS.includes(message.aggregation) ? message.aggregation : "none";
    const raw = message;
    const query = (0, import_query_builder.buildQuery)({
      metric,
      filters: (0, import_source_config.collectFilters)(raw),
      aggregation,
      groupBy: aggregation === "none" ? [] : (0, import_source_config.parseGroupBy)(message.groupBy)
    });
    const samples = await client.instantQuery(query);
    const values = samples.length === 0 ? "no data" : samples.slice(0, 10).map((sample) => {
      const labels = Object.entries(sample.labels).map(([key, value]) => `${key}=${value}`).join(",");
      return labels ? `{${labels}}: ${sample.value}` : String(sample.value);
    }).join(" | ");
    const suffix = samples.length > 10 ? ` (+${samples.length - 10} more)` : "";
    return { text: `${query}  =>  ${values}${suffix}` };
  }
  /**
   * Creates a client for Admin UI requests. Falls back to the saved server
   * configuration when the message does not carry its own values.
   *
   * @param url - Prometheus base URL from the Admin UI, if provided
   * @param username - Basic auth user name override, if provided
   * @param password - Basic auth password override, if provided
   */
  clientForUrl(url, username, password) {
    var _a, _b;
    const fromMessage = url == null ? void 0 : url.trim();
    const usable = fromMessage && !fromMessage.includes("${") && fromMessage !== "undefined" && fromMessage !== "null" ? fromMessage : void 0;
    const validated = (_a = (0, import_source_config.validateUrl)(usable)) != null ? _a : (0, import_source_config.validateUrl)(this.config.url);
    if (!validated) {
      return void 0;
    }
    const user = username != null ? username : this.config.username || void 0;
    return new import_prometheus_client.PrometheusClient({
      baseUrl: validated,
      timeoutMs: this.requestTimeoutMs(),
      username: user || void 0,
      password: user ? (_b = password != null ? password : this.config.password) != null ? _b : "" : void 0
    });
  }
  /** Starts tracking all custom-enabled states and the /metrics HTTP server */
  async startExporter() {
    var _a, _b, _c, _d;
    this.systemLanguage = ((_b = (_a = await this.getForeignObjectAsync("system.config")) == null ? void 0 : _a.common) == null ? void 0 : _b.language) || "en";
    const view = await this.getObjectViewAsync("system", "custom", {});
    for (const row of view.rows) {
      const custom = (_c = row.value) == null ? void 0 : _c[this.namespace];
      if (custom == null ? void 0 : custom.enabled) {
        await this.trackState(row.id, custom);
      }
    }
    await this.subscribeForeignObjectsAsync("*");
    const port = this.exporterPort();
    const bind = ((_d = this.config.bind) == null ? void 0 : _d.trim()) || "0.0.0.0";
    this.exporterServer = http.createServer((req, res) => {
      var _a2;
      if (((_a2 = req.url) == null ? void 0 : _a2.split("?")[0]) === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(this.registry.render());
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found. Metrics are available at /metrics\n");
      }
    });
    this.exporterServer.on("error", (error) => {
      this.log.error(`Exporter HTTP server error: ${this.errorText(error)}`);
    });
    await new Promise((resolve, reject) => {
      var _a2, _b2;
      (_a2 = this.exporterServer) == null ? void 0 : _a2.once("error", reject);
      (_b2 = this.exporterServer) == null ? void 0 : _b2.listen(port, bind, () => resolve());
    });
    this.log.info(`Exporter listening on http://${bind}:${port}/metrics (${this.registry.size} states)`);
  }
  /**
   * Starts exporting one state
   *
   * @param id - The foreign state id
   * @param custom - The per-datapoint settings of this adapter instance
   * @param custom.metricName - Optional custom metric name for this state
   */
  async trackState(id, custom) {
    var _a;
    try {
      const obj = await this.getForeignObjectAsync(id);
      if ((obj == null ? void 0 : obj.type) !== "state") {
        return;
      }
      const state = await this.getForeignStateAsync(id);
      this.registry.set(id, {
        name: this.stateName(obj) || id,
        value: (0, import_exporter.toMetricValue)(state == null ? void 0 : state.val),
        metricName: ((_a = custom.metricName) == null ? void 0 : _a.trim()) || void 0
      });
      if (!this.exportedIds.has(id)) {
        this.exportedIds.add(id);
        await this.subscribeForeignStatesAsync(id);
        this.log.debug(`Exporting state ${id}`);
      }
    } catch (error) {
      this.log.warn(`Cannot export state ${id}: ${this.errorText(error)}`);
    }
  }
  /**
   * Stops exporting one state
   *
   * @param id - The foreign state id
   */
  async untrackState(id) {
    if (this.exportedIds.delete(id)) {
      this.registry.remove(id);
      await this.unsubscribeForeignStatesAsync(id);
      this.log.debug(`No longer exporting state ${id}`);
    }
  }
  /**
   * Resolves the display name of an object in the system language
   *
   * @param obj - The ioBroker object
   */
  stateName(obj) {
    var _a, _b, _c;
    const name = (_a = obj.common) == null ? void 0 : _a.name;
    if (typeof name === "string") {
      return name;
    }
    if (name && typeof name === "object") {
      const translated = (_b = name[this.systemLanguage]) != null ? _b : name.en;
      return (_c = translated != null ? translated : Object.values(name)[0]) != null ? _c : "";
    }
    return "";
  }
  /**
   * Tracks value changes of exported states
   *
   * @param id - State id
   * @param state - New state value or null/undefined when deleted
   */
  onStateChange(id, state) {
    if (!this.exportedIds.has(id)) {
      return;
    }
    this.registry.updateValue(id, state ? (0, import_exporter.toMetricValue)(state.val) : void 0);
  }
  /**
   * Reacts to per-datapoint custom settings changes while the exporter runs
   *
   * @param id - Object id
   * @param obj - Changed object or null/undefined when deleted
   */
  onObjectChange(id, obj) {
    var _a, _b;
    if (!this.config.exporterEnabled) {
      return;
    }
    const custom = (_b = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.custom) == null ? void 0 : _b[this.namespace];
    if (custom == null ? void 0 : custom.enabled) {
      void this.trackState(id, custom);
    } else {
      void this.untrackState(id);
    }
  }
  exporterPort() {
    const parsed = Number(this.config.port);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 9126;
  }
  requestTimeoutMs() {
    const parsed = Number(this.config.requestTimeout);
    const seconds = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 300) : DEFAULT_REQUEST_TIMEOUT_SEC;
    return Math.floor(seconds * 1e3);
  }
  errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    this.isShuttingDown = true;
    try {
      for (const timeout of this.startupTimeouts) {
        this.clearTimeout(timeout);
      }
      this.startupTimeouts = [];
      for (const interval of this.pollIntervals) {
        this.clearInterval(interval);
      }
      this.pollIntervals = [];
      if (this.exporterServer) {
        this.exporterServer.close();
        this.exporterServer = void 0;
      }
      this.registry.clear();
      this.exportedIds.clear();
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${this.errorText(error)}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Prometheus(options);
} else {
  (() => new Prometheus())();
}
//# sourceMappingURL=main.js.map
