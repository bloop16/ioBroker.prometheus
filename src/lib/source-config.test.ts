import { expect } from "chai";
import {
    cleanAdminValue,
    normalizeSources,
    sanitizeIdSegment,
    sanitizeTargetPath,
    validateUrl,
    type RawSourceConfig,
} from "./source-config";

const SERVER = "http://prometheus.local:9090";

function normalize(rows: RawSourceConfig[], url: string | undefined = SERVER): ReturnType<typeof normalizeSources> {
    return normalizeSources(rows, url);
}

function rawSource(overrides: Partial<RawSourceConfig> = {}): RawSourceConfig {
    return {
        enabled: true,
        name: "Node CPU",
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
        const result = normalize([rawSource()]);
        expect(result.errors).to.be.empty;
        expect(result.sources).to.have.lengthOf(1);
        const source = result.sources[0];
        expect(source.name).to.equal("Node CPU");
        expect(source.url).to.equal(SERVER);
        expect(source.pollIntervalMs).to.equal(60_000);
        expect(source.targetPath).to.equal("metrics.Node_CPU");
        expect(source.query).to.equal("avg(node_cpu_seconds_total)");
    });

    it("places the configured target path below the metrics channel", () => {
        const result = normalize([rawSource({ targetPath: "servers.nas.cpu" })]);
        expect(result.sources[0].targetPath).to.equal("metrics.servers.nas.cpu");
    });

    it("does not double the metrics prefix when the user already entered it", () => {
        const result = normalize([rawSource({ targetPath: "metrics.servers.cpu" })]);
        expect(result.sources[0].targetPath).to.equal("metrics.servers.cpu");
    });

    it("collects filter slots into filters", () => {
        const result = normalize([
            rawSource({
                filter1Label: "mode",
                filter1Value: "idle",
                filter2Label: "instance",
                filter2Value: "server:9100",
            }),
        ]);
        expect(result.sources[0].query).to.equal('avg(node_cpu_seconds_total{mode="idle",instance="server:9100"})');
    });

    it("stops collecting filters at the first slot without a label (cleared filter)", () => {
        // clearing filter 1 hides slots 2+ in the UI, so their leftover data must be ignored
        const result = normalize([
            rawSource({ filter1Label: "", filter1Value: "idle", filter2Label: "mode", filter2Value: "idle" }),
        ]);
        expect(result.sources[0].query).to.equal("avg(node_cpu_seconds_total)");
    });

    it("skips an incomplete filter (label without value) but keeps later slots", () => {
        const result = normalize([
            rawSource({ filter1Label: "mode", filter1Value: "", filter2Label: "instance", filter2Value: "a" }),
        ]);
        expect(result.sources[0].query).to.equal('avg(node_cpu_seconds_total{instance="a"})');
    });

    it("accepts groupBy as comma separated string (Admin sendTo serialization)", () => {
        const result = normalize([rawSource({ aggregation: "sum", groupBy: "instance,cpu" as unknown as string[] })]);
        expect(result.sources[0].query).to.equal("sum by (instance,cpu) (node_cpu_seconds_total)");
    });

    it("skips disabled sources without reporting an error", () => {
        const result = normalize([rawSource({ enabled: false })]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.be.empty;
    });

    it("clamps the poll interval to the allowed range", () => {
        const result = normalize([rawSource({ pollInterval: 1 }), rawSource({ pollInterval: 999_999 })]);
        expect(result.sources[0].pollIntervalMs).to.equal(5_000);
        expect(result.sources[1].pollIntervalMs).to.equal(86_400_000);
    });

    it("falls back to the default interval on invalid values", () => {
        const result = normalize([rawSource({ pollInterval: Number.NaN })]);
        expect(result.sources[0].pollIntervalMs).to.equal(60_000);
    });

    it("reports a single error and no sources when the server URL is invalid", () => {
        const result = normalize([rawSource(), rawSource({ name: "ok" })], "ftp://nope");
        expect(result.sources).to.be.empty;
        expect(result.errors).to.have.lengthOf(1);
        expect(result.errors[0]).to.match(/url/i);
    });

    it("stays silent about a missing server URL when no source is enabled", () => {
        const result = normalize([rawSource({ enabled: false })], "");
        expect(result.sources).to.be.empty;
        expect(result.errors).to.be.empty;
    });

    it("applies the validated server URL to every source", () => {
        const result = normalize([rawSource(), rawSource({ name: "b" })], "192.168.1.105:9090");
        expect(result.sources).to.have.lengthOf(2);
        expect(result.sources.every(source => source.url === "http://192.168.1.105:9090")).to.be.true;
    });

    it("falls back to the Admin UI default aggregation when the value is empty", () => {
        const result = normalize([rawSource({ aggregation: "" })]);
        expect(result.errors).to.be.empty;
        expect(result.sources[0].query).to.equal("avg(node_cpu_seconds_total)");
    });

    it("reports an error when the metric is missing", () => {
        const result = normalize([rawSource({ metric: "" })]);
        expect(result.sources).to.be.empty;
        expect(result.errors[0]).to.match(/metric/i);
    });

    it("reports an error for an injected metric name instead of crashing", () => {
        const result = normalize([rawSource({ metric: 'up"} or vector(1)' })]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.have.lengthOf(1);
    });

    it("deduplicates target paths so two sources never write the same state", () => {
        const result = normalize([rawSource(), rawSource()]);
        expect(result.sources).to.have.lengthOf(2);
        expect(result.sources[0].targetPath).to.not.equal(result.sources[1].targetPath);
    });

    it("handles a non-array config gracefully", () => {
        const result = normalize(undefined as unknown as RawSourceConfig[]);
        expect(result.sources).to.be.empty;
        expect(result.errors).to.be.empty;
    });
});

describe("source-config => validateUrl", () => {
    it("accepts http/https URLs and strips trailing slashes", () => {
        expect(validateUrl("http://prom:9090/")).to.equal("http://prom:9090");
        expect(validateUrl("https://prom.example")).to.equal("https://prom.example");
    });

    it("prepends http:// when no scheme is given (common user input)", () => {
        expect(validateUrl("192.168.1.105:9090")).to.equal("http://192.168.1.105:9090");
        expect(validateUrl("prom.local:9090")).to.equal("http://prom.local:9090");
        expect(validateUrl("localhost:9090")).to.equal("http://localhost:9090");
    });

    it("rejects other protocols, malformed URLs and empty input", () => {
        expect(validateUrl("ftp://nope")).to.equal(undefined);
        expect(validateUrl("http://exa mple")).to.equal(undefined);
        expect(validateUrl("")).to.equal(undefined);
        expect(validateUrl(undefined)).to.equal(undefined);
    });
});

describe("source-config => cleanAdminValue", () => {
    it("passes real values through", () => {
        expect(cleanAdminValue("node_load1")).to.equal("node_load1");
        expect(cleanAdminValue("instance")).to.equal("instance");
    });

    it("treats Admin template artifacts as absent", () => {
        // empty fields resolve to the strings "null"/"undefined" in jsonData templates
        expect(cleanAdminValue("null")).to.equal(undefined);
        expect(cleanAdminValue("undefined")).to.equal(undefined);
        expect(cleanAdminValue("${globalData.url}")).to.equal(undefined);
        expect(cleanAdminValue("")).to.equal(undefined);
        expect(cleanAdminValue(undefined)).to.equal(undefined);
    });
});
