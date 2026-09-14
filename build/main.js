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
var utils = __toESM(require("@iobroker/adapter-core"));
var import_query_builder = require("./lib/query-builder");
var import_prometheus_client = require("./lib/prometheus-client");
var import_source_config = require("./lib/source-config");
const DEFAULT_REQUEST_TIMEOUT_SEC = 10;
const MAX_DROPDOWN_ENTRIES = 2e3;
const MAX_STARTUP_JITTER_MS = 5e3;
class Prometheus extends utils.Adapter {
  pollIntervals = [];
  startupTimeouts = [];
  isShuttingDown = false;
  /** Health of each source (by target path), used for info.connection */
  sourceHealth = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super({
      ...options,
      name: "prometheus"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
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
      await this.writeSamples(source, samples);
      await this.setState(`${source.targetPath}.error`, "", true);
      await this.setState(`${source.targetPath}.lastUpdate`, Date.now(), true);
      this.setSourceHealth(source, true);
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
    const message = typeof obj.message === "object" && obj.message !== null ? obj.message : {};
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
        case "getLabels":
          this.respond(
            obj,
            await this.listForDropdown(message, (client) => {
              var _a;
              return client.labelNames((_a = message.metric) == null ? void 0 : _a.trim());
            })
          );
          break;
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
        default:
          this.log.warn(`Unknown command: ${obj.command}`);
          this.respond(obj, { error: `Unknown command: ${obj.command}` });
      }
    } catch (error) {
      const text = this.errorText(error);
      this.log.warn(`Command ${obj.command} failed: ${text}`);
      if (obj.command === "previewQuery") {
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
