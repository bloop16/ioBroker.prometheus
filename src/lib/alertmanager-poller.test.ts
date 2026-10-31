import { expect } from "chai";
import sinon from "sinon";
import type { AlertEntry, SilenceEntry } from "./alertmanager-client";
import { AlertmanagerPoller, type PollerHost } from "./alertmanager-poller";

const CONFIG = { url: "http://am:9093", pollIntervalMs: 60_000, matchers: ['severity="critical"'] };

function alert(fingerprint: string, severity: string): AlertEntry {
    return {
        fingerprint,
        labels: { alertname: "Disk", severity },
        annotations: {},
        startsAt: "2026-10-01T10:00:00Z",
    };
}

interface Harness {
    poller: AlertmanagerPoller;
    states: Map<string, unknown>;
    objects: Map<string, ioBroker.SettableObject>;
    source: { activeAlerts: sinon.SinonStub; suppressedAlerts: sinon.SinonStub; activeSilences: sinon.SinonStub };
    health: sinon.SinonStub;
    host: PollerHost;
    tick: () => Promise<void>;
}

function harness(
    existingSeverities: string[] = [],
    existingAlerts: string[] = [],
    rules?: { alertRules: sinon.SinonStub },
): Harness {
    const states = new Map<string, unknown>();
    const objects = new Map<string, ioBroker.SettableObject>();
    let intervalCallback: () => void = () => undefined;

    const write = (id: string, value: unknown): Promise<void> => {
        states.set(id, value);
        return Promise.resolve();
    };
    const host = {
        namespace: "prometheus.0",
        log: { debug: sinon.stub(), warn: sinon.stub() },
        setObjectNotExistsAsync: (id: string, obj: ioBroker.SettableObject) => {
            objects.set(id, obj);
            return Promise.resolve();
        },
        getForeignObjectsAsync: (pattern: string) =>
            Promise.resolve(
                Object.fromEntries(
                    (pattern.includes("byName") ? existingAlerts : existingSeverities).map(key => [
                        `${pattern.slice(0, -1)}${key}`,
                        {},
                    ]),
                ),
            ),
        setStateAsync: write,
        setStateChangedAsync: write,
        setInterval: (callback: () => void) => {
            intervalCallback = callback;
            return 1;
        },
        clearInterval: sinon.stub(),
    } as unknown as PollerHost;

    const source = {
        activeAlerts: sinon.stub().resolves([] as AlertEntry[]),
        suppressedAlerts: sinon.stub().resolves([] as AlertEntry[]),
        activeSilences: sinon.stub().resolves([] as SilenceEntry[]),
    };
    const health = sinon.stub();
    const poller = new AlertmanagerPoller(host, source, CONFIG, health, rules);
    const tick = async (): Promise<void> => {
        intervalCallback();
        await poller.idle();
    };
    return { poller, states, objects, source, health, host, tick };
}

describe("alertmanager-poller", () => {
    it("creates the object tree and writes the summary", async () => {
        const { poller, states, objects, source, health } = harness();
        source.activeAlerts.resolves([alert("a", "critical"), alert("b", "warning")]);

        await poller.start();
        await poller.idle();

        expect(source.activeAlerts.firstCall.args[0]).to.deep.equal(CONFIG.matchers);
        expect(objects.get("alertmanager")?.type).to.equal("channel");
        expect(objects.get("alertmanager.alerts.json")?.common?.role).to.equal("json");
        expect(states.get("alertmanager.alerts.count")).to.equal(2);
        expect(states.get("alertmanager.alerts.countBySeverity.critical")).to.equal(1);
        expect(states.get("alertmanager.silences.count")).to.equal(0);
        expect(JSON.parse(states.get("alertmanager.alerts.json") as string)).to.have.length(2);
        expect(objects.has("alertmanager.info.connection")).to.equal(false);
        expect(states.get("alertmanager.error")).to.equal("");
        expect(states.get("alertmanager.lastUpdate")).to.be.a("number");
        expect(health.lastCall.args).to.deep.equal([true]);
    });

    it("resets a severity to 0 when its last alert resolves", async () => {
        const { poller, states, source, tick } = harness();
        source.activeAlerts.resolves([alert("a", "critical")]);
        await poller.start();
        await poller.idle();

        source.activeAlerts.resolves([]);
        await tick();

        expect(states.get("alertmanager.alerts.countBySeverity.critical")).to.equal(0);
        expect(states.get("alertmanager.alerts.count")).to.equal(0);
    });

    it("creates one folder per alert like the metrics", async () => {
        const { poller, states, objects, source } = harness();
        source.activeAlerts.resolves([alert("a", "critical")]);

        await poller.start();
        await poller.idle();

        const root = "alertmanager.alerts.byName.Disk";
        expect(objects.get(root)?.type).to.equal("channel");
        expect(objects.get(`${root}.active`)?.common?.role).to.equal("indicator.alarm");
        expect(states.get(`${root}.active`)).to.equal(true);
        expect(states.get(`${root}.count`)).to.equal(1);
        expect(states.get(`${root}.severity`)).to.equal("critical");
        expect(JSON.parse(states.get(`${root}.json`) as string)).to.have.length(1);
    });

    it("keeps the folder of a resolved alert and marks it inactive", async () => {
        const { poller, states, source, tick } = harness();
        source.activeAlerts.resolves([alert("a", "critical")]);
        await poller.start();
        await poller.idle();

        source.activeAlerts.resolves([]);
        await tick();

        const root = "alertmanager.alerts.byName.Disk";
        expect(states.get(`${root}.active`)).to.equal(false);
        expect(states.get(`${root}.count`)).to.equal(0);
        expect(states.get(`${root}.startsAt`)).to.equal(null);
        expect(states.get(`${root}.severity`)).to.equal("critical");
    });

    it("shows a silenced alert in its folder but not in the counts", async () => {
        const { poller, states, source, tick } = harness();
        source.suppressedAlerts.resolves([alert("a", "none")]);

        await poller.start();
        await poller.idle();

        expect(source.suppressedAlerts.firstCall.args[0]).to.deep.equal(CONFIG.matchers);
        const root = "alertmanager.alerts.byName.Disk";
        expect(states.get(`${root}.silenced`)).to.equal(true);
        expect(states.get(`${root}.active`)).to.equal(false);
        expect(states.get("alertmanager.alerts.count")).to.equal(0);

        source.suppressedAlerts.resolves([]);
        await tick();
        expect(states.get(`${root}.silenced`)).to.equal(false);
    });

    it("adds new states to folders of a previous run", async () => {
        const { poller, objects } = harness([], ["Old"]);

        await poller.start();

        expect(objects.has("alertmanager.alerts.byName.Old.silenced")).to.equal(true);
    });

    it("marks alerts left over from a previous run as inactive", async () => {
        const { poller, states } = harness([], ["Old"]);

        await poller.start();
        await poller.idle();

        expect(states.get("alertmanager.alerts.byName.Old.active")).to.equal(false);
    });

    it("creates folders for rules that never fired", async () => {
        const rules = { alertRules: sinon.stub().resolves([{ name: "AdGuardDown", severity: "critical" }]) };
        const { poller, states } = harness([], [], rules);

        await poller.start();
        await poller.idle();

        expect(states.get("alertmanager.alerts.byName.AdGuardDown.active")).to.equal(false);
        expect(states.get("alertmanager.alerts.byName.AdGuardDown.severity")).to.equal("critical");
    });

    it("does not fail when the rules cannot be read", async () => {
        const rules = { alertRules: sinon.stub().rejects(new Error("prometheus down")) };
        const { poller, states, source, health } = harness([], [], rules);
        source.activeAlerts.resolves([alert("a", "critical")]);

        await poller.start();
        await poller.idle();

        expect(states.get("alertmanager.alerts.count")).to.equal(1);
        expect(states.get("alertmanager.alerts.byName.Disk.active")).to.equal(true);
        expect(health.lastCall.args).to.deep.equal([true]);
    });

    it("resets severities left over from a previous run", async () => {
        const { poller, states } = harness(["old"]);

        await poller.start();
        await poller.idle();

        expect(states.get("alertmanager.alerts.countBySeverity.old")).to.equal(0);
    });

    it("keeps the last counts when Alertmanager is unreachable", async () => {
        const { poller, states, source, health, tick } = harness();
        source.activeAlerts.resolves([alert("a", "critical")]);
        await poller.start();
        await poller.idle();

        source.activeAlerts.rejects(new Error("connect ECONNREFUSED"));
        await tick();

        expect(states.get("alertmanager.alerts.count")).to.equal(1);
        expect(states.get("alertmanager.error")).to.contain("ECONNREFUSED");
        expect(health.lastCall.args).to.deep.equal([false]);
    });

    it("does not report a connection problem when writing fails", async () => {
        const { poller, states, health, host } = harness();
        const write = host.setStateChangedAsync.bind(host);
        (host as { setStateChangedAsync: unknown }).setStateChangedAsync = (id: string, value: unknown) =>
            id === "alertmanager.alerts.count" ? Promise.reject(new Error("db down")) : write(id, value as string);

        await poller.start();
        await poller.idle();

        expect(health.lastCall.args).to.deep.equal([true]);
        expect(states.get("alertmanager.error")).to.contain("db down");
    });

    it("does not overlap polls", async () => {
        const { poller, source, tick } = harness();
        let release: (value: AlertEntry[]) => void = () => undefined;
        source.activeAlerts.returns(new Promise<AlertEntry[]>(resolve => (release = resolve)));

        await poller.start();
        const second = tick();
        release([]);
        await second;

        expect(source.activeAlerts.callCount).to.equal(1);
    });

    it("writes nothing when stopped during a request", async () => {
        const { poller, states, source, health } = harness();
        let release: (value: AlertEntry[]) => void = () => undefined;
        source.activeAlerts.returns(new Promise<AlertEntry[]>(resolve => (release = resolve)));

        await poller.start();
        poller.stop();
        release([alert("a", "critical")]);
        await poller.idle();

        expect(states.size).to.equal(0);
        expect(health.callCount).to.equal(0);
    });

    it("stops polling after stop()", async () => {
        const { poller, source, host, tick } = harness();
        await poller.start();
        await poller.idle();

        poller.stop();
        await tick();

        expect((host.clearInterval as sinon.SinonStub).callCount).to.equal(1);
        expect(source.activeAlerts.callCount).to.equal(1);
    });
});
