const path = require("path");
const http = require("http");
const { expect } = require("chai");

const EXPORTER_PORT = 19126;

const MOCK_ALERT = {
    fingerprint: "abc123",
    labels: { alertname: "DiskFull", severity: "critical", instance: "nas" },
    annotations: { summary: "Disk almost full" },
    startsAt: "2026-10-01T10:00:00.000Z",
    status: { state: "active" },
};

const MOCK_SILENCES = [
    {
        id: "s1",
        status: { state: "active" },
        matchers: [{ name: "alertname", value: "Noisy", isRegex: false }],
        createdBy: "test",
        comment: "maintenance",
        startsAt: "2026-10-01T10:00:00.000Z",
        endsAt: "2026-10-02T10:00:00.000Z",
    },
    { id: "s2", status: { state: "expired" }, matchers: [] },
];

/**
 * Starts a mock Alertmanager that answers the v2 API.
 *
 * @returns {Promise<{server: http.Server, port: number, urls: string[]}>} The running mock
 */
function startMockAlertmanager() {
    const urls = [];
    const server = http.createServer((req, res) => {
        urls.push(req.url);
        const path = req.url.split("?")[0];
        const bodies = {
            "/api/v2/alerts": [MOCK_ALERT],
            "/api/v2/silences": MOCK_SILENCES,
            "/api/v2/status": { versionInfo: { version: "0.34.2" }, config: { original: "secret" } },
        };
        res.writeHead(path in bodies ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(bodies[path] ?? {}));
    });
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, urls }));
    });
}

/**
 * Waits until a state has a value.
 *
 * @param {object} harness - The test harness
 * @param {string} id - The state id
 * @returns {Promise<object>} The state
 */
async function waitForState(harness, id) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const state = await harness.states.getStateAsync(id);
        if (state && state.val !== null) {
            return state;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`State ${id} was not written in time`);
}

/**
 * Fetches a URL and resolves with the response body.
 *
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} The response body
 */
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = "";
            res.on("data", chunk => (body += chunk));
            res.on("end", () => resolve(body));
        }).on("error", reject);
    });
}
const { tests } = require("@iobroker/testing");

/**
 * Minimal mock of the Prometheus HTTP API used by the additional integration tests.
 *
 * @returns {Promise<{ server: import("http").Server, port: number }>} The listening server and its port
 */
function startMockPrometheus() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        let body;
        if (url.pathname === "/api/v1/query") {
            body = {
                status: "success",
                data: {
                    resultType: "vector",
                    result: [{ metric: { instance: "mock:9100" }, value: [1726000000, "42.5"] }],
                },
            };
        } else if (url.pathname === "/api/v1/label/__name__/values") {
            body = { status: "success", data: ["node_load1", "up"] };
        } else if (url.pathname === "/api/v1/labels") {
            body = { status: "success", data: ["instance", "job"] };
        } else if (/^\/api\/v1\/label\/[^/]+\/values$/.test(url.pathname)) {
            body = { status: "success", data: ["mock:9100"] };
        } else {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    });
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Reading a mock Alertmanager", getHarness => {
            let mock;

            before(async () => {
                mock = await startMockAlertmanager();
            });

            after(() => {
                if (mock) {
                    mock.server.close();
                }
            });

            it("writes alerts and silences without any Prometheus source", async function () {
                this.timeout(60000);
                const harness = getHarness();

                // changeAdapterConfig would merge the filter list into an object
                const instance = await harness.objects.getObjectAsync("system.adapter.prometheus.0");
                await harness.objects.setObjectAsync("system.adapter.prometheus.0", {
                    ...instance,
                    native: {
                        ...instance.native,
                        alertmanagerEnabled: true,
                        alertmanagerUrl: `http://127.0.0.1:${mock.port}`,
                        alertmanagerPollInterval: 5,
                        alertmanagerFilters: [{ label: "severity", operator: "=~", value: "critical|warning" }],
                    },
                });
                await harness.startAdapterAndWait(true);

                const count = await waitForState(harness, "prometheus.0.alertmanager.silences.json");
                expect(JSON.parse(count.val).map(silence => silence.id)).to.deep.equal(["s1"]);

                const ns = "prometheus.0.alertmanager";
                expect((await harness.states.getStateAsync(`${ns}.alerts.count`)).val).to.equal(1);
                expect((await harness.states.getStateAsync(`${ns}.silences.count`)).val).to.equal(1);
                expect((await harness.states.getStateAsync(`${ns}.alerts.countBySeverity.critical`)).val).to.equal(1);
                expect((await harness.states.getStateAsync(`${ns}.info.connection`)).val).to.equal(true);
                expect(JSON.parse((await harness.states.getStateAsync(`${ns}.alerts.json`)).val)[0].alertname).to.equal(
                    "DiskFull",
                );
                expect(decodeURIComponent(mock.urls.find(url => url.startsWith("/api/v2/alerts")))).to.contain(
                    'filter=severity=~"critical|warning"',
                );
                expect((await waitForState(harness, "prometheus.0.info.connection")).val).to.equal(true);

                const response = await new Promise((resolve, reject) => {
                    harness.sendTo(
                        "prometheus.0",
                        "testAlertmanager",
                        { url: `http://127.0.0.1:${mock.port}` },
                        resolve,
                    );
                    setTimeout(() => reject(new Error("sendTo timed out")), 10000);
                });
                expect(response).to.deep.equal({ result: "Connected to Alertmanager 0.34.2" });
            });
        });

        suite("Alertmanager disabled", getHarness => {
            it("removes states left over from when it was enabled", async function () {
                this.timeout(60000);
                const harness = getHarness();
                const root = "prometheus.0.alertmanager";

                await harness.objects.setObjectAsync(root, { type: "channel", common: { name: "Old" }, native: {} });
                await harness.objects.setObjectAsync(`${root}.alerts.count`, {
                    type: "state",
                    common: { name: "Old", type: "number", role: "value", read: true, write: false },
                    native: {},
                });

                await harness.startAdapterAndWait();

                for (let attempt = 0; attempt < 50; attempt++) {
                    if (!(await harness.objects.getObjectAsync(`${root}.alerts.count`))) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                expect(await harness.objects.getObjectAsync(`${root}.alerts.count`)).to.equal(null);
                expect(await harness.objects.getObjectAsync(root)).to.equal(null);
            });
        });

        suite("Polling a mock Prometheus server", getHarness => {
            let mock;

            before(async () => {
                mock = await startMockPrometheus();
            });

            after(() => {
                if (mock) {
                    mock.server.close();
                }
            });

            it("writes the query result and reports metric names via sendTo", async function () {
                this.timeout(60000);
                const harness = getHarness();

                await harness.changeAdapterConfig("prometheus", {
                    native: {
                        url: `http://127.0.0.1:${mock.port}`,
                        requestTimeout: 5,
                        username: "",
                        password: "",
                        exporterEnabled: true,
                        port: EXPORTER_PORT,
                        bind: "127.0.0.1",
                        sources: [
                            {
                                enabled: true,
                                name: "Mock",
                                pollInterval: 5,
                                targetPath: "mock.load",
                                metric: "node_load1",
                                aggregation: "avg",
                                groupBy: [],
                            },
                        ],
                    },
                });
                // a state with per-datapoint custom settings that should be exported
                await harness.objects.setObjectAsync("0_userdata.0.exporter_test", {
                    type: "state",
                    common: {
                        name: "Exporter Test",
                        type: "number",
                        role: "value",
                        read: true,
                        write: true,
                        custom: { "prometheus.0": { enabled: true, metricName: "iobroker_exporter_test" } },
                    },
                    native: {},
                });
                await new Promise(resolve =>
                    harness.states.setState("0_userdata.0.exporter_test", { val: 12.34, ack: true }, resolve),
                );

                await harness.startAdapterAndWait(true);

                // wait for the first poll cycle (startup jitter is up to 5s)
                const value = await new Promise((resolve, reject) => {
                    const started = Date.now();
                    const check = () => {
                        harness.states.getState("prometheus.0.metrics.mock.load.value", (err, state) => {
                            if (err) {
                                return reject(err);
                            }
                            if (state && state.val !== null) {
                                return resolve(state);
                            }
                            if (Date.now() - started > 30000) {
                                return reject(new Error("Timed out waiting for polled value"));
                            }
                            setTimeout(check, 500);
                        });
                    };
                    check();
                });
                if (value.val !== 42.5 || value.ack !== true) {
                    throw new Error(`Unexpected state value: ${JSON.stringify(value)}`);
                }

                const metricNames = await new Promise((resolve, reject) => {
                    harness.sendTo("prometheus.0", "getMetricNames", {}, resolve);
                    setTimeout(() => reject(new Error("sendTo timed out")), 10000);
                });
                const values = metricNames.map(entry => entry.value);
                if (!values.includes("node_load1") || !values.includes("up")) {
                    throw new Error(`Unexpected metric names: ${JSON.stringify(metricNames)}`);
                }

                const metricsText = await httpGet(`http://127.0.0.1:${EXPORTER_PORT}/metrics`);
                if (!metricsText.includes('iobroker_exporter_test{id="0_userdata.0.exporter_test"')) {
                    throw new Error(`Exported state missing in /metrics output: ${metricsText}`);
                }
                if (!metricsText.includes("12.34")) {
                    throw new Error(`Exported value missing in /metrics output: ${metricsText}`);
                }
                if (!metricsText.includes("iobroker_exporter_scrapes_total 1")) {
                    throw new Error(`Scrape counter missing in /metrics output: ${metricsText}`);
                }
            });
        });
    },
});
