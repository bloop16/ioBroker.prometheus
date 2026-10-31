import { expect } from "chai";
import { buildMatchers, normalizeAlertmanagerConfig } from "./alertmanager-config";

describe("alertmanager-config => buildMatchers", () => {
    it("builds matchers for all operators and skips empty rows", () => {
        const { matchers, errors } = buildMatchers([
            { label: "severity", operator: "=", value: "critical" },
            { label: "team", operator: "!=", value: "home" },
            { label: "instance", operator: "=~", value: "a|b" },
            { label: "job", operator: "!~", value: "x.*" },
            { label: "", operator: "=", value: "ignored" },
        ]);

        expect(matchers).to.deep.equal(['severity="critical"', 'team!="home"', 'instance=~"a|b"', 'job!~"x.*"']);
        expect(errors).to.deep.equal([]);
    });

    it("escapes values so they cannot break out of the matcher", () => {
        const { matchers } = buildMatchers([{ label: "a", operator: "=", value: 'x",b="y' }]);
        expect(matchers).to.deep.equal(['a="x\\",b=\\"y"']);
    });

    it("defaults the operator and reports invalid rows", () => {
        const { matchers, errors } = buildMatchers([
            { label: "a", value: "b" },
            { label: "bad label", operator: "=", value: "x" },
            { label: "c", operator: "like", value: "x" },
        ]);

        expect(matchers).to.deep.equal(['a="b"']);
        expect(errors).to.have.length(2);
    });

    it("tolerates a missing filter list", () => {
        expect(buildMatchers(undefined)).to.deep.equal({ matchers: [], errors: [] });
    });
});

describe("alertmanager-config => buildMatchers with broken input", () => {
    it("reports filters that are not a list instead of crashing", () => {
        const { matchers, errors } = buildMatchers({ label: "a" });

        expect(matchers).to.deep.equal([]);
        expect(errors).to.have.length(1);
    });
});

describe("alertmanager-config => normalizeAlertmanagerConfig", () => {
    it("normalizes url and clamps the poll interval", () => {
        const result = normalizeAlertmanagerConfig({ url: "192.168.1.10:9093/", pollInterval: 1, filters: [] });

        expect(result.config?.url).to.equal("http://192.168.1.10:9093");
        expect(result.config?.pollIntervalMs).to.equal(5000);
    });

    it("uses the default interval when none is configured", () => {
        const result = normalizeAlertmanagerConfig({ url: "http://am:9093" });
        expect(result.config?.pollIntervalMs).to.equal(60_000);
    });

    it("returns no config for an invalid url", () => {
        const result = normalizeAlertmanagerConfig({ url: "ftp://am" });

        expect(result.config).to.equal(undefined);
        expect(result.errors).to.have.length(1);
        expect(result.errors[0]).to.not.contain("ftp");
    });

    it("passes filter errors through", () => {
        const result = normalizeAlertmanagerConfig({
            url: "http://am:9093",
            filters: [{ label: "bad label", value: "x" }],
        });

        expect(result.config?.matchers).to.deep.equal([]);
        expect(result.errors).to.have.length(1);
    });
});
