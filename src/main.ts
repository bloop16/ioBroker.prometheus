/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as http from "node:http";

import * as utils from "@iobroker/adapter-core";

import { AGGREGATIONS, buildQuery, isValidMetricName, type Aggregation } from "./lib/query-builder";
import { MetricsRegistry, toMetricValue } from "./lib/exporter";
import { PrometheusClient, type PromSample } from "./lib/prometheus-client";
import {
    cleanAdminValue,
    collectFilters,
    normalizeSources,
    parseGroupBy,
    sanitizeIdSegment,
    validateUrl,
    type NormalizedSource,
    type RawSourceConfig,
} from "./lib/source-config";

const DEFAULT_REQUEST_TIMEOUT_SEC = 10;
/** Maximum number of entries returned to Admin UI dropdowns */
const MAX_DROPDOWN_ENTRIES = 2000;
/** Maximum random startup delay so many instances do not poll in lockstep */
const MAX_STARTUP_JITTER_MS = 5000;

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface PollingSource {
    source: NormalizedSource;
    client: PrometheusClient;
    inFlight: boolean;
}

class Prometheus extends utils.Adapter {
    private pollIntervals: ioBroker.Interval[] = [];
    private startupTimeouts: ioBroker.Timeout[] = [];
    private isShuttingDown = false;
    /** Health of each source (by target path), used for info.connection */
    private sourceHealth = new Map<string, boolean>();
    /** Current values of all states exported via the /metrics endpoint */
    private readonly registry = new MetricsRegistry();
    private exporterServer?: http.Server;
    /** Ids of the states currently exported */
    private readonly exportedIds = new Set<string>();
    /** Number of /metrics scrapes since adapter start */
    private scrapeCount = 0;
    private lastScrapeMs = 0;
    private systemLanguage = "en";

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "prometheus",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);

        if (this.config.exporterEnabled) {
            try {
                await this.startExporter();
            } catch (error) {
                this.log.error(`Failed to start the /metrics exporter: ${this.errorText(error)}`);
            }
        }

        const { sources, errors } = normalizeSources(this.config.sources, this.config.url);
        for (const error of errors) {
            this.log.warn(`Ignoring misconfigured source - ${error}`);
        }
        if (sources.length === 0) {
            this.log.info("No (valid) Prometheus sources configured. Please configure sources in the Admin UI.");
            return;
        }

        for (const source of sources) {
            try {
                await this.ensureSourceObjects(source);
            } catch (error) {
                this.log.error(`Failed to create objects for "${source.name}": ${this.errorText(error)}`);
                continue;
            }
            this.startPolling(source);
        }
    }

    /**
     * Creates the object tree for one source (all levels explicitly)
     *
     * @param source - The validated source configuration
     */
    private async ensureSourceObjects(source: NormalizedSource): Promise<void> {
        const segments = source.targetPath.split(".");

        // all intermediate levels as folders, the last level as channel
        for (let depth = 0; depth < segments.length; depth++) {
            const id = segments.slice(0, depth + 1).join(".");
            const isLast = depth === segments.length - 1;
            await this.setObjectNotExistsAsync(id, {
                type: isLast ? "channel" : "folder",
                common: { name: isLast ? source.name : segments[depth] },
                native: {},
            });
        }

        await this.setObjectNotExistsAsync(`${source.targetPath}.query`, {
            type: "state",
            common: { name: "Generated PromQL query", type: "string", role: "text", read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${source.targetPath}.lastUpdate`, {
            type: "state",
            common: { name: "Last successful update", type: "number", role: "date", read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${source.targetPath}.error`, {
            type: "state",
            common: { name: "Last error (empty if ok)", type: "string", role: "text", read: true, write: false },
            native: {},
        });
        if (source.groupBy.length === 0) {
            await this.setObjectNotExistsAsync(`${source.targetPath}.value`, {
                type: "state",
                common: { name: "Query result", type: "number", role: "value", read: true, write: false },
                native: {},
            });
        }

        await this.setState(`${source.targetPath}.query`, source.query, true);
    }

    /**
     * Starts the poll timer for one source with a random startup jitter
     *
     * @param source - The validated source configuration
     */
    private startPolling(source: NormalizedSource): void {
        const polling: PollingSource = {
            source,
            client: new PrometheusClient({
                baseUrl: source.url,
                timeoutMs: this.requestTimeoutMs(),
                username: this.config.username || undefined,
                password: this.config.password || undefined,
            }),
            inFlight: false,
        };

        const jitter = Math.floor(Math.random() * MAX_STARTUP_JITTER_MS);
        const startupTimeout = this.setTimeout(() => {
            void this.pollSource(polling);
            const interval = this.setInterval(() => void this.pollSource(polling), source.pollIntervalMs);
            if (interval) {
                this.pollIntervals.push(interval);
            }
        }, jitter);
        if (startupTimeout) {
            this.startupTimeouts.push(startupTimeout);
        }
        this.log.info(
            `Polling "${source.name}" every ${source.pollIntervalMs / 1000}s: ${source.query} -> ${source.targetPath}`,
        );
    }

    /**
     * Runs one poll cycle for one source; never throws
     *
     * @param polling - Poll state of the source
     */
    private async pollSource(polling: PollingSource): Promise<void> {
        if (this.isShuttingDown || polling.inFlight) {
            return;
        }
        polling.inFlight = true;
        const { source } = polling;
        try {
            const samples = await polling.client.instantQuery(source.query);
            // the server answered, so the connection is fine even if the
            // query itself yields no usable data
            this.setSourceHealth(source, true);
            try {
                await this.writeSamples(source, samples);
                await this.setState(`${source.targetPath}.error`, "", true);
                await this.setState(`${source.targetPath}.lastUpdate`, Date.now(), true);
            } catch (dataError) {
                const message = this.errorText(dataError);
                this.log.debug(`"${source.name}": ${message}`);
                await this.setState(`${source.targetPath}.error`, message, true);
            }
        } catch (error) {
            const message = this.errorText(error);
            this.log.warn(`Polling "${source.name}" failed: ${message}`);
            await this.setState(`${source.targetPath}.error`, message, true);
            this.setSourceHealth(source, false);
        } finally {
            polling.inFlight = false;
        }
    }

    /**
     * Writes the query result samples below the source's target path
     *
     * @param source - The validated source configuration
     * @param samples - Samples returned by the instant query
     */
    private async writeSamples(source: NormalizedSource, samples: PromSample[]): Promise<void> {
        if (source.groupBy.length === 0) {
            if (samples.length === 0) {
                throw new Error("Query returned no data");
            }
            if (samples.length > 1) {
                this.log.debug(
                    `"${source.name}" returned ${samples.length} series; writing the first one. ` +
                        "Add an aggregation or filters for a deterministic result.",
                );
            }
            await this.setState(`${source.targetPath}.value`, samples[0].value, true);
            return;
        }

        const usedKeys = new Set<string>();
        for (const sample of samples) {
            const key = source.groupBy.map(label => sanitizeIdSegment(sample.labels[label] ?? "unknown")).join("_");
            if (usedKeys.has(key)) {
                this.log.warn(
                    `"${source.name}": series key "${key}" appears more than once after sanitizing ` +
                        "the group-by label values; skipping the duplicate series",
                );
                continue;
            }
            usedKeys.add(key);
            const id = `${source.targetPath}.${key}`;
            await this.setObjectNotExistsAsync(id, {
                type: "state",
                common: {
                    name: source.groupBy.map(label => `${label}=${sample.labels[label] ?? "?"}`).join(", "),
                    type: "number",
                    role: "value",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setState(id, sample.value, true);
        }
        if (samples.length === 0) {
            this.log.debug(`"${source.name}" returned no series in this cycle`);
        }
    }

    /**
     * Tracks per-source health and aggregates it into info.connection
     *
     * @param source - The validated source configuration
     * @param healthy - Whether the last poll succeeded
     */
    private setSourceHealth(source: NormalizedSource, healthy: boolean): void {
        this.sourceHealth.set(source.targetPath, healthy);
        const allHealthy = [...this.sourceHealth.values()].every(value => value);
        void this.setState("info.connection", this.sourceHealth.size > 0 && allHealthy, true);
    }

    /**
     * Handles requests from the Admin UI (dynamic dropdowns and live preview).
     *
     * @param obj - The received ioBroker message
     */
    private onMessage(obj: ioBroker.Message): void {
        if (!obj?.command) {
            return;
        }
        void this.handleMessage(obj);
    }

    private async handleMessage(obj: ioBroker.Message): Promise<void> {
        const raw = (typeof obj.message === "object" && obj.message !== null ? obj.message : {}) as Record<
            string,
            string
        >;
        // values arriving via jsonData templates may be "null"/"undefined" strings
        const message = Object.fromEntries(
            Object.entries(raw).map(([key, value]) => [
                key,
                typeof value === "string" ? (cleanAdminValue(value) ?? "") : value,
            ]),
        ) as Record<string, string>;
        try {
            switch (obj.command) {
                case "testConnection": {
                    const client = this.clientForUrl(message.url, message.username, message.password);
                    if (!client) {
                        this.respond(obj, { error: "Invalid Prometheus URL (expected e.g. http://host:9090)" });
                        break;
                    }
                    await client.labelNames();
                    this.respond(obj, { result: "connected" });
                    break;
                }
                case "getMetricNames":
                    this.respond(obj, await this.listForDropdown(message, client => client.metricNames()));
                    break;
                case "getLabels": {
                    const options = await this.listForDropdown(message, client =>
                        client.labelNames(message.metric?.trim()),
                    );
                    if (message.withEmpty) {
                        // allows clearing a previously selected filter label
                        options.unshift({ label: "— no filter —", value: "" });
                    }
                    this.respond(obj, options);
                    break;
                }
                case "getLabelValues":
                    this.respond(
                        obj,
                        await this.listForDropdown(message, client =>
                            client.labelValues(message.label ?? "", message.metric?.trim()),
                        ),
                    );
                    break;
                case "previewQuery":
                    this.respond(obj, await this.previewQuery(message));
                    break;
                case "describeMetric":
                    this.respond(obj, await this.describeMetric(message));
                    break;
                default:
                    this.log.warn(`Unknown command: ${obj.command}`);
                    this.respond(obj, { error: `Unknown command: ${obj.command}` });
            }
        } catch (error) {
            const text = this.errorText(error);
            this.log.warn(`Command ${obj.command} failed: ${text}`);
            // Dropdown commands expect an array, the other commands expect an object
            if (obj.command === "previewQuery" || obj.command === "describeMetric") {
                this.respond(obj, { text: `Error: ${text}` });
            } else if (obj.command === "testConnection") {
                this.respond(obj, { error: text });
            } else {
                this.respond(obj, []);
            }
        }
    }

    private respond(obj: ioBroker.Message, result: unknown): void {
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }

    /**
     * Fetches a string list and converts it into selectSendTo options
     *
     * @param message - Payload of the Admin UI request
     * @param fetch - Function fetching the string list from the client
     */
    private async listForDropdown(
        message: Record<string, string>,
        fetch: (client: PrometheusClient) => Promise<string[]>,
    ): Promise<Array<{ label: string; value: string }>> {
        const client = this.clientForUrl(message.url);
        if (!client) {
            this.log.warn(
                "Cannot load values for the Admin UI: no valid Prometheus server URL configured. " +
                    "Enter and save the server URL first.",
            );
            return [];
        }
        const values = await fetch(client);
        return values
            .sort((a, b) => a.localeCompare(b))
            .slice(0, MAX_DROPDOWN_ENTRIES)
            .map(value => ({ label: value, value }));
    }

    /**
     * Renders a live overview of the selected metric (series count, labels
     * and their values) so the user can build filters without guessing.
     *
     * @param message - Payload of the Admin UI request
     */
    private async describeMetric(message: Record<string, string>): Promise<{ text: string }> {
        const metric = message.metric?.trim();
        const client = this.clientForUrl(message.url);
        if (!client || !metric || !isValidMetricName(metric)) {
            return { text: "" };
        }

        const samples = await client.instantQuery(metric);
        if (samples.length === 0) {
            return { text: `<b>${escapeHtml(metric)}</b>: no active series right now` };
        }

        const maxSeries = 500;
        const maxValues = 8;
        const labelValues = new Map<string, Set<string>>();
        for (const sample of samples.slice(0, maxSeries)) {
            for (const [label, value] of Object.entries(sample.labels)) {
                if (label === "__name__") {
                    continue;
                }
                let values = labelValues.get(label);
                if (!values) {
                    values = new Set<string>();
                    labelValues.set(label, values);
                }
                values.add(value);
            }
        }

        const rows = [...labelValues.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, values]) => {
                const list = [...values].slice(0, maxValues).map(escapeHtml).join(", ");
                const more = values.size > maxValues ? ` … (+${values.size - maxValues} more)` : "";
                return `<tr><td style="padding:2px 12px 2px 0;vertical-align:top"><b>${escapeHtml(label)}</b></td><td>${list}${more}</td></tr>`;
            })
            .join("");
        const truncated = samples.length > maxSeries ? ` (labels from first ${maxSeries})` : "";
        return {
            text:
                `<div style="font-size:0.9em"><b>${escapeHtml(metric)}</b>: ${samples.length} series${truncated}, ` +
                `current value e.g. ${samples[0].value}<table style="margin-top:4px">${rows}</table></div>`,
        };
    }

    /**
     * Builds the PromQL query from the (possibly unsaved) row data and runs it once
     *
     * @param message - Payload of the Admin UI request
     */
    private async previewQuery(message: Record<string, string>): Promise<{ text: string }> {
        const metric = message.metric?.trim();
        const client = this.clientForUrl(message.url);
        if (!client || !metric) {
            return { text: "Configure URL and metric first" };
        }

        const aggregation = (
            AGGREGATIONS.includes(message.aggregation as Aggregation) ? message.aggregation : "none"
        ) as Aggregation;
        const raw = message as RawSourceConfig;
        const query = buildQuery({
            metric,
            filters: collectFilters(raw),
            aggregation,
            groupBy: aggregation === "none" ? [] : parseGroupBy(message.groupBy),
        });

        const samples = await client.instantQuery(query);
        const values =
            samples.length === 0
                ? "no data"
                : samples
                      .slice(0, 10)
                      .map(sample => {
                          const labels = Object.entries(sample.labels)
                              .map(([key, value]) => `${key}=${value}`)
                              .join(",");
                          return labels ? `{${labels}}: ${sample.value}` : String(sample.value);
                      })
                      .join(" | ");
        const suffix = samples.length > 10 ? ` (+${samples.length - 10} more)` : "";
        return { text: `${query}  =>  ${values}${suffix}` };
    }

    /**
     * Creates a client for Admin UI requests. Falls back to the saved server
     * configuration when the message does not carry its own values.
     *
     * @param url - Prometheus base URL from the Admin UI, if provided
     * @param username - Basic auth user name override, if provided
     * @param password - Basic auth password override, if provided
     */
    private clientForUrl(url: string | undefined, username?: string, password?: string): PrometheusClient | undefined {
        // jsonData patterns may arrive unresolved (older Admin) or as the
        // string "undefined" when the field is still empty - ignore those
        const fromMessage = url?.trim();
        const usable =
            fromMessage && !fromMessage.includes("${") && fromMessage !== "undefined" && fromMessage !== "null"
                ? fromMessage
                : undefined;
        const validated = validateUrl(usable) ?? validateUrl(this.config.url);
        if (!validated) {
            return undefined;
        }
        const user = username ?? (this.config.username || undefined);
        return new PrometheusClient({
            baseUrl: validated,
            timeoutMs: this.requestTimeoutMs(),
            username: user || undefined,
            password: user ? (password ?? this.config.password ?? "") : undefined,
        });
    }

    /** Starts tracking all custom-enabled states and the /metrics HTTP server */
    private async startExporter(): Promise<void> {
        this.systemLanguage = (await this.getForeignObjectAsync("system.config"))?.common?.language || "en";

        const view = await this.getObjectViewAsync("system", "custom", {});
        for (const row of view.rows) {
            const custom = row.value?.[this.namespace] as { enabled?: boolean; metricName?: string } | undefined;
            if (custom?.enabled) {
                await this.trackState(row.id, custom);
            }
        }
        await this.subscribeForeignObjectsAsync("*");

        await this.setObjectNotExistsAsync("info.lastScrape", {
            type: "state",
            common: {
                name: "Time of the last Prometheus scrape",
                type: "number",
                role: "date",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.scrapeCount", {
            type: "state",
            common: { name: "Scrapes since adapter start", type: "number", role: "value", read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.scrapeInterval", {
            type: "state",
            common: {
                name: "Seconds between the last two scrapes",
                type: "number",
                role: "value.interval",
                unit: "s",
                read: true,
                write: false,
            },
            native: {},
        });

        const port = this.exporterPort();
        const bind = this.config.bind?.trim() || "0.0.0.0";
        this.exporterServer = http.createServer((req, res) => {
            if (req.url?.split("?")[0] === "/metrics") {
                this.recordScrape();
                res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
                res.end(this.registry.render() + this.selfMetrics());
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not found. Metrics are available at /metrics\n");
            }
        });
        this.exporterServer.on("error", error => {
            this.log.error(`Exporter HTTP server error: ${this.errorText(error)}`);
        });
        await new Promise<void>((resolve, reject) => {
            this.exporterServer?.once("error", reject);
            this.exporterServer?.listen(port, bind, () => resolve());
        });
        this.log.info(`Exporter listening on http://${bind}:${port}/metrics (${this.registry.size} states)`);
    }

    /**
     * Starts exporting one state
     *
     * @param id - The foreign state id
     * @param custom - The per-datapoint settings of this adapter instance
     * @param custom.metricName - Optional custom metric name for this state
     */
    private async trackState(id: string, custom: { metricName?: string }): Promise<void> {
        try {
            const obj = await this.getForeignObjectAsync(id);
            if (obj?.type !== "state") {
                return;
            }
            const commonType = obj.common?.type;
            if (commonType && !["number", "boolean", "mixed"].includes(commonType)) {
                this.log.warn(
                    `Cannot export state ${id}: type "${commonType}" is not numeric (Prometheus stores numbers only)`,
                );
                return;
            }
            const state = await this.getForeignStateAsync(id);
            this.registry.set(id, {
                name: this.stateName(obj) || id,
                value: toMetricValue(state?.val),
                metricName: custom.metricName?.trim() || undefined,
            });
            if (!this.exportedIds.has(id)) {
                this.exportedIds.add(id);
                await this.subscribeForeignStatesAsync(id);
                this.log.debug(`Exporting state ${id}`);
            }
        } catch (error) {
            this.log.warn(`Cannot export state ${id}: ${this.errorText(error)}`);
        }
    }

    /**
     * Stops exporting one state
     *
     * @param id - The foreign state id
     */
    private async untrackState(id: string): Promise<void> {
        if (this.exportedIds.delete(id)) {
            this.registry.remove(id);
            await this.unsubscribeForeignStatesAsync(id);
            this.log.debug(`No longer exporting state ${id}`);
        }
    }

    /**
     * Resolves the display name of an object in the system language
     *
     * @param obj - The ioBroker object
     */
    private stateName(obj: ioBroker.Object): string {
        const name = obj.common?.name;
        if (typeof name === "string") {
            return name;
        }
        if (name && typeof name === "object") {
            const translated = (name as Record<string, string>)[this.systemLanguage] ?? name.en;
            return translated ?? Object.values(name)[0] ?? "";
        }
        return "";
    }

    /**
     * Tracks value changes of exported states
     *
     * @param id - State id
     * @param state - New state value or null/undefined when deleted
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!this.exportedIds.has(id)) {
            return;
        }
        this.registry.updateValue(id, state ? toMetricValue(state.val) : undefined);
    }

    /**
     * Reacts to per-datapoint custom settings changes while the exporter runs
     *
     * @param id - Object id
     * @param obj - Changed object or null/undefined when deleted
     */
    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (!this.config.exporterEnabled) {
            return;
        }
        const custom = obj?.common?.custom?.[this.namespace] as { enabled?: boolean; metricName?: string } | undefined;
        if (custom?.enabled) {
            void this.trackState(id, custom);
        } else {
            void this.untrackState(id);
        }
    }

    /** Tracks one /metrics scrape and mirrors the statistics into info states */
    private recordScrape(): void {
        const now = Date.now();
        this.scrapeCount++;
        const intervalSec = this.lastScrapeMs > 0 ? Math.round((now - this.lastScrapeMs) / 1000) : null;
        this.lastScrapeMs = now;
        void this.setState("info.lastScrape", now, true);
        void this.setState("info.scrapeCount", this.scrapeCount, true);
        if (intervalSec !== null) {
            void this.setState("info.scrapeInterval", intervalSec, true);
        }
    }

    /** Metrics about the exporter itself, appended to every /metrics response */
    private selfMetrics(): string {
        return (
            "# HELP iobroker_exporter_scrapes_total Scrapes since adapter start\n" +
            "# TYPE iobroker_exporter_scrapes_total counter\n" +
            `iobroker_exporter_scrapes_total ${this.scrapeCount}\n` +
            "# HELP iobroker_exporter_exported_states Number of exported states\n" +
            "# TYPE iobroker_exporter_exported_states gauge\n" +
            `iobroker_exporter_exported_states ${this.registry.size}\n`
        );
    }

    private exporterPort(): number {
        const parsed = Number(this.config.port);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 9126;
    }

    private requestTimeoutMs(): number {
        const parsed = Number(this.config.requestTimeout);
        const seconds = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 300) : DEFAULT_REQUEST_TIMEOUT_SEC;
        return Math.floor(seconds * 1000);
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
        this.isShuttingDown = true;
        try {
            for (const timeout of this.startupTimeouts) {
                this.clearTimeout(timeout);
            }
            this.startupTimeouts = [];
            for (const interval of this.pollIntervals) {
                this.clearInterval(interval);
            }
            this.pollIntervals = [];
            if (this.exporterServer) {
                this.exporterServer.close();
                this.exporterServer = undefined;
            }
            this.registry.clear();
            this.exportedIds.clear();
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${this.errorText(error)}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Prometheus(options);
} else {
    // otherwise start the instance directly
    (() => new Prometheus())();
}
