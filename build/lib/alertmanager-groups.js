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
var alertmanager_groups_exports = {};
__export(alertmanager_groups_exports, {
  groupAlerts: () => groupAlerts
});
module.exports = __toCommonJS(alertmanager_groups_exports);
var import_alertmanager_summary = require("./alertmanager-summary");
var import_source_config = require("./source-config");
const UNNAMED = "unnamed";
function keyOf(name) {
  return name ? (0, import_source_config.sanitizeIdSegment)(name) : UNNAMED;
}
function groupBy(items, key) {
  return items.reduce((groups, item) => {
    var _a;
    const itemKey = key(item);
    return new Map(groups).set(itemKey, [...(_a = groups.get(itemKey)) != null ? _a : [], item]);
  }, /* @__PURE__ */ new Map());
}
function joinSeverities(severities) {
  return [...new Set(severities.filter((severity) => severity !== ""))].sort().join(", ");
}
function toGroup(key, alerts, rules) {
  var _a, _b;
  const { entries, count } = (0, import_alertmanager_summary.summarizeAlerts)(alerts);
  const newest = entries.at(0);
  return {
    key,
    name: (newest == null ? void 0 : newest.alertname) || ((_a = rules.at(0)) == null ? void 0 : _a.name) || UNNAMED,
    active: count > 0,
    count,
    severity: joinSeverities(newest ? entries.map((entry) => entry.severity) : rules.map((rule) => rule.severity)),
    summary: (_b = newest == null ? void 0 : newest.summary) != null ? _b : "",
    startsAt: newest ? Date.parse(newest.startsAt) || null : null,
    entries
  };
}
function groupAlerts(alerts, rules) {
  const alertsByKey = groupBy(alerts, (alert) => keyOf(alert.labels.alertname));
  const rulesByKey = groupBy(rules, (rule) => keyOf(rule.name));
  const keys = [.../* @__PURE__ */ new Set([...alertsByKey.keys(), ...rulesByKey.keys()])].sort();
  return keys.map((key) => {
    var _a, _b;
    return toGroup(key, (_a = alertsByKey.get(key)) != null ? _a : [], (_b = rulesByKey.get(key)) != null ? _b : []);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  groupAlerts
});
//# sourceMappingURL=alertmanager-groups.js.map
