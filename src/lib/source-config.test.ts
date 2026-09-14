import { expect } from "chai";
import { normalizeSources, sanitizeIdSegment, sanitizeTargetPath, type RawSourceConfig } from "./source-config";

function rawSource(overrides: Partial<RawSourceConfig> = {}): RawSourceConfig {
    return {
        enabled: true,
        name: "Node CPU",
        url: "http://prometheus.local:9090",
        pollInterval: 60,
        targetPath: "",
        metric: "node_cpu_seconds_total",
        aggregation: "avg",
        groupBy: [],
        ...overrides,
    };
}

describe("source-config => sanitizeIdSegment", () => {
    it("keeps allowed characters", () => {
        expect(sanitizeIdSegment("Node-CPU_01")).to.equal("Node-CPU_01");
    });

    it("replaces forbidden characters with underscores", () => {
        expect(sanitizeIdSegment("Nächstes Rennen!")).to.equal("N_chstes_Rennen_");
    });

    it("strips leading underscores and never returns an empty segment", () => {
        expect(sanitizeIdSegment("___x")).to.equal("x");
        expect(sanitizeIdSegment("äöü")).to.equal("source");
    });
});

describe("source-config => sanitizeTargetPath", () => {
    it("sanitizes each dot separated segment", () => {
        expect(sanitizeTargetPath("servers.nas 1.cpu")).to.equal("servers.nas_1.cpu");
    });

    it("drops empty segments", () => {
        expect(sanitizeTargetPath("a..b.")).to.equal("a.b");
    });
});

describe("source-config => normalizeSources", () => {
    it("normalizes a fully valid source", () => {
        const result = normalizeSources([rawSource()]);
        expect(result.errors).to.be.empty;
        expect(result.sources).to.have.lengthOf(1);
        const source = result.sources[0];
        expect(source.name).to.equal("Node CPU");
        expect(source.url).to.equal("http://prometheus.local:9090");
        expect(source.pollIntervalMs).to.equal(60_000);
        expect(source.targetPath).to.equal("Node_CPU");
        expect(source.query).to.equal("avg(node_cpu_seconds_total)");
    });

    it("uses the configured target path when present", () => {
        const result = normalizeSources([rawSource({ targetPath: "servers.nas.cpu" })]);
        expect(result.sources[0].targetPath).to.equal("servers.nas.cpu");
    });

    it("collects filter slots into filters", () => {
        const result = normalizeSources([
            rawSource({
                filter1Label: "mode",
                filter1Value: "idle",
                filter2Label: "instance",
                filter2Value: "server:9100",
            }),
        ]);
        expect(result.sources[0].query).to.equal('avg(node_cpu_seconds_total{mode="idle",instance="server:9100"})');
    });

    it("skips filter slots without a label or without a value", () => {
        const result = normalizeSources([rawSource({ filter1Label: "", filter1Value: "idle", filter2Label: "mode" })]);
        expect(result.sources[0].query).to.equal("avg(node_cpu_seconds_total)");
    });

    it("accepts groupBy as comma separated string (Admin sendTo serialization)", () => {
        const result = normalizeSources([
            rawSource({ aggregation: "sum", groupBy: "instance,cpu" as unknown as string[] }),
        ]);
        expect(result.sources[0].query).to.equal("sum by (instance,cpu) (node_cpu_seconds_total)");
    });

    it("skips disabled sources without reporting an error", () => {
        const result = normalizeSources([rawSource({ enabled: false })]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.be.empty;
    });

    it("clamps the poll interval to the allowed range", () => {
        const result = normalizeSources([rawSource({ pollInterval: 1 }), rawSource({ pollInterval: 999_999 })]);
        expect(result.sources[0].pollIntervalMs).to.equal(5_000);
        expect(result.sources[1].pollIntervalMs).to.equal(86_400_000);
    });

    it("falls back to the default interval on invalid values", () => {
        const result = normalizeSources([rawSource({ pollInterval: Number.NaN })]);
        expect(result.sources[0].pollIntervalMs).to.equal(60_000);
    });

    it("reports an error for an invalid URL and keeps other sources", () => {
        const result = normalizeSources([rawSource({ url: "ftp://nope" }), rawSource({ name: "ok" })]);
        expect(result.sources).to.have.lengthOf(1);
        expect(result.errors).to.have.lengthOf(1);
        expect(result.errors[0]).to.match(/url/i);
    });

    it("reports an error when the metric is missing", () => {
        const result = normalizeSources([rawSource({ metric: "" })]);
        expect(result.sources).to.be.empty;
        expect(result.errors[0]).to.match(/metric/i);
    });

    it("reports an error for an injected metric name instead of crashing", () => {
        const result = normalizeSources([rawSource({ metric: 'up"} or vector(1)' })]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.have.lengthOf(1);
    });

    it("deduplicates target paths so two sources never write the same state", () => {
        const result = normalizeSources([rawSource(), rawSource()]);
        expect(result.sources).to.have.lengthOf(2);
        expect(result.sources[0].targetPath).to.not.equal(result.sources[1].targetPath);
    });

    it("handles a non-array config gracefully", () => {
        const result = normalizeSources(undefined as unknown as RawSourceConfig[]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.be.empty;
    });
});
