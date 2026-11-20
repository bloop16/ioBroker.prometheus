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
  normalizeAlertmanagerConfig: () => normalizeAlertmanagerConfig
});
module.exports = __toCommonJS(alertmanager_config_exports);
var import_source_config = require("./source-config");
function normalizeAlertmanagerConfig(raw) {
  var _a;
  const url = (0, import_source_config.validateUrl)((_a = raw.url) == null ? void 0 : _a.trim());
  return url ? { url, pollIntervalMs: (0, import_source_config.clampPollIntervalMs)(raw.pollInterval) } : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  normalizeAlertmanagerConfig
});
//# sourceMappingURL=alertmanager-config.js.map
