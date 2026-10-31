/**
 * Normalizes and validates the Alertmanager settings from the Admin UI.
 *
 * Filters are configured as structured rows and turned into matcher
 * expressions here, so configuration values can never inject extra matchers.
 */

import { escapeLabelValue, isValidLabelName } from "./query-builder";
import { clampPollIntervalMs, validateUrl } from "./source-config";

const MATCHER_OPERATORS = ["=", "!=", "=~", "!~"];

/** One filter row as entered in the Admin UI */
export interface RawAlertFilter {
    /** Label name */
    label?: string;
    /** One of =, !=, =~, !~ */
    operator?: string;
    /** Value or regular expression */
    value?: string;
}

/** The Alertmanager settings as stored in the adapter configuration */
export interface RawAlertmanagerConfig {
    /** Base URL as entered */
    url?: string;
    /** Poll interval in seconds */
    pollInterval?: unknown;
    /** Filter rows */
    filters?: unknown;
}

/** Validated Alertmanager settings */
export interface NormalizedAlertmanagerConfig {
    /** Validated base URL */
    url: string;
    /** Poll interval in milliseconds */
    pollIntervalMs: number;
    /** Matcher expressions restricting the alerts */
    matchers: string[];
}

/** Result of validating the filter rows */
export interface MatcherResult {
    /** Matchers of all valid rows */
    matchers: string[];
    /** One message per invalid row */
    errors: string[];
}

/** Result of validating the Alertmanager settings */
export interface AlertmanagerConfigResult {
    /** The validated settings; undefined if they are unusable */
    config?: NormalizedAlertmanagerConfig;
    /** All problems found */
    errors: string[];
}

/**
 * Builds matcher expressions from the filter rows; rows without label are skipped
 *
 * @param filters - Filter rows from the Admin UI
 */
export function buildMatchers(filters: unknown): MatcherResult {
    if (filters === undefined || filters === null || filters === "") {
        return { matchers: [], errors: [] };
    }
    if (!Array.isArray(filters)) {
        return { matchers: [], errors: [`Invalid alert filters: expected a list, got ${JSON.stringify(filters)}`] };
    }
    const rows = (filters as RawAlertFilter[]).map(row => ({
        label: row.label?.trim() ?? "",
        operator: row.operator || "=",
        value: row.value ?? "",
    }));
    const used = rows.filter(row => row.label !== "");
    const isValid = (row: (typeof rows)[number]): boolean =>
        isValidLabelName(row.label) && MATCHER_OPERATORS.includes(row.operator);

    return {
        matchers: used.filter(isValid).map(row => `${row.label}${row.operator}"${escapeLabelValue(row.value)}"`),
        errors: used
            .filter(row => !isValid(row))
            .map(row => `Invalid alert filter: ${row.label} ${row.operator} ${row.value}`),
    };
}

/**
 * Validates the Alertmanager settings
 *
 * @param raw - The settings from the adapter configuration
 */
export function normalizeAlertmanagerConfig(raw: RawAlertmanagerConfig): AlertmanagerConfigResult {
    const url = validateUrl(raw.url?.trim());
    if (!url) {
        return { errors: ["Invalid Alertmanager URL (expected e.g. http://host:9093)"] };
    }
    const { matchers, errors } = buildMatchers(raw.filters);
    return { config: { url, pollIntervalMs: clampPollIntervalMs(raw.pollInterval), matchers }, errors };
}
