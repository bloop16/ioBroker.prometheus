/**
 * Condenses Alertmanager API results into the values written to states.
 *
 * The output is deterministic for the same set of alerts, so the JSON states
 * only change when the alerts really change, whatever order the server uses.
 */

import type { AlertEntry, SilenceEntry } from "./alertmanager-client";

/** Maximum number of entries written to a JSON state; the counts stay exact */
export const MAX_JSON_ENTRIES = 500;
/** Maximum length of free text taken over from the server */
export const MAX_TEXT_LENGTH = 500;

/** Compact form of one alert for the JSON state */
export interface AlertJsonEntry {
    /** The alertname label */
    alertname: string;
    /** The severity label */
    severity: string;
    /** The instance label */
    instance: string;
    /** The summary annotation */
    summary: string;
    /** Start of the alert as ISO timestamp */
    startsAt: string;
    /** Stable identifier of the alert */
    fingerprint: string;
}

/** Values derived from the firing alerts */
export interface AlertSummary {
    /** Number of firing alerts */
    count: number;
    /** Compact alerts, newest first */
    entries: AlertJsonEntry[];
}

/** Values derived from the active silences */
export interface SilenceSummary {
    /** Number of active silences */
    count: number;
    /** Active silences, ending soonest first */
    entries: SilenceEntry[];
}

function truncate(text: string): string {
    return text.slice(0, MAX_TEXT_LENGTH);
}

function timestamp(value: string): number {
    return Date.parse(value) || 0;
}

function toJsonEntry(alert: AlertEntry): AlertJsonEntry {
    return {
        alertname: alert.labels.alertname ?? "",
        severity: alert.labels.severity ?? "",
        instance: alert.labels.instance ?? "",
        summary: truncate(alert.annotations.summary ?? ""),
        startsAt: alert.startsAt,
        fingerprint: alert.fingerprint,
    };
}

/**
 * Summarizes the firing alerts
 *
 * @param alerts - Alerts returned by the server
 */
export function summarizeAlerts(alerts: AlertEntry[]): AlertSummary {
    const sorted = [...alerts].sort(
        (a, b) => timestamp(b.startsAt) - timestamp(a.startsAt) || a.fingerprint.localeCompare(b.fingerprint),
    );
    return {
        count: alerts.length,
        entries: sorted.slice(0, MAX_JSON_ENTRIES).map(toJsonEntry),
    };
}

/**
 * Summarizes the active silences
 *
 * @param silences - Active silences returned by the server
 */
export function summarizeSilences(silences: SilenceEntry[]): SilenceSummary {
    const sorted = [...silences].sort((a, b) => timestamp(a.endsAt) - timestamp(b.endsAt) || a.id.localeCompare(b.id));
    return {
        count: silences.length,
        entries: sorted.slice(0, MAX_JSON_ENTRIES).map(silence => ({ ...silence, comment: truncate(silence.comment) })),
    };
}
