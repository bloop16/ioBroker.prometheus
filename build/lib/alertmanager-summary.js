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
var alertmanager_summary_exports = {};
__export(alertmanager_summary_exports, {
  MAX_JSON_ENTRIES: () => MAX_JSON_ENTRIES,
  MAX_TEXT_LENGTH: () => MAX_TEXT_LENGTH,
  NO_SEVERITY: () => NO_SEVERITY,
  summarizeAlerts: () => summarizeAlerts,
  summarizeSilences: () => summarizeSilences
});
module.exports = __toCommonJS(alertmanager_summary_exports);
var import_source_config = require("./source-config");
const MAX_JSON_ENTRIES = 500;
const MAX_TEXT_LENGTH = 500;
const NO_SEVERITY = "none";
function truncate(text) {
  return text.slice(0, MAX_TEXT_LENGTH);
}
function timestamp(value) {
  return Date.parse(value) || 0;
}
function toJsonEntry(alert) {
  var _a, _b, _c, _d;
  return {
    alertname: (_a = alert.labels.alertname) != null ? _a : "",
    severity: (_b = alert.labels.severity) != null ? _b : "",
    instance: (_c = alert.labels.instance) != null ? _c : "",
    summary: truncate((_d = alert.annotations.summary) != null ? _d : ""),
    startsAt: alert.startsAt,
    fingerprint: alert.fingerprint
  };
}
function countBySeverity(alerts) {
  return alerts.reduce((counts, alert) => {
    var _a;
    const key = alert.labels.severity ? (0, import_source_config.sanitizeIdSegment)(alert.labels.severity) : NO_SEVERITY;
    return { ...counts, [key]: ((_a = counts[key]) != null ? _a : 0) + 1 };
  }, {});
}
function summarizeAlerts(alerts) {
  const sorted = [...alerts].sort(
    (a, b) => timestamp(b.startsAt) - timestamp(a.startsAt) || a.fingerprint.localeCompare(b.fingerprint)
  );
  return {
    count: alerts.length,
    bySeverity: countBySeverity(alerts),
    entries: sorted.slice(0, MAX_JSON_ENTRIES).map(toJsonEntry)
  };
}
function summarizeSilences(silences) {
  const sorted = [...silences].sort((a, b) => timestamp(a.endsAt) - timestamp(b.endsAt) || a.id.localeCompare(b.id));
  return {
    count: silences.length,
    entries: sorted.slice(0, MAX_JSON_ENTRIES).map((silence) => ({ ...silence, comment: truncate(silence.comment) }))
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_JSON_ENTRIES,
  MAX_TEXT_LENGTH,
  NO_SEVERITY,
  summarizeAlerts,
  summarizeSilences
});
//# sourceMappingURL=alertmanager-summary.js.map
