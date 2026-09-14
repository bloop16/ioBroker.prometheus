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
var exporter_exports = {};
__export(exporter_exports, {
  DEFAULT_METRIC_NAME: () => DEFAULT_METRIC_NAME,
  MetricsRegistry: () => MetricsRegistry,
  toMetricValue: () => toMetricValue
});
module.exports = __toCommonJS(exporter_exports);
var import_query_builder = require("./query-builder");
const DEFAULT_METRIC_NAME = "iobroker_state";
function toMetricValue(value) {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" || typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
class MetricsRegistry {
  states = /* @__PURE__ */ new Map();
  /** Number of tracked states */
  get size() {
    return this.states.size;
  }
  /**
   * Adds or updates one exported state
   *
   * @param id - The ioBroker state id
   * @param entry - Name, current value and optional custom metric name
   */
  set(id, entry) {
    this.states.set(id, entry);
  }
  /**
   * Updates the value of an already tracked state; unknown ids are ignored
   *
   * @param id - The ioBroker state id
   * @param value - The new sample value (undefined removes the sample)
   */
  updateValue(id, value) {
    const entry = this.states.get(id);
    if (entry) {
      this.states.set(id, { ...entry, value });
    }
  }
  /**
   * Stops exporting one state
   *
   * @param id - The ioBroker state id
   */
  remove(id) {
    this.states.delete(id);
  }
  /** Removes all tracked states */
  clear() {
    this.states.clear();
  }
  /** Renders all current values in the Prometheus text exposition format */
  render() {
    const byMetric = /* @__PURE__ */ new Map();
    for (const [id, entry] of this.states) {
      if (entry.value === void 0) {
        continue;
      }
      const metric = entry.metricName && (0, import_query_builder.isValidMetricName)(entry.metricName) ? entry.metricName : DEFAULT_METRIC_NAME;
      const labels = `id="${(0, import_query_builder.escapeLabelValue)(id)}",name="${(0, import_query_builder.escapeLabelValue)(entry.name)}"`;
      let lines = byMetric.get(metric);
      if (!lines) {
        lines = [];
        byMetric.set(metric, lines);
      }
      lines.push(`${metric}{${labels}} ${entry.value}`);
    }
    const output = [];
    for (const [metric, lines] of [...byMetric.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      output.push(`# HELP ${metric} ioBroker state values exported by iobroker.prometheus`);
      output.push(`# TYPE ${metric} gauge`);
      output.push(...lines.sort());
    }
    return output.length > 0 ? `${output.join("\n")}
` : "";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_METRIC_NAME,
  MetricsRegistry,
  toMetricValue
});
//# sourceMappingURL=exporter.js.map
