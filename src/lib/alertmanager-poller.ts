/**
 * Polls an Alertmanager and mirrors alerts and silences into states below
 * the "alertmanager" channel.
 */

import { AlertmanagerClient, type AlertEntry, type SilenceEntry } from "./alertmanager-client";
import { normalizeAlertmanagerConfig, type NormalizedAlertmanagerConfig } from "./alertmanager-config";
import { summarizeAlerts, summarizeSilences } from "./alertmanager-summary";

/** Root of the object tree; everything below it can be removed at once */
export const ALERTMANAGER_CHANNEL = "alertmanager";

const SEVERITY_FOLDER = `${ALERTMANAGER_CHANNEL}.alerts.countBySeverity`;

/** Adapter functions used by the poller */
export type PollerHost = Pick<
    ioBroker.Adapter,
    | "namespace"
    | "log"
    | "setObjectNotExistsAsync"
    | "getForeignObjectsAsync"
    | "setStateAsync"
    | "setStateChangedAsync"
    | "setInterval"
    | "clearInterval"
>;

/** Data source of the poller */
export interface AlertmanagerSource {
    /** Returns the firing alerts matching all matchers */
    activeAlerts(matchers: string[]): Promise<AlertEntry[]>;
    /** Returns the active silences */
    activeSilences(): Promise<SilenceEntry[]>;
}

type StateSpec = Pick<ioBroker.StateCommon, "name" | "type" | "role">;

const CONTAINERS: Array<{ id: string; type: "channel" | "folder"; name: string }> = [
    { id: ALERTMANAGER_CHANNEL, type: "channel", name: "Alertmanager" },
    { id: `${ALERTMANAGER_CHANNEL}.info`, type: "channel", name: "Information" },
    { id: `${ALERTMANAGER_CHANNEL}.alerts`, type: "channel", name: "Active alerts" },
    { id: SEVERITY_FOLDER, type: "folder", name: "Active alerts by severity" },
    { id: `${ALERTMANAGER_CHANNEL}.silences`, type: "channel", name: "Active silences" },
];

const STATES: Record<string, StateSpec> = {
    "info.connection": { name: "Alertmanager reachable", type: "boolean", role: "indicator.reachable" },
    error: { name: "Last error (empty if ok)", type: "string", role: "text" },
    lastUpdate: { name: "Last successful update", type: "number", role: "date" },
    "alerts.count": { name: "Active alerts (not silenced)", type: "number", role: "value" },
    "alerts.json": { name: "Active alerts as JSON", type: "string", role: "json" },
    "silences.count": { name: "Active silences", type: "number", role: "value" },
    "silences.json": { name: "Active silences as JSON", type: "string", role: "json" },
};

/** Marks a failure of the server, as opposed to one writing to ioBroker */
class RequestError extends Error {}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Periodically writes the state of one Alertmanager to ioBroker */
export class AlertmanagerPoller {
    private interval: ioBroker.Interval | undefined;
    private running: Promise<void> = Promise.resolve();
    private inFlight = false;
    private stopped = false;
    /** Severities with a state, so they can be reset once their alerts resolve */
    private knownSeverities = new Set<string>();

    /**
     * @param host - The adapter instance
     * @param source - Data source, usually an AlertmanagerClient
     * @param config - The validated settings
     * @param onHealth - Called with the reachability after each poll
     */
    public constructor(
        private readonly host: PollerHost,
        private readonly source: AlertmanagerSource,
        private readonly config: NormalizedAlertmanagerConfig,
        private readonly onHealth: (healthy: boolean) => void,
    ) {}

    /** Creates the objects, polls once and starts the timer */
    public async start(): Promise<void> {
        await this.ensureObjects();
        this.knownSeverities = await this.loadSeverities();
        this.interval = this.host.setInterval(() => this.trigger(), this.config.pollIntervalMs) ?? undefined;
        this.trigger();
    }

    /** Stops polling; a poll already running finishes without further effect */
    public stop(): void {
        this.stopped = true;
        if (this.interval) {
            this.host.clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    /** Resolves once the current poll has finished */
    public idle(): Promise<void> {
        return this.running;
    }

    private trigger(): void {
        if (this.stopped || this.inFlight) {
            return;
        }
        this.inFlight = true;
        this.running = this.poll().finally(() => {
            this.inFlight = false;
        });
    }

    /** Runs one poll cycle; never rejects */
    private async poll(): Promise<void> {
        try {
            const [alerts, silences] = await this.fetch();
            if (this.stopped) {
                return;
            }
            // the server answered, so the connection is fine even if writing fails below
            await this.report(true, "");
            await this.writeSummary(alerts, silences);
            await this.write("lastUpdate", Date.now());
        } catch (error) {
            await this.fail(error);
        }
    }

    private async fetch(): Promise<[AlertEntry[], SilenceEntry[]]> {
        try {
            return await Promise.all([this.source.activeAlerts(this.config.matchers), this.source.activeSilences()]);
        } catch (error) {
            throw new RequestError(errorText(error));
        }
    }

    private async fail(error: unknown): Promise<void> {
        // keep the last counts: writing 0 here would look like "no alerts"
        const message = errorText(error);
        this.host.log.warn(`Polling Alertmanager failed: ${message}`);
        try {
            await this.report(!(error instanceof RequestError), message);
        } catch (reportError) {
            this.host.log.warn(`Cannot write Alertmanager status: ${errorText(reportError)}`);
        }
    }

    private async report(healthy: boolean, error: string): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.onHealth(healthy);
        await this.write("info.connection", healthy);
        await this.write("error", error);
    }

    private async writeSummary(alerts: AlertEntry[], silences: SilenceEntry[]): Promise<void> {
        const alertSummary = summarizeAlerts(alerts);
        const silenceSummary = summarizeSilences(silences);

        await this.writeSeverities(alertSummary.bySeverity);
        await this.write("alerts.count", alertSummary.count);
        await this.write("alerts.json", JSON.stringify(alertSummary.entries));
        await this.write("silences.count", silenceSummary.count);
        await this.write("silences.json", JSON.stringify(silenceSummary.entries));
    }

    private async writeSeverities(bySeverity: Record<string, number>): Promise<void> {
        for (const severity of Object.keys(bySeverity)) {
            if (!this.knownSeverities.has(severity)) {
                await this.ensureState(`${SEVERITY_FOLDER}.${severity}`, {
                    name: `Active alerts with severity ${severity}`,
                    type: "number",
                    role: "value",
                });
                this.knownSeverities = new Set([...this.knownSeverities, severity]);
            }
        }
        for (const severity of this.knownSeverities) {
            await this.host.setStateChangedAsync(`${SEVERITY_FOLDER}.${severity}`, bySeverity[severity] ?? 0, true);
        }
    }

    private async write(state: string, value: ioBroker.StateValue): Promise<void> {
        await this.host.setStateChangedAsync(`${ALERTMANAGER_CHANNEL}.${state}`, value, true);
    }

    private async ensureObjects(): Promise<void> {
        for (const { id, type, name } of CONTAINERS) {
            await this.host.setObjectNotExistsAsync(id, { type, common: { name }, native: {} });
        }
        for (const [state, spec] of Object.entries(STATES)) {
            await this.ensureState(`${ALERTMANAGER_CHANNEL}.${state}`, spec);
        }
    }

    private async ensureState(id: string, spec: StateSpec): Promise<void> {
        await this.host.setObjectNotExistsAsync(id, {
            type: "state",
            common: { ...spec, read: true, write: false },
            native: {},
        });
    }

    private async loadSeverities(): Promise<Set<string>> {
        const prefix = `${this.host.namespace}.${SEVERITY_FOLDER}.`;
        const objects = await this.host.getForeignObjectsAsync(`${prefix}*`, "state");
        return new Set(Object.keys(objects).map(id => id.slice(prefix.length)));
    }
}

/**
 * Creates and starts the poller from the adapter configuration
 *
 * @param host - The adapter instance
 * @param settings - The adapter configuration
 * @param timeoutMs - HTTP request timeout in milliseconds
 * @param onHealth - Called with the reachability after each poll
 * @returns The running poller, or undefined if the configuration is unusable
 */
export async function startAlertmanagerPoller(
    host: PollerHost,
    settings: ioBroker.AdapterConfig,
    timeoutMs: number,
    onHealth: (healthy: boolean) => void,
): Promise<AlertmanagerPoller | undefined> {
    const { config, errors } = normalizeAlertmanagerConfig({
        url: settings.alertmanagerUrl,
        pollInterval: settings.alertmanagerPollInterval,
        filters: settings.alertmanagerFilters,
    });
    for (const error of errors) {
        host.log.warn(`Alertmanager: ${error}`);
    }
    if (!config) {
        return undefined;
    }

    const client = new AlertmanagerClient({
        baseUrl: config.url,
        timeoutMs,
        username: settings.alertmanagerUsername || undefined,
        password: settings.alertmanagerPassword || undefined,
    });
    const poller = new AlertmanagerPoller(host, client, config, onHealth);
    await poller.start();
    // only the origin: the URL may carry credentials
    host.log.info(`Polling Alertmanager every ${config.pollIntervalMs / 1000}s: ${new URL(config.url).origin}`);
    return poller;
}
