/**
 * Groups alerts by name for the per-alert folders below alerts.
 *
 * One rule usually fires once per instance, so a name is the stable unit a
 * dashboard can bind to, unlike fingerprints that come and go with each alert.
 */

import { createHash } from "node:crypto";

import type { AlertEntry } from "./alertmanager-client";
import { summarizeAlerts, type AlertJsonEntry } from "./alertmanager-summary";
import type { AlertRule } from "./prometheus-client";
import { sanitizeIdSegment } from "./source-config";

/** Folder name for alerts without an alertname label */
const UNNAMED = "unnamed";
/** Summary states next to the alert folders, which an alert must not replace */
const RESERVED_KEYS = ["count", "json"];

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
    /** Summary of the newest firing instance, preferring unsilenced ones */
    summary: string;
    /** Start of that instance in milliseconds, null when nothing fires */
    startsAt: number | null;
    /** The firing instances, newest first */
    entries: AlertJsonEntry[];
}

function keyOf(name: string | undefined): string {
    if (!name) {
        return UNNAMED;
    }
    const key = sanitizeIdSegment(name);
    if (key !== name) {
        // sanitizing is lossy, so different names could otherwise share a folder
        return `${key}_${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;
    }
    return RESERVED_KEYS.includes(key) ? `${key}_alert` : key;
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
    const shown = newest ?? summarizeAlerts(suppressed).entries.at(0);
    const severities =
        rules.length > 0 ? rules.map(rule => rule.severity) : suppressed.map(s => s.labels.severity ?? "");
    return {
        key,
        name: shown?.alertname || rules.at(0)?.name || UNNAMED,
        active: count > 0,
        silenced: suppressed.length > 0,
        count,
        severity: joinSeverities(newest ? entries.map(entry => entry.severity) : severities),
        summary: shown?.summary ?? "",
        startsAt: shown ? Date.parse(shown.startsAt) || null : null,
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
