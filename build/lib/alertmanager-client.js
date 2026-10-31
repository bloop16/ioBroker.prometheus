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
var alertmanager_client_exports = {};
__export(alertmanager_client_exports, {
  AlertmanagerClient: () => AlertmanagerClient,
  testAlertmanager: () => testAlertmanager
});
module.exports = __toCommonJS(alertmanager_client_exports);
var import_axios = __toESM(require("axios"));
var import_source_config = require("./source-config");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" ? value : "";
}
function stringRecord(value) {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[1] === "string")
  );
}
function renderMatcher(matcher) {
  const operator = `${matcher.isEqual === false ? "!" : "="}${matcher.isRegex === true ? "~" : ""}`;
  const normalized = operator === "!" ? "!=" : operator;
  return `${asString(matcher.name)}${normalized}"${asString(matcher.value)}"`;
}
function toAlert(raw) {
  if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.labels)) {
    return void 0;
  }
  return {
    fingerprint: raw.fingerprint,
    labels: stringRecord(raw.labels),
    annotations: stringRecord(raw.annotations),
    startsAt: asString(raw.startsAt)
  };
}
function toActiveSilence(raw) {
  if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.status) || raw.status.state !== "active") {
    return void 0;
  }
  return {
    id: raw.id,
    matchers: Array.isArray(raw.matchers) ? raw.matchers.filter(isRecord).map(renderMatcher) : [],
    createdBy: asString(raw.createdBy),
    comment: asString(raw.comment),
    startsAt: asString(raw.startsAt),
    endsAt: asString(raw.endsAt)
  };
}
class AlertmanagerClient {
  options;
  httpGet;
  /**
   * @param options - Connection options for the Alertmanager
   * @param httpGet - Optional HTTP implementation override (used by unit tests)
   */
  constructor(options, httpGet) {
    this.options = options;
    this.httpGet = httpGet != null ? httpGet : ((url, requestOptions) => import_axios.default.get(url, requestOptions));
  }
  /**
   * Returns the firing alerts that are neither silenced nor inhibited
   *
   * @param matchers - Matcher expressions the alerts must fulfil
   */
  async activeAlerts(matchers) {
    const data = await this.list("/api/v2/alerts", {
      active: "true",
      silenced: "false",
      inhibited: "false",
      // alerts not yet processed may still turn out to be silenced
      unprocessed: "false",
      filter: matchers
    });
    return data.map(toAlert).filter((entry) => entry !== void 0);
  }
  /** Returns the active silences; older servers cannot filter them, so this is done here */
  async activeSilences() {
    const data = await this.list("/api/v2/silences");
    return data.map(toActiveSilence).filter((entry) => entry !== void 0);
  }
  /** Returns the server version; rejects if the server is no Alertmanager */
  async version() {
    const data = await this.request("/api/v2/status");
    if (!isRecord(data) || !isRecord(data.versionInfo)) {
      throw new Error("Unexpected response from /api/v2/status: not an Alertmanager");
    }
    return asString(data.versionInfo.version) || "unknown";
  }
  async list(path, params) {
    const data = await this.request(path, params);
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response from ${path}: expected an array`);
    }
    return data;
  }
  async request(path, params) {
    var _a;
    const response = await this.httpGet(`${this.options.baseUrl}${path}`, {
      params,
      paramsSerializer: { indexes: null },
      timeout: this.options.timeoutMs,
      auth: this.options.username ? { username: this.options.username, password: (_a = this.options.password) != null ? _a : "" } : void 0
    });
    return response.data;
  }
}
async function testAlertmanager(options) {
  const baseUrl = (0, import_source_config.validateUrl)(options.url);
  if (!baseUrl) {
    return { error: "Invalid Alertmanager URL (expected e.g. http://host:9093)" };
  }
  const version = await new AlertmanagerClient({ ...options, baseUrl }).version();
  return { result: `Connected to Alertmanager ${version}` };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AlertmanagerClient,
  testAlertmanager
});
//# sourceMappingURL=alertmanager-client.js.map
