/**
 * Builds PromQL queries from structured configuration values.
 *
 * The Admin UI never lets the user type raw PromQL. Every part of the query
 * (metric, filters, aggregation, groupBy) is validated here so that user
 * configuration can never inject arbitrary PromQL.
 */

export const AGGREGATIONS = ["none", "avg", "sum", "min", "max", "count"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** One exact-match label filter of a selector */
export interface QueryFilter {
    /** Label name to match */
    label: string;
    /** Exact label value to match */
    value: string;
}

/** Structured description of a PromQL instant query */
export interface QuerySpec {
    /** Metric name */
    metric: string;
    /** Exact-match label filters */
    filters: QueryFilter[];
    /** Aggregation applied over all matching series */
    aggregation: Aggregation;
    /** Labels for the "by (...)" clause; only used with an aggregation */
    groupBy: string[];
}

// https://prometheus.io/docs/concepts/data_model/#metric-names-and-labels
const METRIC_NAME_REGEX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Returns true if the given string is a valid Prometheus metric name
 *
 * @param metric - The metric name to validate
 */
export function isValidMetricName(metric: string): boolean {
    return METRIC_NAME_REGEX.test(metric);
}

/**
 * Returns true if the given string is a valid Prometheus label name
 *
 * @param label - The label name to validate
 */
export function isValidLabelName(label: string): boolean {
    return LABEL_NAME_REGEX.test(label);
}

/**
 * Escapes a label value for use inside double quotes in a PromQL selector
 *
 * @param value - The raw label value
 */
export function escapeLabelValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Builds a PromQL query string from a validated query specification.
 *
 * @param spec - Structured query parts collected by the Admin UI
 * @returns The PromQL query string
 * @throws {Error} If any part of the specification is invalid
 */
export function buildQuery(spec: QuerySpec): string {
    if (!isValidMetricName(spec.metric)) {
        throw new Error(`Invalid metric name: "${spec.metric}"`);
    }
    if (!AGGREGATIONS.includes(spec.aggregation)) {
        throw new Error(`Invalid aggregation: "${String(spec.aggregation)}"`);
    }

    const matchers = spec.filters.map(filter => {
        if (!isValidLabelName(filter.label)) {
            throw new Error(`Invalid filter label name: "${filter.label}"`);
        }
        return `${filter.label}="${escapeLabelValue(filter.value)}"`;
    });

    const selector = matchers.length > 0 ? `${spec.metric}{${matchers.join(",")}}` : spec.metric;

    if (spec.aggregation === "none") {
        return selector;
    }

    if (spec.groupBy.length > 0) {
        for (const label of spec.groupBy) {
            if (!isValidLabelName(label)) {
                throw new Error(`Invalid groupBy label name: "${label}"`);
            }
        }
        return `${spec.aggregation} by (${spec.groupBy.join(",")}) (${selector})`;
    }

    return `${spec.aggregation}(${selector})`;
}
