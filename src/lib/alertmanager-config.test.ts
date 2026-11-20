import { expect } from "chai";
import { normalizeAlertmanagerConfig } from "./alertmanager-config";

describe("alertmanager-config => normalizeAlertmanagerConfig", () => {
    it("normalizes url and clamps the poll interval", () => {
        expect(normalizeAlertmanagerConfig({ url: " 192.168.1.10:9093/ ", pollInterval: 1 })).to.deep.equal({
            url: "http://192.168.1.10:9093",
            pollIntervalMs: 5000,
        });
    });

    it("uses the default interval when none is configured", () => {
        expect(normalizeAlertmanagerConfig({ url: "http://am:9093" })?.pollIntervalMs).to.equal(60_000);
    });

    it("returns nothing for an unusable url", () => {
        expect(normalizeAlertmanagerConfig({ url: "ftp://am" })).to.equal(undefined);
        expect(normalizeAlertmanagerConfig({ url: "" })).to.equal(undefined);
        expect(normalizeAlertmanagerConfig({})).to.equal(undefined);
    });
});
