import { expect } from "chai";
import { buildQuery, escapeLabelValue, isValidLabelName, isValidMetricName } from "./query-builder";

describe("query-builder => isValidMetricName", () => {
    it("accepts valid metric names", () => {
        expect(isValidMetricName("node_cpu_seconds_total")).to.be.true;
        expect(isValidMetricName("up")).to.be.true;
        expect(isValidMetricName(":recording:rule")).to.be.true;
        expect(isValidMetricName("_hidden_metric")).to.be.true;
    });

    it("rejects invalid metric names", () => {
        expect(isValidMetricName("")).to.be.false;
        expect(isValidMetricName("1starts_with_digit")).to.be.false;
        expect(isValidMetricName("has space")).to.be.false;
        expect(isValidMetricName('inject"}or 1')).to.be.false;
        expect(isValidMetricName("umlaut_ä")).to.be.false;
    });
});

describe("query-builder => isValidLabelName", () => {
    it("accepts valid label names", () => {
        expect(isValidLabelName("instance")).to.be.true;
        expect(isValidLabelName("_meta")).to.be.true;
        expect(isValidLabelName("cpu0")).to.be.true;
    });

    it("rejects invalid label names", () => {
        expect(isValidLabelName("")).to.be.false;
        expect(isValidLabelName("0cpu")).to.be.false;
        expect(isValidLabelName("with:colon")).to.be.false;
        expect(isValidLabelName('a"b')).to.be.false;
    });
});

describe("query-builder => escapeLabelValue", () => {
    it("escapes backslashes, quotes and newlines", () => {
        expect(escapeLabelValue("plain")).to.equal("plain");
        expect(escapeLabelValue('has"quote')).to.equal('has\\"quote');
        expect(escapeLabelValue("back\\slash")).to.equal("back\\\\slash");
        expect(escapeLabelValue("new\nline")).to.equal("new\\nline");
    });
});

describe("query-builder => buildQuery", () => {
    it("builds a plain selector without aggregation or filters", () => {
        const query = buildQuery({
            metric: "up",
            filters: [],
            aggregation: "none",
            groupBy: [],
        });
        expect(query).to.equal("up");
    });

    it("builds a selector with filters", () => {
        const query = buildQuery({
            metric: "node_cpu_seconds_total",
            filters: [
                { label: "mode", value: "idle" },
                { label: "instance", value: "server:9100" },
            ],
            aggregation: "none",
            groupBy: [],
        });
        expect(query).to.equal('node_cpu_seconds_total{mode="idle",instance="server:9100"}');
    });

    it("wraps the selector in an aggregation function", () => {
        const query = buildQuery({
            metric: "node_memory_MemFree_bytes",
            filters: [],
            aggregation: "avg",
            groupBy: [],
        });
        expect(query).to.equal("avg(node_memory_MemFree_bytes)");
    });

    it("adds a by clause when groupBy labels are given", () => {
        const query = buildQuery({
            metric: "node_cpu_seconds_total",
            filters: [{ label: "mode", value: "idle" }],
            aggregation: "sum",
            groupBy: ["instance", "cpu"],
        });
        expect(query).to.equal('sum by (instance,cpu) (node_cpu_seconds_total{mode="idle"})');
    });

    it("supports all documented aggregations", () => {
        for (const aggregation of ["avg", "sum", "min", "max", "count"] as const) {
            const query = buildQuery({ metric: "up", filters: [], aggregation, groupBy: [] });
            expect(query).to.equal(`${aggregation}(up)`);
        }
    });

    it("escapes filter values to prevent PromQL injection", () => {
        const query = buildQuery({
            metric: "up",
            filters: [{ label: "job", value: 'a"} or vector(1) # ' }],
            aggregation: "none",
            groupBy: [],
        });
        expect(query).to.equal('up{job="a\\"} or vector(1) # "}');
    });

    it("throws on an invalid metric name", () => {
        expect(() => buildQuery({ metric: "bad metric", filters: [], aggregation: "none", groupBy: [] })).to.throw(
            /metric/i,
        );
    });

    it("throws on an invalid filter label name", () => {
        expect(() =>
            buildQuery({
                metric: "up",
                filters: [{ label: 'x"', value: "1" }],
                aggregation: "none",
                groupBy: [],
            }),
        ).to.throw(/label/i);
    });

    it("throws on an invalid groupBy label name", () => {
        expect(() => buildQuery({ metric: "up", filters: [], aggregation: "sum", groupBy: ["ok", "not ok"] })).to.throw(
            /label/i,
        );
    });

    it("throws on an unknown aggregation", () => {
        expect(() => buildQuery({ metric: "up", filters: [], aggregation: "evil()" as never, groupBy: [] })).to.throw(
            /aggregation/i,
        );
    });

    it("ignores groupBy when no aggregation is used", () => {
        const query = buildQuery({ metric: "up", filters: [], aggregation: "none", groupBy: ["instance"] });
        expect(query).to.equal("up");
    });
});
