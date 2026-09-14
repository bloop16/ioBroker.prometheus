import { expect } from "chai";
import { MetricsRegistry, toMetricValue } from "./exporter";

describe("exporter => toMetricValue", () => {
    it("passes finite numbers through", () => {
        expect(toMetricValue(21.5)).to.equal(21.5);
        expect(toMetricValue(0)).to.equal(0);
    });

    it("maps booleans to 0/1", () => {
        expect(toMetricValue(true)).to.equal(1);
        expect(toMetricValue(false)).to.equal(0);
    });

    it("parses numeric strings", () => {
        expect(toMetricValue("42.5")).to.equal(42.5);
    });

    it("rejects everything else", () => {
        expect(toMetricValue("on")).to.equal(undefined);
        expect(toMetricValue(null)).to.equal(undefined);
        expect(toMetricValue(Number.NaN)).to.equal(undefined);
        expect(toMetricValue(Number.POSITIVE_INFINITY)).to.equal(undefined);
    });
});

describe("exporter => MetricsRegistry", () => {
    it("renders default metrics with id and name labels", () => {
        const registry = new MetricsRegistry();
        registry.set("zigbee.0.sensor.temperature", { name: "Wohnzimmer Temp", value: 21.5 });
        const text = registry.render();
        expect(text).to.include("# TYPE iobroker_state gauge");
        expect(text).to.include('iobroker_state{id="zigbee.0.sensor.temperature",name="Wohnzimmer Temp"} 21.5');
    });

    it("supports a custom metric name per state", () => {
        const registry = new MetricsRegistry();
        registry.set("hm-rpc.0.power", { name: "Steckdose", value: 12, metricName: "iobroker_power_watts" });
        const text = registry.render();
        expect(text).to.include("# TYPE iobroker_power_watts gauge");
        expect(text).to.include('iobroker_power_watts{id="hm-rpc.0.power",name="Steckdose"} 12');
    });

    it("falls back to the default metric for invalid custom names", () => {
        const registry = new MetricsRegistry();
        registry.set("a.0.x", { name: "x", value: 1, metricName: 'bad name{)"' });
        const text = registry.render();
        expect(text).to.include('iobroker_state{id="a.0.x"');
        expect(text).to.not.include("bad name");
    });

    it("escapes label values", () => {
        const registry = new MetricsRegistry();
        registry.set("a.0.b", { name: 'has "quote" and \\slash', value: 1 });
        expect(registry.render()).to.include('name="has \\"quote\\" and \\\\slash"');
    });

    it("omits states without a numeric value and removed states", () => {
        const registry = new MetricsRegistry();
        registry.set("a.0.b", { name: "b", value: undefined });
        registry.set("a.0.c", { name: "c", value: 2 });
        registry.remove("a.0.c");
        const text = registry.render();
        expect(text).to.not.include("a.0.b");
        expect(text).to.not.include("a.0.c");
    });

    it("groups multiple states under one TYPE header per metric", () => {
        const registry = new MetricsRegistry();
        registry.set("a.0.one", { name: "one", value: 1 });
        registry.set("a.0.two", { name: "two", value: 2 });
        const text = registry.render();
        expect(text.match(/# TYPE iobroker_state gauge/g)).to.have.lengthOf(1);
        expect(text.indexOf('id="a.0.one"')).to.be.greaterThan(-1);
        expect(text.indexOf('id="a.0.two"')).to.be.greaterThan(-1);
    });

    it("updates only the value of an already tracked state", () => {
        const registry = new MetricsRegistry();
        registry.set("a.0.b", { name: "b", value: 1, metricName: "iobroker_power_watts" });
        registry.updateValue("a.0.b", 2);
        registry.updateValue("a.0.unknown", 5);
        const text = registry.render();
        expect(text).to.include('iobroker_power_watts{id="a.0.b",name="b"} 2');
        expect(text).to.not.include("unknown");
    });

    it("reports the number of exported states", () => {
        const registry = new MetricsRegistry();
        expect(registry.size).to.equal(0);
        registry.set("a.0.b", { name: "b", value: 1 });
        expect(registry.size).to.equal(1);
    });
});
