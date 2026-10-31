/**
 * Groups alerts by name for the per-alert folders below alerts.byName.
 *
 * One rule usually fires once per instance, so a name is the stable unit a
 * dashboard can bind to, unlike fingerprints that come and go with each alert.
 */

import type { AlertEntry } from "./alertmanager-client";
import { summarizeAlerts, type AlertJsonEntry } from "./alertmanager-summary";
import type { AlertRule } from "./prometheus-client";
import { sanitizeIdSegment } from "./source-config";

/** Folder name for alerts without an alertname label */
const UNNAMED = "unnamed";

/** The values of one alert folder */
export interface AlertGroup {
    /** Sanitized folder name */
    key: string;
    /** Display name */
    name: string;
    /** Whether the alert is firing */
    active: boolean;
    /** Whether at least one instance fires but is silenced or inhibited */
    silenced: boolean;
    /** Number of firing instances that are not silenced or inhibited */
    count: number;
    /** Severities of the firing instances, or of the rules when inactive */
    severity: string;
    /** Summary of the newest firing instance */
    summary: string;
    /** Start of the newest firing instance in milliseconds, null when inactive */
    startsAt: number | null;
    /** The firing instances, newest first */
    entries: AlertJsonEntry[];
}

function keyOf(name: string | undefined): string {
    return name ? sanitizeIdSegment(name) : UNNAMED;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    return items.reduce((groups, item) => {
        const itemKey = key(item);
        return new Map(groups).set(itemKey, [...(groups.get(itemKey) ?? []), item]);
    }, new Map<string, T[]>());
}

function joinSeverities(severities: string[]): string {
    return [...new Set(severities.filter(severity => severity !== ""))].sort().join(", ");
}

function toGroup(key: string, alerts: AlertEntry[], rules: AlertRule[], suppressed: AlertEntry[]): AlertGroup {
    const { entries, count } = summarizeAlerts(alerts);
    const newest = entries.at(0);
    const muted = suppressed.at(0)?.labels;
    const severities =
        rules.length > 0 ? rules.map(rule => rule.severity) : suppressed.map(s => s.labels.severity ?? "");
    return {
        key,
        name: newest?.alertname || rules.at(0)?.name || muted?.alertname || UNNAMED,
        active: count > 0,
        silenced: suppressed.length > 0,
        count,
        severity: joinSeverities(newest ? entries.map(entry => entry.severity) : severities),
        summary: newest?.summary ?? "",
        startsAt: newest ? Date.parse(newest.startsAt) || null : null,
        entries,
    };
}

/**
 * Builds one group per alert name, including rules that are not firing
 *
 * @param alerts - The firing alerts
 * @param rules - The alert rules known to Prometheus; may be empty
 * @param suppressed - The firing alerts that are silenced or inhibited
 * @returns The groups sorted by key
 */
export function groupAlerts(alerts: AlertEntry[], rules: AlertRule[], suppressed: AlertEntry[] = []): AlertGroup[] {
    const alertsByKey = groupBy(alerts, alert => keyOf(alert.labels.alertname));
    const rulesByKey = groupBy(rules, rule => keyOf(rule.name));
    const suppressedByKey = groupBy(suppressed, alert => keyOf(alert.labels.alertname));
    const keys = [...new Set([...alertsByKey.keys(), ...rulesByKey.keys(), ...suppressedByKey.keys()])].sort();
    return keys.map(key =>
        toGroup(key, alertsByKey.get(key) ?? [], rulesByKey.get(key) ?? [], suppressedByKey.get(key) ?? []),
    );
}
