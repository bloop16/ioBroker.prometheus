const path = require("path");
const http = require("http");

const EXPORTER_PORT = 19126;

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
