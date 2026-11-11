/**
 * TLS settings for HTTPS connections to Prometheus servers.
 *
 * Supports servers whose certificate is signed by an internal CA (the CA is
 * added on top of Node's default root certificates) and, as a last resort,
 * disabling certificate verification entirely.
 */

import { X509Certificate } from "node:crypto";
import https from "node:https";
import tls from "node:tls";

/** User-facing TLS settings */
export interface TlsSettings {
    /** Optional PEM text with one or more CA certificates */
    caCert?: string;
    /** Skips certificate verification (insecure) */
    allowInsecureTls?: boolean;
}

/**
 * The trust store Node uses by default. Since Node 22.15 this includes
 * NODE_EXTRA_CA_CERTS and, with --use-system-ca, the system store.
 */
function defaultCaCertificates(): readonly string[] {
    return typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : tls.rootCertificates;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Extracts and validates all PEM certificate blocks from user input
 *
 * @param raw - PEM text as entered in the Admin UI
 * @returns The normalized certificate blocks, empty when the input is empty
 */
export function parseCaCertificates(raw: string | undefined): string[] {
    const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) {
        return [];
    }
    const blocks = text.match(PEM_BLOCK) ?? [];
    if (blocks.length === 0) {
        throw new Error("CA certificate contains no PEM certificate (expected -----BEGIN CERTIFICATE-----)");
    }
    return blocks.map((block, index) => {
        try {
            new X509Certificate(block);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid CA certificate #${index + 1}: ${reason}`);
        }
        return block;
    });
}

/**
 * Builds an HTTPS agent for the given TLS settings
 *
 * @param settings - TLS settings from the adapter configuration
 * @returns An agent, or undefined when the Node defaults apply
 */
export function buildHttpsAgent(settings: TlsSettings): https.Agent | undefined {
    const customCas = parseCaCertificates(settings.caCert);
    const insecure = settings.allowInsecureTls === true;
    if (customCas.length === 0 && !insecure) {
        return undefined;
    }
    return new https.Agent({
        // "ca" replaces the default trust store, so the defaults are kept explicitly
        ca: customCas.length > 0 ? [...defaultCaCertificates(), ...customCas] : undefined,
        rejectUnauthorized: !insecure,
    });
}

/**
 * Reads TLS settings sent by the Admin UI (unsaved form values)
 *
 * @param message - Raw sendTo payload
 * @returns The settings, or undefined when the message carries none
 */
export function tlsSettingsFromMessage(message: Record<string, unknown>): TlsSettings | undefined {
    if (!("caCert" in message) && !("allowInsecureTls" in message)) {
        return undefined;
    }
    return {
        caCert: typeof message.caCert === "string" ? message.caCert : undefined,
        allowInsecureTls: message.allowInsecureTls === true || message.allowInsecureTls === "true",
    };
}
