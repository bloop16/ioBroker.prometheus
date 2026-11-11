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
var tls_options_exports = {};
__export(tls_options_exports, {
  buildHttpsAgent: () => buildHttpsAgent,
  parseCaCertificates: () => parseCaCertificates,
  tlsSettingsFromMessage: () => tlsSettingsFromMessage
});
module.exports = __toCommonJS(tls_options_exports);
var import_node_crypto = require("node:crypto");
var import_node_https = __toESM(require("node:https"));
var import_node_tls = __toESM(require("node:tls"));
function defaultCaCertificates() {
  return typeof import_node_tls.default.getCACertificates === "function" ? import_node_tls.default.getCACertificates("default") : import_node_tls.default.rootCertificates;
}
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
function parseCaCertificates(raw) {
  var _a;
  const text = (raw != null ? raw : "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return [];
  }
  const blocks = (_a = text.match(PEM_BLOCK)) != null ? _a : [];
  if (blocks.length === 0) {
    throw new Error("CA certificate contains no PEM certificate (expected -----BEGIN CERTIFICATE-----)");
  }
  return blocks.map((block, index) => {
    try {
      new import_node_crypto.X509Certificate(block);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid CA certificate #${index + 1}: ${reason}`);
    }
    return block;
  });
}
function buildHttpsAgent(settings) {
  const customCas = parseCaCertificates(settings.caCert);
  const insecure = settings.allowInsecureTls === true;
  if (customCas.length === 0 && !insecure) {
    return void 0;
  }
  return new import_node_https.default.Agent({
    // "ca" replaces the default trust store, so the defaults are kept explicitly
    ca: customCas.length > 0 ? [...defaultCaCertificates(), ...customCas] : void 0,
    rejectUnauthorized: !insecure
  });
}
function tlsSettingsFromMessage(message) {
  if (!("caCert" in message) && !("allowInsecureTls" in message)) {
    return void 0;
  }
  return {
    caCert: typeof message.caCert === "string" ? message.caCert : void 0,
    allowInsecureTls: message.allowInsecureTls === true || message.allowInsecureTls === "true"
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildHttpsAgent,
  parseCaCertificates,
  tlsSettingsFromMessage
});
//# sourceMappingURL=tls-options.js.map
