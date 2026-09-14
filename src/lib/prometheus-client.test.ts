import { expect } from "chai";
import sinon from "sinon";
import { PrometheusClient } from "./prometheus-client";

function clientWithResponse(data: unknown): { client: PrometheusClient; get: sinon.SinonStub } {
    const get = sinon.stub().resolves({ data });
    const client = new PrometheusClient({ baseUrl: "http://prom:9090", timeoutMs: 5000 }, get);
    return { client, get };
}

describe("prometheus-client => instantQuery", () => {
    it("parses a vector response into samples", async () => {
        const { client, get } = clientWithResponse({
            status: "success",
            data: {
                resultType: "vector",
                result: [
                    { metric: { instance: "a" }, value: [1726000000, "1.5"] },
                    { metric: { instance: "b" }, value: [1726000000, "2"] },
                ],
            },
        });

        const samples = await client.instantQuery('up{job="node"}');
        expect(samples).to.deep.equal([
            { labels: { instance: "a" }, value: 1.5 },
            { labels: { instance: "b" }, value: 2 },
        ]);
        const [url, options] = get.firstCall.args;
        expect(url).to.equal("http://prom:9090/api/v1/query");
        expect(options.params.query).to.equal('up{job="node"}');
    });

    it("parses a scalar response into a single unlabeled sample", async () => {
        const { client } = clientWithResponse({
            status: "success",
            data: { resultType: "scalar", result: [1726000000, "42"] },
        });

        const samples = await client.instantQuery("scalar(up)");
        expect(samples).to.deep.equal([{ labels: {}, value: 42 }]);
    });

    it("drops non-finite sample values (NaN, Inf)", async () => {
        const { client } = clientWithResponse({
            status: "success",
            data: {
                resultType: "vector",
                result: [
                    { metric: { instance: "a" }, value: [1726000000, "NaN"] },
                    { metric: { instance: "b" }, value: [1726000000, "+Inf"] },
                    { metric: { instance: "c" }, value: [1726000000, "3"] },
                ],
            },
        });
        const samples = await client.instantQuery("up");
        expect(samples).to.deep.equal([{ labels: { instance: "c" }, value: 3 }]);
    });

    it("returns an empty list for an empty vector", async () => {
        const { client } = clientWithResponse({
            status: "success",
            data: { resultType: "vector", result: [] },
        });
        expect(await client.instantQuery("up")).to.deep.equal([]);
    });

    it("throws a descriptive error on a Prometheus error envelope", async () => {
        const { client } = clientWithResponse({ status: "error", errorType: "bad_data", error: "parse error" });
        await expect(client.instantQuery("up")).to.be.rejectedWith(/parse error/);
    });

    it("throws on an unexpected response shape", async () => {
        const { client } = clientWithResponse("not-json-envelope");
        await expect(client.instantQuery("up")).to.be.rejectedWith(/unexpected/i);
    });
});

describe("prometheus-client => label endpoints", () => {
    it("fetches metric names from the __name__ endpoint", async () => {
        const { client, get } = clientWithResponse({ status: "success", data: ["up", "node_load1"] });
        const names = await client.metricNames();
        expect(names).to.deep.equal(["up", "node_load1"]);
        expect(get.firstCall.args[0]).to.equal("http://prom:9090/api/v1/label/__name__/values");
    });

    it("fetches label names, optionally narrowed by metric", async () => {
        const { client, get } = clientWithResponse({ status: "success", data: ["instance", "job"] });
        const labels = await client.labelNames("node_load1");
        expect(labels).to.deep.equal(["instance", "job"]);
        const [url, options] = get.firstCall.args;
        expect(url).to.equal("http://prom:9090/api/v1/labels");
        expect(options.params["match[]"]).to.equal("node_load1");
    });

    it("fetches values for a label", async () => {
        const { client, get } = clientWithResponse({ status: "success", data: ["idle", "user"] });
        const values = await client.labelValues("mode");
        expect(values).to.deep.equal(["idle", "user"]);
        expect(get.firstCall.args[0]).to.equal("http://prom:9090/api/v1/label/mode/values");
    });

    it("rejects invalid label names instead of building a bad URL", async () => {
        const { client } = clientWithResponse({ status: "success", data: [] });
        await expect(client.labelValues("../../admin")).to.be.rejectedWith(/label/i);
    });

    it("filters non-string entries from list responses", async () => {
        const { client } = clientWithResponse({ status: "success", data: ["ok", 5, null, "also-ok"] });
        expect(await client.metricNames()).to.deep.equal(["ok", "also-ok"]);
    });
});

describe("prometheus-client => auth", () => {
    it("passes basic auth credentials when configured", async () => {
        const get = sinon.stub().resolves({ data: { status: "success", data: [] } });
        const client = new PrometheusClient(
            { baseUrl: "http://prom:9090", timeoutMs: 5000, username: "user", password: "secret" },
            get,
        );
        await client.metricNames();
        expect(get.firstCall.args[1].auth).to.deep.equal({ username: "user", password: "secret" });
    });

    it("omits auth when no username is configured", async () => {
        const { client, get } = clientWithResponse({ status: "success", data: [] });
        await client.metricNames();
        expect(get.firstCall.args[1].auth).to.equal(undefined);
    });
});
