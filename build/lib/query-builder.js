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
var query_builder_exports = {};
__export(query_builder_exports, {
  AGGREGATIONS: () => AGGREGATIONS,
  buildQuery: () => buildQuery,
  escapeLabelValue: () => escapeLabelValue,
  isValidLabelName: () => isValidLabelName,
  isValidMetricName: () => isValidMetricName
});
module.exports = __toCommonJS(query_builder_exports);
const AGGREGATIONS = ["none", "avg", "sum", "min", "max", "count"];
const METRIC_NAME_REGEX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function isValidMetricName(metric) {
  return METRIC_NAME_REGEX.test(metric);
}
function isValidLabelName(label) {
  return LABEL_NAME_REGEX.test(label);
}
function escapeLabelValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
function buildQuery(spec) {
  if (!isValidMetricName(spec.metric)) {
    throw new Error(`Invalid metric name: "${spec.metric}"`);
  }
  if (!AGGREGATIONS.includes(spec.aggregation)) {
    throw new Error(`Invalid aggregation: "${String(spec.aggregation)}"`);
  }
  const matchers = spec.filters.map((filter) => {
    if (!isValidLabelName(filter.label)) {
      throw new Error(`Invalid filter label name: "${filter.label}"`);
    }
    return `${filter.label}="${escapeLabelValue(filter.value)}"`;
  });
  const selector = matchers.length > 0 ? `${spec.metric}{${matchers.join(",")}}` : spec.metric;
  if (spec.aggregation === "none") {
    return selector;
  }
  if (spec.groupBy.length > 0) {
    for (const label of spec.groupBy) {
      if (!isValidLabelName(label)) {
        throw new Error(`Invalid groupBy label name: "${label}"`);
      }
    }
    return `${spec.aggregation} by (${spec.groupBy.join(",")}) (${selector})`;
  }
  return `${spec.aggregation}(${selector})`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AGGREGATIONS,
  buildQuery,
  escapeLabelValue,
  isValidLabelName,
  isValidMetricName
});
//# sourceMappingURL=query-builder.js.map
