/**
 * Pull exporter: exposes selected ioBroker states in the Prometheus text
 * exposition format so a Prometheus server can scrape them.
 *
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import { escapeLabelValue, isValidMetricName } from "./query-builder";

/** Default metric name for exported states without a custom name */
export const DEFAULT_METRIC_NAME = "iobroker_state";

/** One exported state as tracked by the registry */
export interface ExportedState {
    /** Human readable name of the state (label "name") */
    name: string;
    /** Current numeric value; undefined when the value is not exportable */
    value: number | undefined;
    /** Optional custom metric name from the per-datapoint settings */
    metricName?: string;
}

/**
 * Converts an ioBroker state value into a Prometheus sample value
 *
 * @param value - The raw state value
 * @returns The finite number to export, or undefined if not exportable
 */
export function toMetricValue(value: unknown): number | undefined {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Holds the current values of all exported states and renders them */
export class MetricsRegistry {
    private readonly states = new Map<string, ExportedState>();

    /** Number of tracked states */
    public get size(): number {
        return this.states.size;
    }

    /**
     * Adds or updates one exported state
     *
     * @param id - The ioBroker state id
     * @param entry - Name, current value and optional custom metric name
     */
    public set(id: string, entry: ExportedState): void {
        this.states.set(id, entry);
    }

    /**
     * Updates the value of an already tracked state; unknown ids are ignored
     *
     * @param id - The ioBroker state id
     * @param value - The new sample value (undefined removes the sample)
     */
    public updateValue(id: string, value: number | undefined): void {
        const entry = this.states.get(id);
        if (entry) {
            this.states.set(id, { ...entry, value });
        }
    }

    /**
     * Stops exporting one state
     *
     * @param id - The ioBroker state id
     */
    public remove(id: string): void {
        this.states.delete(id);
    }

    /** Removes all tracked states */
    public clear(): void {
        this.states.clear();
    }

    /** Renders all current values in the Prometheus text exposition format */
    public render(): string {
        // group samples by metric name so each metric gets exactly one TYPE header
        const byMetric = new Map<string, string[]>();
        for (const [id, entry] of this.states) {
            if (entry.value === undefined) {
                continue;
            }
            const metric =
                entry.metricName && isValidMetricName(entry.metricName) ? entry.metricName : DEFAULT_METRIC_NAME;
            const labels = `id="${escapeLabelValue(id)}",name="${escapeLabelValue(entry.name)}"`;
            let lines = byMetric.get(metric);
            if (!lines) {
                lines = [];
                byMetric.set(metric, lines);
            }
            lines.push(`${metric}{${labels}} ${entry.value}`);
        }

        const output: string[] = [];
        for (const [metric, lines] of [...byMetric.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            output.push(`# HELP ${metric} ioBroker state values exported by iobroker.prometheus`);
            output.push(`# TYPE ${metric} gauge`);
            output.push(...lines.sort());
        }
        return output.length > 0 ? `${output.join("\n")}\n` : "";
    }
}
