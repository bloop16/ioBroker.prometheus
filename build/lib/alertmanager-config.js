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
var alertmanager_config_exports = {};
__export(alertmanager_config_exports, {
  buildMatchers: () => buildMatchers,
  normalizeAlertmanagerConfig: () => normalizeAlertmanagerConfig
});
module.exports = __toCommonJS(alertmanager_config_exports);
var import_query_builder = require("./query-builder");
var import_source_config = require("./source-config");
const MATCHER_OPERATORS = ["=", "!=", "=~", "!~"];
function buildMatchers(filters) {
  if (filters === void 0 || filters === null || filters === "") {
    return { matchers: [], errors: [] };
  }
  if (!Array.isArray(filters)) {
    return { matchers: [], errors: [`Invalid alert filters: expected a list, got ${JSON.stringify(filters)}`] };
  }
  const rows = filters.map((row) => {
    var _a, _b, _c;
    return {
      label: (_b = (_a = row.label) == null ? void 0 : _a.trim()) != null ? _b : "",
      operator: row.operator || "=",
      value: (_c = row.value) != null ? _c : ""
    };
  });
  const used = rows.filter((row) => row.label !== "");
  const isValid = (row) => (0, import_query_builder.isValidLabelName)(row.label) && MATCHER_OPERATORS.includes(row.operator);
  return {
    matchers: used.filter(isValid).map((row) => `${row.label}${row.operator}"${(0, import_query_builder.escapeLabelValue)(row.value)}"`),
    errors: used.filter((row) => !isValid(row)).map((row) => `Invalid alert filter: ${row.label} ${row.operator} ${row.value}`)
  };
}
function normalizeAlertmanagerConfig(raw) {
  var _a;
  const url = (0, import_source_config.validateUrl)((_a = raw.url) == null ? void 0 : _a.trim());
  if (!url) {
    return { errors: ["Invalid Alertmanager URL (expected e.g. http://host:9093)"] };
  }
  const { matchers, errors } = buildMatchers(raw.filters);
  return { config: { url, pollIntervalMs: (0, import_source_config.clampPollIntervalMs)(raw.pollInterval), matchers }, errors };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildMatchers,
  normalizeAlertmanagerConfig
});
//# sourceMappingURL=alertmanager-config.js.map
