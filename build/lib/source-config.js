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
var source_config_exports = {};
__export(source_config_exports, {
  DEFAULT_POLL_INTERVAL_SEC: () => DEFAULT_POLL_INTERVAL_SEC,
  FILTER_SLOT_COUNT: () => FILTER_SLOT_COUNT,
  MAX_POLL_INTERVAL_SEC: () => MAX_POLL_INTERVAL_SEC,
  METRICS_CHANNEL: () => METRICS_CHANNEL,
  MIN_POLL_INTERVAL_SEC: () => MIN_POLL_INTERVAL_SEC,
  collectFilters: () => collectFilters,
  normalizeSources: () => normalizeSources,
  parseGroupBy: () => parseGroupBy,
  sanitizeIdSegment: () => sanitizeIdSegment,
  sanitizeTargetPath: () => sanitizeTargetPath,
  validateUrl: () => validateUrl
});
module.exports = __toCommonJS(source_config_exports);
var import_query_builder = require("./query-builder");
const FILTER_SLOT_COUNT = 5;
const METRICS_CHANNEL = "metrics";
const MIN_POLL_INTERVAL_SEC = 5;
const MAX_POLL_INTERVAL_SEC = 86400;
const DEFAULT_POLL_INTERVAL_SEC = 60;
function sanitizeIdSegment(segment) {
  const sanitized = segment.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "");
  return sanitized.length > 0 ? sanitized : "source";
}
function sanitizeTargetPath(path) {
  return path.split(".").filter((segment) => segment.length > 0).map(sanitizeIdSegment).join(".");
}
function parseGroupBy(groupBy) {
  if (Array.isArray(groupBy)) {
    return groupBy.map((label) => label.trim()).filter((label) => label.length > 0);
  }
  if (typeof groupBy === "string") {
    return groupBy.split(",").map((label) => label.trim()).filter((label) => label.length > 0);
  }
  return [];
}
function collectFilters(raw) {
  var _a;
  const filters = [];
  for (let slot = 1; slot <= FILTER_SLOT_COUNT; slot++) {
    const label = (_a = raw[`filter${slot}Label`]) == null ? void 0 : _a.trim();
    const value = raw[`filter${slot}Value`];
    if (label && value !== void 0 && value !== "") {
      filters.push({ label, value });
    }
  }
  return filters;
}
function clampPollIntervalMs(pollInterval) {
  const parsed = Number(pollInterval);
  const seconds = Number.isFinite(parsed) ? Math.min(Math.max(parsed, MIN_POLL_INTERVAL_SEC), MAX_POLL_INTERVAL_SEC) : DEFAULT_POLL_INTERVAL_SEC;
  return Math.floor(seconds * 1e3);
}
function validateUrl(url) {
  if (!url) {
    return void 0;
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return void 0;
    }
    return withScheme.replace(/\/+$/, "");
  } catch {
    return void 0;
  }
}
function normalizeAggregation(aggregation) {
  const value = aggregation || "avg";
  return import_query_builder.AGGREGATIONS.includes(value) ? value : void 0;
}
function normalizeSources(rawSources, serverUrl) {
  const sources = [];
  const errors = [];
  const usedPaths = /* @__PURE__ */ new Set();
  if (!Array.isArray(rawSources)) {
    return { sources, errors };
  }
  const url = validateUrl(serverUrl == null ? void 0 : serverUrl.trim());
  if (!url) {
    if (rawSources.some((raw) => raw.enabled !== false)) {
      errors.push(
        `invalid or missing Prometheus server URL "${serverUrl != null ? serverUrl : ""}" (expected e.g. http://host:9090)`
      );
    }
    return { sources, errors };
  }
  rawSources.forEach((raw, index) => {
    var _a, _b, _c, _d, _e;
    const name = ((_a = raw.name) == null ? void 0 : _a.trim()) || `Source ${index + 1}`;
    if (raw.enabled === false) {
      return;
    }
    const metric = (_b = raw.metric) == null ? void 0 : _b.trim();
    if (!metric) {
      errors.push(`${name}: no metric configured`);
      return;
    }
    const aggregation = normalizeAggregation((_c = raw.aggregation) == null ? void 0 : _c.trim());
    if (!aggregation) {
      errors.push(`${name}: unknown aggregation "${(_d = raw.aggregation) != null ? _d : ""}"`);
      return;
    }
    const groupBy = aggregation === "none" ? [] : parseGroupBy(raw.groupBy);
    let query;
    try {
      query = (0, import_query_builder.buildQuery)({ metric, filters: collectFilters(raw), aggregation, groupBy });
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let targetPath = sanitizeTargetPath(((_e = raw.targetPath) == null ? void 0 : _e.trim()) || name);
    if (!targetPath) {
      targetPath = sanitizeIdSegment(name);
    }
    if (targetPath !== METRICS_CHANNEL && !targetPath.startsWith(`${METRICS_CHANNEL}.`)) {
      targetPath = `${METRICS_CHANNEL}.${targetPath}`;
    }
    while (usedPaths.has(targetPath)) {
      targetPath = `${targetPath}_${index}`;
    }
    usedPaths.add(targetPath);
    sources.push({
      name,
      url,
      pollIntervalMs: clampPollIntervalMs(raw.pollInterval),
      targetPath,
      query,
      groupBy
    });
  });
  return { sources, errors };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_POLL_INTERVAL_SEC,
  FILTER_SLOT_COUNT,
  MAX_POLL_INTERVAL_SEC,
  METRICS_CHANNEL,
  MIN_POLL_INTERVAL_SEC,
  collectFilters,
  normalizeSources,
  parseGroupBy,
  sanitizeIdSegment,
  sanitizeTargetPath,
  validateUrl
});
//# sourceMappingURL=source-config.js.map
