"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var prometheus_client_exports = {};
__export(prometheus_client_exports, {
  PrometheusClient: () => PrometheusClient
});
module.exports = __toCommonJS(prometheus_client_exports);
var import_axios = __toESM(require("axios"));
var import_query_builder = require("./query-builder");
function isEnvelope(data) {
  return typeof data === "object" && data !== null && typeof data.status === "string";
}
function isVectorEntry(entry) {
  return typeof entry === "object" && entry !== null && Array.isArray(entry.value);
}
class PrometheusClient {
  options;
  httpGet;
  /**
   * @param options - Connection options for the Prometheus server
   * @param httpGet - Optional HTTP implementation override (used by unit tests)
   */
  constructor(options, httpGet) {
    this.options = options;
    this.httpGet = httpGet != null ? httpGet : ((url, requestOptions) => import_axios.default.get(url, requestOptions));
  }
  /**
   * Runs an instant query and returns all resulting samples
   *
   * @param query - The PromQL query to execute
   */
  async instantQuery(query) {
    var _a;
    const data = await this.request("/api/v1/query", { query });
    if ((data == null ? void 0 : data.resultType) === "scalar" && Array.isArray(data.result)) {
      return [{ labels: {}, value: Number(data.result[1]) }];
    }
    if ((data == null ? void 0 : data.resultType) === "vector" && Array.isArray(data.result)) {
      return data.result.filter(isVectorEntry).map((entry) => {
        var _a2;
        return {
          labels: (_a2 = entry.metric) != null ? _a2 : {},
          value: Number(entry.value[1])
        };
      });
    }
    throw new Error(`Unexpected query result type "${(_a = data == null ? void 0 : data.resultType) != null ? _a : "unknown"}"`);
  }
  /** Returns all known metric names of the Prometheus instance */
  metricNames() {
    return this.stringList("/api/v1/label/__name__/values");
  }
  /**
   * Returns all label names, optionally narrowed to a metric
   *
   * @param metric - Optional metric name used as match[] selector
   */
  labelNames(metric) {
    return this.stringList("/api/v1/labels", this.matchParams(metric));
  }
  /**
   * Returns all values of one label, optionally narrowed to a metric
   *
   * @param label - The label name whose values are requested
   * @param metric - Optional metric name used as match[] selector
   */
  labelValues(label, metric) {
    if (!(0, import_query_builder.isValidLabelName)(label)) {
      return Promise.reject(new Error(`Invalid label name: "${label}"`));
    }
    return this.stringList(`/api/v1/label/${encodeURIComponent(label)}/values`, this.matchParams(metric));
  }
  matchParams(metric) {
    if (metric && (0, import_query_builder.isValidMetricName)(metric)) {
      return { "match[]": metric };
    }
    return void 0;
  }
  async stringList(path, params) {
    const data = await this.request(path, params);
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response from ${path}: expected an array`);
    }
    return data.filter((entry) => typeof entry === "string");
  }
  async request(path, params) {
    var _a, _b, _c;
    const response = await this.httpGet(`${this.options.baseUrl}${path}`, {
      params,
      timeout: this.options.timeoutMs,
      auth: this.options.username ? { username: this.options.username, password: (_a = this.options.password) != null ? _a : "" } : void 0
    });
    if (!isEnvelope(response.data)) {
      throw new Error(`Unexpected response from ${path}: not a Prometheus API envelope`);
    }
    if (response.data.status !== "success") {
      throw new Error(
        `Prometheus API error (${(_b = response.data.errorType) != null ? _b : "unknown"}): ${(_c = response.data.error) != null ? _c : "no details"}`
      );
    }
    return response.data.data;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PrometheusClient
});
//# sourceMappingURL=prometheus-client.js.map
