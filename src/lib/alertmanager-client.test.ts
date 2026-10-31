import axios from "axios";
import { expect } from "chai";
import sinon from "sinon";
import { AlertmanagerClient, testAlertmanager } from "./alertmanager-client";

const ALERT = {
    fingerprint: "abc",
    labels: { alertname: "Disk", severity: "critical" },
    annotations: { summary: "Disk full" },
    startsAt: "2026-10-01T10:00:00Z",
    status: { state: "active" },
};

function clientWithResponse(data: unknown): { client: AlertmanagerClient; get: sinon.SinonStub } {
    const get = sinon.stub().resolves({ data });
    const client = new AlertmanagerClient({ baseUrl: "http://am:9093", timeoutMs: 5000 }, get);
    return { client, get };
}

describe("alertmanager-client => activeAlerts", () => {
    it("requests only firing alerts and parses them", async () => {
        const { client, get } = clientWithResponse([ALERT]);

        const alerts = await client.activeAlerts([]);

        expect(alerts).to.deep.equal([
            {
                fingerprint: "abc",
                labels: ALERT.labels,
                annotations: ALERT.annotations,
                startsAt: ALERT.startsAt,
            },
        ]);
        const [url, options] = get.firstCall.args;
        expect(url).to.equal("http://am:9093/api/v2/alerts");
        expect(options.params).to.deep.equal({
            active: "true",
            silenced: "false",
            inhibited: "false",
            unprocessed: "false",
            filter: [],
        });
    });

    it("serializes matchers as repeated filter parameters", async () => {
        const { client, get } = clientWithResponse([]);

        await client.activeAlerts(['severity="critical"', 'team="home"']);

        const uri = decodeURIComponent(axios.getUri({ url: "http://am", ...get.firstCall.args[1] }));
        expect(uri).to.contain('filter=severity="critical"&filter=team="home"');
        expect(uri).to.not.contain("filter[]");
    });

    it("drops malformed entries", async () => {
        const { client } = clientWithResponse([ALERT, null, { fingerprint: "x" }, "junk"]);
        expect(await client.activeAlerts([])).to.have.length(1);
    });

    it("rejects a response that is not an array", async () => {
        const { client } = clientWithResponse({ status: "success", data: [] });

        let error: Error | undefined;
        await client.activeAlerts([]).catch((e: Error) => (error = e));
        expect(error?.message).to.contain("expected an array");
    });

    it("sends basic auth only when configured", async () => {
        const get = sinon.stub().resolves({ data: [] });
        const client = new AlertmanagerClient(
            { baseUrl: "http://am:9093", timeoutMs: 5000, username: "u", password: "p" },
            get,
        );

        await client.activeAlerts([]);

        expect(get.firstCall.args[1].auth).to.deep.equal({ username: "u", password: "p" });
        const { client: anonymous, get: anonymousGet } = clientWithResponse([]);
        await anonymous.activeAlerts([]);
        expect(anonymousGet.firstCall.args[1].auth).to.equal(undefined);
    });
});

describe("alertmanager-client => activeSilences", () => {
    const silence = (id: string, state: string): unknown => ({
        id,
        status: { state },
        matchers: [{ name: "alertname", value: "Disk", isRegex: false }],
        createdBy: "martin",
        comment: "maintenance",
        startsAt: "2026-10-01T10:00:00Z",
        endsAt: "2026-10-02T10:00:00Z",
    });

    it("keeps only active silences, also on servers without the state parameters", async () => {
        const { client } = clientWithResponse([
            silence("1", "active"),
            silence("2", "expired"),
            silence("3", "pending"),
        ]);

        const silences = await client.activeSilences();

        expect(silences.map(entry => entry.id)).to.deep.equal(["1"]);
        expect(silences[0].matchers).to.deep.equal(['alertname="Disk"']);
    });

    it("renders regex and negative matchers", async () => {
        const { client } = clientWithResponse([
            {
                id: "1",
                status: { state: "active" },
                matchers: [
                    { name: "a", value: "b", isRegex: true, isEqual: true },
                    { name: "c", value: "d", isRegex: false, isEqual: false },
                    { name: "e", value: "f", isRegex: true, isEqual: false },
                ],
            },
        ]);

        const [entry] = await client.activeSilences();
        expect(entry.matchers).to.deep.equal(['a=~"b"', 'c!="d"', 'e!~"f"']);
    });
});

describe("alertmanager-client => version", () => {
    it("reads only the version from the status response", async () => {
        const { client, get } = clientWithResponse({
            versionInfo: { version: "0.27.0" },
            config: { original: "secret" },
        });

        expect(await client.version()).to.equal("0.27.0");
        expect(get.firstCall.args[0]).to.equal("http://am:9093/api/v2/status");
    });

    it("rejects a server that is not an Alertmanager", async () => {
        const { client } = clientWithResponse("404 page not found");

        let error: Error | undefined;
        await client.version().catch((e: Error) => (error = e));
        expect(error?.message).to.contain("not an Alertmanager");
    });
});

describe("alertmanager-client => testAlertmanager", () => {
    it("rejects an invalid url without a request", async () => {
        const result = await testAlertmanager({ url: "ftp://am", timeoutMs: 1000 });
        expect(result).to.have.property("error");
    });
});
