/**
 * Polls an Alertmanager and mirrors alerts and silences into states below
 * the "alertmanager" channel.
 */

import { AlertmanagerClient, type AlertEntry, type SilenceEntry } from "./alertmanager-client";
import { normalizeAlertmanagerConfig, type NormalizedAlertmanagerConfig } from "./alertmanager-config";
import { groupAlerts, type AlertGroup } from "./alertmanager-groups";
import { summarizeAlerts, summarizeSilences } from "./alertmanager-summary";
import { PrometheusClient, type AlertRule } from "./prometheus-client";
import { validateUrl } from "./source-config";

/** Root of the object tree; everything below it can be removed at once */
export const ALERTMANAGER_CHANNEL = "alertmanager";

const ALERT_FOLDER = `${ALERTMANAGER_CHANNEL}.alerts`;

/** Objects of earlier development versions, removed on start */
const LEGACY_OBJECTS = [`${ALERTMANAGER_CHANNEL}.info`, `${ALERT_FOLDER}.byName`, `${ALERT_FOLDER}.countBySeverity`];

/** Adapter functions used by the poller */
export type PollerHost = Pick<
    ioBroker.Adapter,
    | "namespace"
    | "log"
    | "setObjectNotExistsAsync"
    | "extendObjectAsync"
    | "getObjectAsync"
    | "delObjectAsync"
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
    /** Returns the firing alerts that are silenced or inhibited */
    suppressedAlerts(matchers: string[]): Promise<AlertEntry[]>;
    /** Returns the active silences */
    activeSilences(): Promise<SilenceEntry[]>;
}

/** Source of the alert rules; lets alerts exist as folders before they ever fire */
export interface AlertRuleSource {
    /** Returns the known alert rules */
    alertRules(): Promise<AlertRule[]>;
}

type StateSpec = Pick<ioBroker.StateCommon, "name" | "type" | "role">;

const CONTAINERS: Array<{ id: string; type: "channel" | "folder"; name: string }> = [
    { id: ALERTMANAGER_CHANNEL, type: "channel", name: "Alertmanager" },
    { id: ALERT_FOLDER, type: "folder", name: "Alerts" },
    { id: `${ALERTMANAGER_CHANNEL}.silences`, type: "channel", name: "Active silences" },
];

const STATES: Record<string, StateSpec> = {
    error: { name: "Last error (empty if ok)", type: "string", role: "text" },
    lastUpdate: { name: "Last successful update", type: "number", role: "date" },
    "alerts.count": { name: "Active alerts (not silenced)", type: "number", role: "value" },
    "alerts.json": { name: "Active alerts as JSON", type: "string", role: "json" },
    "silences.count": { name: "Active silences", type: "number", role: "value" },
    "silences.json": { name: "Active silences as JSON", type: "string", role: "json" },
};

const ALERT_STATES: Record<string, StateSpec> = {
    active: { name: "Alert is firing", type: "boolean", role: "indicator.alarm" },
    silenced: { name: "Alert is firing but silenced or inhibited", type: "boolean", role: "indicator" },
    count: { name: "Firing instances", type: "number", role: "value" },
    severity: { name: "Severity", type: "string", role: "text" },
    summary: { name: "Summary of the newest instance", type: "string", role: "text" },
    startsAt: { name: "Start of the newest instance", type: "number", role: "date" },
    json: { name: "Firing instances as JSON", type: "string", role: "json" },
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
    /** Alerts with a folder, so they can be reset once they resolve */
    private knownAlerts = new Set<string>();

    /**
     * @param host - The adapter instance
     * @param source - Data source, usually an AlertmanagerClient
     * @param config - The validated settings
     * @param onHealth - Called with the reachability after each poll
     * @param rules - Optional source of the alert rules
     */
    public constructor(
        private readonly host: PollerHost,
        private readonly source: AlertmanagerSource,
        private readonly config: NormalizedAlertmanagerConfig,
        private readonly onHealth: (healthy: boolean) => void,
        private readonly rules?: AlertRuleSource,
    ) {}

    /** Creates the objects, polls once and starts the timer */
    public async start(): Promise<void> {
        await this.removeLegacyObjects();
        await this.ensureObjects();
        this.knownAlerts = await this.loadAlertKeys();
        // folders of a previous run may lack states added by an update
        for (const key of this.knownAlerts) {
            await this.ensureAlertFolder(key, key);
        }
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
            const { alerts, suppressed, silences } = await this.fetch();
            if (this.stopped) {
                return;
            }
            // the server answered, so the connection is fine even if writing fails below
            await this.report(true, "");
            await this.writeSummary(alerts, suppressed, silences);
            await this.write("lastUpdate", Date.now());
        } catch (error) {
            await this.fail(error);
        }
    }

    private async fetch(): Promise<{
        alerts: AlertEntry[];
        suppressed: AlertEntry[];
        silences: SilenceEntry[];
    }> {
        try {
            const [alerts, suppressed, silences] = await Promise.all([
                this.source.activeAlerts(this.config.matchers),
                this.source.suppressedAlerts(this.config.matchers),
                this.source.activeSilences(),
            ]);
            return { alerts, suppressed, silences };
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
        await this.write("error", error);
    }

    private async writeSummary(
        alerts: AlertEntry[],
        suppressed: AlertEntry[],
        silences: SilenceEntry[],
    ): Promise<void> {
        const alertSummary = summarizeAlerts(alerts);
        const silenceSummary = summarizeSilences(silences);

        await this.write("alerts.count", alertSummary.count);
        await this.write("alerts.json", JSON.stringify(alertSummary.entries));
        await this.write("silences.count", silenceSummary.count);
        await this.write("silences.json", JSON.stringify(silenceSummary.entries));
        await this.writeGroups(groupAlerts(alerts, await this.fetchRules(), suppressed));
    }

    /** Rules only add folders, so a failure must not affect the alerts */
    private async fetchRules(): Promise<AlertRule[]> {
        try {
            return (await this.rules?.alertRules()) ?? [];
        } catch (error) {
            this.host.log.debug(`Cannot read the alert rules: ${errorText(error)}`);
            return [];
        }
    }

    private async writeGroups(groups: AlertGroup[]): Promise<void> {
        for (const group of groups) {
            if (!this.knownAlerts.has(group.key)) {
                await this.ensureAlertFolder(group.key, group.name);
                this.knownAlerts = new Set([...this.knownAlerts, group.key]);
            }
            await this.writeAlert(group.key, {
                active: group.active,
                silenced: group.silenced,
                count: group.count,
                severity: group.severity,
                summary: group.summary,
                startsAt: group.startsAt,
                json: JSON.stringify(group.entries),
            });
        }
        const current = new Set(groups.map(group => group.key));
        for (const key of [...this.knownAlerts].filter(known => !current.has(known))) {
            // the severity stays, as it still describes the alert
            await this.writeAlert(key, {
                active: false,
                silenced: false,
                count: 0,
                summary: "",
                startsAt: null,
                json: "[]",
            });
        }
    }

    private async writeAlert(key: string, values: Record<string, ioBroker.StateValue>): Promise<void> {
        for (const [state, value] of Object.entries(values)) {
            await this.host.setStateChangedAsync(`${ALERT_FOLDER}.${key}.${state}`, value, true);
        }
    }

    private async ensureAlertFolder(key: string, name: string): Promise<void> {
        const id = `${ALERT_FOLDER}.${key}`;
        await this.host.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
        for (const [state, spec] of Object.entries(ALERT_STATES)) {
            await this.ensureState(`${id}.${state}`, spec);
        }
    }

    private async write(state: string, value: ioBroker.StateValue): Promise<void> {
        await this.host.setStateChangedAsync(`${ALERTMANAGER_CHANNEL}.${state}`, value, true);
    }

    private async ensureObjects(): Promise<void> {
        for (const { id, type, name } of CONTAINERS) {
            // extend, as containers of earlier versions may have another type
            await this.host.extendObjectAsync(id, { type, common: { name }, native: {} });
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

    private async removeLegacyObjects(): Promise<void> {
        for (const id of LEGACY_OBJECTS) {
            if (await this.host.getObjectAsync(id)) {
                await this.host.delObjectAsync(id, { recursive: true });
            }
        }
    }

    private async loadAlertKeys(): Promise<Set<string>> {
        const prefix = `${this.host.namespace}.${ALERT_FOLDER}.`;
        const objects = await this.host.getForeignObjectsAsync(`${prefix}*`, "channel");
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
    const prometheusUrl = validateUrl(settings.url);
    // with filters the rules would add folders for alerts that can never show up
    const rules =
        prometheusUrl && config.matchers.length === 0
            ? new PrometheusClient({
                  baseUrl: prometheusUrl,
                  timeoutMs,
                  username: settings.username || undefined,
                  password: settings.password || undefined,
              })
            : undefined;
    const poller = new AlertmanagerPoller(host, client, config, onHealth, rules);
    await poller.start();
    // only the origin: the URL may carry credentials
    host.log.info(`Polling Alertmanager every ${config.pollIntervalMs / 1000}s: ${new URL(config.url).origin}`);
    return poller;
}
