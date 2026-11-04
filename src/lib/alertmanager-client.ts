/**
 * Thin client for the Alertmanager HTTP API (v2).
 *
 * Only the read endpoints needed by this adapter are implemented:
 * - /api/v2/alerts      (firing alerts)
 * - /api/v2/silences    (silences)
 * - /api/v2/status      (connection test; carries the full server config, of
 *                        which only the version is read so no secrets leak)
 *
 * Unlike Prometheus, Alertmanager returns the payload without an envelope.
 *
 * https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml
 */

import axios from "axios";
import type { HttpGet } from "./prometheus-client";
import { validateUrl } from "./source-config";

/** Connection options for one Alertmanager */
export interface AlertmanagerClientOptions {
    /** Base URL of the Alertmanager without trailing slash */
    baseUrl: string;
    /** HTTP request timeout in milliseconds */
    timeoutMs: number;
    /** Optional basic auth user name */
    username?: string;
    /** Optional basic auth password */
    password?: string;
}

/** One firing alert */
export interface AlertEntry {
    /** Stable identifier of the alert's label set */
    fingerprint: string;
    /** Labels of the alert */
    labels: Record<string, string>;
    /** Annotations of the alert */
    annotations: Record<string, string>;
    /** Start of the alert as ISO timestamp */
    startsAt: string;
}

/** One active silence */
export interface SilenceEntry {
    /** Id of the silence */
    id: string;
    /** Rendered matchers, e.g. alertname="Disk" */
    matchers: string[];
    /** Author of the silence */
    createdBy: string;
    /** Comment of the silence */
    comment: string;
    /** Start of the silence as ISO timestamp */
    startsAt: string;
    /** End of the silence as ISO timestamp */
    endsAt: string;
}

interface RawMatcher {
    name?: unknown;
    value?: unknown;
    isRegex?: unknown;
    isEqual?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function stringRecord(value: unknown): Record<string, string> {
    if (!isRecord(value)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
}

function renderMatcher(matcher: RawMatcher): string {
    const operator = `${matcher.isEqual === false ? "!" : "="}${matcher.isRegex === true ? "~" : ""}`;
    const normalized = operator === "!" ? "!=" : operator;
    return `${asString(matcher.name)}${normalized}"${asString(matcher.value)}"`;
}

function toAlert(raw: unknown): AlertEntry | undefined {
    if (!isRecord(raw) || typeof raw.fingerprint !== "string" || !isRecord(raw.labels)) {
        return undefined;
    }
    return {
        fingerprint: raw.fingerprint,
        labels: stringRecord(raw.labels),
        annotations: stringRecord(raw.annotations),
        startsAt: asString(raw.startsAt),
    };
}

function toActiveSilence(raw: unknown): SilenceEntry | undefined {
    if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.status) || raw.status.state !== "active") {
        return undefined;
    }
    return {
        id: raw.id,
        matchers: Array.isArray(raw.matchers) ? raw.matchers.filter(isRecord).map(renderMatcher) : [],
        createdBy: asString(raw.createdBy),
        comment: asString(raw.comment),
        startsAt: asString(raw.startsAt),
        endsAt: asString(raw.endsAt),
    };
}

/** Client for the read endpoints of one Alertmanager */
export class AlertmanagerClient {
    private readonly options: AlertmanagerClientOptions;
    private readonly httpGet: HttpGet;

    /**
     * @param options - Connection options for the Alertmanager
     * @param httpGet - Optional HTTP implementation override (used by unit tests)
     */
    public constructor(options: AlertmanagerClientOptions, httpGet?: HttpGet) {
        this.options = options;
        this.httpGet = httpGet ?? ((url, requestOptions) => axios.get(url, requestOptions));
    }

    /** Returns the firing alerts that are neither silenced nor inhibited */
    public async activeAlerts(): Promise<AlertEntry[]> {
        const data = await this.list("/api/v2/alerts", {
            active: "true",
            silenced: "false",
            inhibited: "false",
            // alerts not yet processed may still turn out to be silenced
            unprocessed: "false",
        });
        return data.map(toAlert).filter(entry => entry !== undefined);
    }

    /** Returns the firing alerts that are silenced or inhibited */
    public async suppressedAlerts(): Promise<AlertEntry[]> {
        const data = await this.list("/api/v2/alerts", {
            active: "false",
            silenced: "true",
            inhibited: "true",
            unprocessed: "false",
        });
        return data.map(toAlert).filter(entry => entry !== undefined);
    }

    /** Returns the active silences; older servers cannot filter them, so this is done here */
    public async activeSilences(): Promise<SilenceEntry[]> {
        const data = await this.list("/api/v2/silences");
        return data.map(toActiveSilence).filter(entry => entry !== undefined);
    }

    /** Returns the server version; rejects if the server is no Alertmanager */
    public async version(): Promise<string> {
        const data = await this.request("/api/v2/status");
        if (!isRecord(data) || !isRecord(data.versionInfo)) {
            throw new Error("Unexpected response from /api/v2/status: not an Alertmanager");
        }
        return asString(data.versionInfo.version) || "unknown";
    }

    private async list(path: string, params?: Record<string, string>): Promise<unknown[]> {
        const data = await this.request(path, params);
        if (!Array.isArray(data)) {
            throw new Error(`Unexpected response from ${path}: expected an array`);
        }
        return data;
    }

    private async request(path: string, params?: Record<string, string>): Promise<unknown> {
        const response = await this.httpGet(`${this.options.baseUrl}${path}`, {
            params,
            timeout: this.options.timeoutMs,
            auth: this.options.username
                ? { username: this.options.username, password: this.options.password ?? "" }
                : undefined,
        });
        return response.data;
    }
}

/**
 * Tests a connection with the (possibly unsaved) values of the Admin UI
 *
 * @param options - Connection options; the URL is validated here
 * @returns The response for the Admin UI
 */
export async function testAlertmanager(
    options: Omit<AlertmanagerClientOptions, "baseUrl"> & { url: string | undefined },
): Promise<{ result: string } | { error: string }> {
    const baseUrl = validateUrl(options.url);
    if (!baseUrl) {
        return { error: "Invalid Alertmanager URL (expected e.g. http://host:9093)" };
    }
    const version = await new AlertmanagerClient({ ...options, baseUrl }).version();
    return { result: `Connected to Alertmanager ${version}` };
}
