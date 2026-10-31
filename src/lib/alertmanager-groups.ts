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
    /** Number of firing instances */
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

function toGroup(key: string, alerts: AlertEntry[], rules: AlertRule[]): AlertGroup {
    const { entries, count } = summarizeAlerts(alerts);
    const newest = entries.at(0);
    return {
        key,
        name: newest?.alertname || rules.at(0)?.name || UNNAMED,
        active: count > 0,
        count,
        severity: joinSeverities(newest ? entries.map(entry => entry.severity) : rules.map(rule => rule.severity)),
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
 * @returns The groups sorted by key
 */
export function groupAlerts(alerts: AlertEntry[], rules: AlertRule[]): AlertGroup[] {
    const alertsByKey = groupBy(alerts, alert => keyOf(alert.labels.alertname));
    const rulesByKey = groupBy(rules, rule => keyOf(rule.name));
    const keys = [...new Set([...alertsByKey.keys(), ...rulesByKey.keys()])].sort();
    return keys.map(key => toGroup(key, alertsByKey.get(key) ?? [], rulesByKey.get(key) ?? []));
}
