/**
 * Thin client for the Prometheus HTTP API (v1).
 *
 * Only the read endpoints needed by this adapter are implemented:
 * - /api/v1/query                      (instant queries)
 * - /api/v1/labels                     (label names)
 * - /api/v1/label/<name>/values        (label / metric name values)
 *
 * https://prometheus.io/docs/prometheus/latest/querying/api/
 */

import axios from "axios";
import { isValidLabelName, isValidMetricName } from "./query-builder";

/** Connection options for one Prometheus server */
export interface PrometheusClientOptions {
    /** Base URL of the Prometheus server without trailing slash */
    baseUrl: string;
    /** HTTP request timeout in milliseconds */
    timeoutMs: number;
    /** Optional basic auth user name */
    username?: string;
    /** Optional basic auth password */
    password?: string;
}

/** One sample of an instant query result */
export interface PromSample {
    /** Labels identifying the series this sample belongs to */
    labels: Record<string, string>;
    /** The sample value */
    value: number;
}

interface RequestOptions {
    params?: Record<string, string>;
    auth?: { username: string; password: string };
    timeout: number;
}

/** Minimal HTTP GET signature so tests can inject a stub instead of axios */
export type HttpGet = (url: string, options: RequestOptions) => Promise<{ data: unknown }>;

interface PromEnvelope {
    status: string;
    data?: unknown;
    error?: string;
    errorType?: string;
}

interface PromQueryData {
    resultType?: string;
    result?: unknown;
}

interface PromVectorEntry {
    metric?: Record<string, string>;
    value: [number, string];
}

function isEnvelope(data: unknown): data is PromEnvelope {
    return typeof data === "object" && data !== null && typeof (data as PromEnvelope).status === "string";
}

function isVectorEntry(entry: unknown): entry is PromVectorEntry {
    return typeof entry === "object" && entry !== null && Array.isArray((entry as PromVectorEntry).value);
}

/** Client for the read endpoints of one Prometheus server */
export class PrometheusClient {
    private readonly options: PrometheusClientOptions;
    private readonly httpGet: HttpGet;

    /**
     * @param options - Connection options for the Prometheus server
     * @param httpGet - Optional HTTP implementation override (used by unit tests)
     */
    public constructor(options: PrometheusClientOptions, httpGet?: HttpGet) {
        this.options = options;
        this.httpGet = httpGet ?? ((url, requestOptions) => axios.get(url, requestOptions));
    }

    /**
     * Runs an instant query and returns all resulting samples
     *
     * @param query - The PromQL query to execute
     */
    public async instantQuery(query: string): Promise<PromSample[]> {
        const data = (await this.request("/api/v1/query", { query })) as PromQueryData | undefined;

        if (data?.resultType === "scalar" && Array.isArray(data.result)) {
            return [{ labels: {}, value: Number(data.result[1]) }].filter(sample => Number.isFinite(sample.value));
        }

        if (data?.resultType === "vector" && Array.isArray(data.result)) {
            return (
                data.result
                    .filter(isVectorEntry)
                    .map(entry => ({
                        labels: entry.metric ?? {},
                        value: Number(entry.value[1]),
                    }))
                    // Prometheus can return NaN/+Inf/-Inf; those are not usable as state values
                    .filter(sample => Number.isFinite(sample.value))
            );
        }

        throw new Error(`Unexpected query result type "${data?.resultType ?? "unknown"}"`);
    }

    /** Returns all known metric names of the Prometheus instance */
    public metricNames(): Promise<string[]> {
        return this.stringList("/api/v1/label/__name__/values");
    }

    /**
     * Returns all label names, optionally narrowed to a metric
     *
     * @param metric - Optional metric name used as match[] selector
     */
    public labelNames(metric?: string): Promise<string[]> {
        return this.stringList("/api/v1/labels", this.matchParams(metric));
    }

    /**
     * Returns all values of one label, optionally narrowed to a metric
     *
     * @param label - The label name whose values are requested
     * @param metric - Optional metric name used as match[] selector
     */
    public labelValues(label: string, metric?: string): Promise<string[]> {
        if (!isValidLabelName(label)) {
            return Promise.reject(new Error(`Invalid label name: "${label}"`));
        }
        return this.stringList(`/api/v1/label/${encodeURIComponent(label)}/values`, this.matchParams(metric));
    }

    private matchParams(metric?: string): Record<string, string> | undefined {
        if (metric && isValidMetricName(metric)) {
            return { "match[]": metric };
        }
        return undefined;
    }

    private async stringList(path: string, params?: Record<string, string>): Promise<string[]> {
        const data = await this.request(path, params);
        if (!Array.isArray(data)) {
            throw new Error(`Unexpected response from ${path}: expected an array`);
        }
        return data.filter((entry): entry is string => typeof entry === "string");
    }

    private async request(path: string, params?: Record<string, string>): Promise<unknown> {
        const response = await this.httpGet(`${this.options.baseUrl}${path}`, {
            params,
            timeout: this.options.timeoutMs,
            auth: this.options.username
                ? { username: this.options.username, password: this.options.password ?? "" }
                : undefined,
        });

        if (!isEnvelope(response.data)) {
            throw new Error(`Unexpected response from ${path}: not a Prometheus API envelope`);
        }
        if (response.data.status !== "success") {
            throw new Error(
                `Prometheus API error (${response.data.errorType ?? "unknown"}): ${response.data.error ?? "no details"}`,
            );
        }
        return response.data.data;
    }
}
