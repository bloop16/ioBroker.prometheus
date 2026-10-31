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
function toGroup(key, alerts, rules, suppressed) {
  var _a, _b, _c;
  const { entries, count } = (0, import_alertmanager_summary.summarizeAlerts)(alerts);
  const newest = entries.at(0);
  const muted = (_a = suppressed.at(0)) == null ? void 0 : _a.labels;
  const severities = rules.length > 0 ? rules.map((rule) => rule.severity) : suppressed.map((s) => {
    var _a2;
    return (_a2 = s.labels.severity) != null ? _a2 : "";
  });
  return {
    key,
    name: (newest == null ? void 0 : newest.alertname) || ((_b = rules.at(0)) == null ? void 0 : _b.name) || (muted == null ? void 0 : muted.alertname) || UNNAMED,
    active: count > 0,
    silenced: suppressed.length > 0,
    count,
    severity: joinSeverities(newest ? entries.map((entry) => entry.severity) : severities),
    summary: (_c = newest == null ? void 0 : newest.summary) != null ? _c : "",
    startsAt: newest ? Date.parse(newest.startsAt) || null : null,
    entries
  };
}
function groupAlerts(alerts, rules, suppressed = []) {
  const alertsByKey = groupBy(alerts, (alert) => keyOf(alert.labels.alertname));
  const rulesByKey = groupBy(rules, (rule) => keyOf(rule.name));
  const suppressedByKey = groupBy(suppressed, (alert) => keyOf(alert.labels.alertname));
  const keys = [.../* @__PURE__ */ new Set([...alertsByKey.keys(), ...rulesByKey.keys(), ...suppressedByKey.keys()])].sort();
  return keys.map(
    (key) => {
      var _a, _b, _c;
      return toGroup(key, (_a = alertsByKey.get(key)) != null ? _a : [], (_b = rulesByKey.get(key)) != null ? _b : [], (_c = suppressedByKey.get(key)) != null ? _c : []);
    }
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  groupAlerts
});
//# sourceMappingURL=alertmanager-groups.js.map
