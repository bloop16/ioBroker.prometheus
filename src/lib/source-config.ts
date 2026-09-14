/**
 * Normalizes and validates the source rows configured in the Admin UI.
 *
 * Every value coming from the configuration is treated as untrusted input:
 * URLs are validated, intervals are clamped, object id segments are sanitized
 * and the PromQL query is built through the strict query builder.
 */

import { buildQuery, type Aggregation, type QueryFilter, AGGREGATIONS } from "./query-builder";

/** Number of filter slots offered by the Admin UI */
export const FILTER_SLOT_COUNT = 5;

/** All source states live below this channel, like other ioBroker adapters do */
export const METRICS_CHANNEL = "metrics";

export const MIN_POLL_INTERVAL_SEC = 5;
export const MAX_POLL_INTERVAL_SEC = 86_400;
export const DEFAULT_POLL_INTERVAL_SEC = 60;

/** One source row exactly as stored in native.sources by the Admin UI */
export interface RawSourceConfig {
    /** Whether this source should be polled */
    enabled?: boolean;
    /** Display name, also default for the datapoint path */
    name?: string;
    /** Poll interval in seconds */
    pollInterval?: number;
    /** Object id path below which states are written */
    targetPath?: string;
    /** Metric name selected in the Admin UI */
    metric?: string;
    /** Aggregation function name */
    aggregation?: string;
    /** Multiselect value; the Admin UI may serialize it as a comma separated string */
    groupBy?: string[] | string;
    /** Label name of filter slot 1 */
    filter1Label?: string;
    /** Label value of filter slot 1 */
    filter1Value?: string;
    /** Label name of filter slot 2 */
    filter2Label?: string;
    /** Label value of filter slot 2 */
    filter2Value?: string;
    /** Label name of filter slot 3 */
    filter3Label?: string;
    /** Label value of filter slot 3 */
    filter3Value?: string;
    /** Label name of filter slot 4 */
    filter4Label?: string;
    /** Label value of filter slot 4 */
    filter4Value?: string;
    /** Label name of filter slot 5 */
    filter5Label?: string;
    /** Label value of filter slot 5 */
    filter5Value?: string;
}

/** A validated source ready to be polled */
export interface NormalizedSource {
    /** Display name of the source */
    name: string;
    /** Validated base URL of the Prometheus server (shared by all sources) */
    url: string;
    /** Poll interval in milliseconds, clamped to the allowed range */
    pollIntervalMs: number;
    /** Object id path (relative to the adapter namespace) below which states are written */
    targetPath: string;
    /** The generated PromQL query */
    query: string;
    /** Labels of the "<agg> by (...)" clause; empty when the query returns a single series */
    groupBy: string[];
}

/** Result of normalizing all configured source rows */
export interface NormalizeResult {
    /** All sources that can be polled */
    sources: NormalizedSource[];
    /** Human readable error messages for rows that could not be used */
    errors: string[];
}

/**
 * Cleans a value that arrived through an Admin UI jsonData template.
 *
 * Empty fields resolve to the strings "null"/"undefined" in template
 * literals, and older Admin versions may pass patterns through unresolved.
 *
 * @param value - The raw string from the Admin UI message
 * @returns The usable value, or undefined if it is a template artifact
 */
export function cleanAdminValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "null" || trimmed === "undefined" || trimmed.includes("${")) {
        return undefined;
    }
    return trimmed;
}

/**
 * Sanitizes one object id segment to the characters recommended for ioBroker ids
 *
 * @param segment - One object id segment (no dots)
 */
export function sanitizeIdSegment(segment: string): string {
    const sanitized = segment.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "");
    return sanitized.length > 0 ? sanitized : "source";
}

/**
 * Sanitizes a dot separated object id path segment by segment
 *
 * @param path - Dot separated object id path
 */
export function sanitizeTargetPath(path: string): string {
    return path
        .split(".")
        .filter(segment => segment.length > 0)
        .map(sanitizeIdSegment)
        .join(".");
}

/**
 * Parses the groupBy value which may arrive as array or comma separated string
 *
 * @param groupBy - Raw groupBy value from the configuration
 */
export function parseGroupBy(groupBy: string[] | string | undefined): string[] {
    if (Array.isArray(groupBy)) {
        return groupBy.map(label => label.trim()).filter(label => label.length > 0);
    }
    if (typeof groupBy === "string") {
        return groupBy
            .split(",")
            .map(label => label.trim())
            .filter(label => label.length > 0);
    }
    return [];
}

/**
 * Collects the configured filter slots into a list of filters
 *
 * @param raw - One source row from the configuration
 */
export function collectFilters(raw: RawSourceConfig): QueryFilter[] {
    const filters: QueryFilter[] = [];
    for (let slot = 1; slot <= FILTER_SLOT_COUNT; slot++) {
        const label = (raw[`filter${slot}Label` as keyof RawSourceConfig] as string | undefined)?.trim();
        const value = raw[`filter${slot}Value` as keyof RawSourceConfig] as string | undefined;
        if (label && value !== undefined && value !== "") {
            filters.push({ label, value });
        }
    }
    return filters;
}

function clampPollIntervalMs(pollInterval: unknown): number {
    const parsed = Number(pollInterval);
    const seconds = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, MIN_POLL_INTERVAL_SEC), MAX_POLL_INTERVAL_SEC)
        : DEFAULT_POLL_INTERVAL_SEC;
    return Math.floor(seconds * 1000);
}

/**
 * Validates a Prometheus base URL (http/https only)
 *
 * @param url - The URL as entered in the Admin UI
 * @returns The URL without trailing slashes, or undefined if unusable
 */
export function validateUrl(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    // users often enter "host:9090" without a scheme - assume plain http then
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) ? url : `http://${url}`;
    try {
        const parsed = new URL(withScheme);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return undefined;
        }
        return withScheme.replace(/\/+$/, "");
    } catch {
        return undefined;
    }
}

function normalizeAggregation(aggregation: string | undefined): Aggregation | undefined {
    // an empty value falls back to the Admin UI default for new rows
    const value = (aggregation || "avg") as Aggregation;
    return AGGREGATIONS.includes(value) ? value : undefined;
}

/**
 * Validates all configured source rows.
 *
 * Invalid rows are reported as errors but never throw, so a single bad row
 * cannot prevent the remaining sources from being polled.
 *
 * @param rawSources - The value of native.sources
 * @param serverUrl - The globally configured Prometheus server URL
 * @returns The usable sources plus error messages for the rejected rows
 */
export function normalizeSources(rawSources: RawSourceConfig[], serverUrl: string | undefined): NormalizeResult {
    const sources: NormalizedSource[] = [];
    const errors: string[] = [];
    const usedPaths = new Set<string>();

    if (!Array.isArray(rawSources)) {
        return { sources, errors };
    }

    const url = validateUrl(serverUrl?.trim());
    if (!url) {
        if (rawSources.some(raw => raw.enabled !== false)) {
            errors.push(
                `invalid or missing Prometheus server URL "${serverUrl ?? ""}" (expected e.g. http://host:9090)`,
            );
        }
        return { sources, errors };
    }

    rawSources.forEach((raw, index) => {
        const name = raw.name?.trim() || `Source ${index + 1}`;
        if (raw.enabled === false) {
            return;
        }

        const metric = raw.metric?.trim();
        if (!metric) {
            errors.push(`${name}: no metric configured`);
            return;
        }

        const aggregation = normalizeAggregation(raw.aggregation?.trim());
        if (!aggregation) {
            errors.push(`${name}: unknown aggregation "${raw.aggregation ?? ""}"`);
            return;
        }

        const groupBy = aggregation === "none" ? [] : parseGroupBy(raw.groupBy);

        let query: string;
        try {
            query = buildQuery({ metric, filters: collectFilters(raw), aggregation, groupBy });
        } catch (error) {
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        let targetPath = sanitizeTargetPath(raw.targetPath?.trim() || name);
        if (!targetPath) {
            targetPath = sanitizeIdSegment(name);
        }
        if (targetPath !== METRICS_CHANNEL && !targetPath.startsWith(`${METRICS_CHANNEL}.`)) {
            targetPath = `${METRICS_CHANNEL}.${targetPath}`;
        }
        while (usedPaths.has(targetPath)) {
            targetPath = `${targetPath}_${index}`;
        }
        usedPaths.add(targetPath);

        sources.push({
            name,
            url,
            pollIntervalMs: clampPollIntervalMs(raw.pollInterval),
            targetPath,
            query,
            groupBy,
        });
    });

    return { sources, errors };
}
