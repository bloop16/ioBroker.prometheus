import { expect } from "chai";
import type { AlertEntry } from "./alertmanager-client";
import { groupAlerts } from "./alertmanager-groups";
import type { AlertRule } from "./prometheus-client";

function alert(name: string | undefined, severity: string, startsAt: string, summary = "", instance = ""): AlertEntry {
    return {
        fingerprint: `${name}-${instance}`,
        labels: { ...(name ? { alertname: name } : {}), severity, instance },
        annotations: { summary },
        startsAt,
    };
}

describe("alertmanager-groups => groupAlerts", () => {
    it("merges all instances of one alert into one group", () => {
        const [group, ...others] = groupAlerts(
            [
                alert("InstanceDown", "critical", "2026-10-01T10:00:00Z", "a down", "a"),
                alert("InstanceDown", "critical", "2026-10-02T10:00:00Z", "b down", "b"),
            ],
            [],
        );

        expect(others).to.deep.equal([]);
        expect(group.key).to.equal("InstanceDown");
        expect(group.name).to.equal("InstanceDown");
        expect(group.active).to.equal(true);
        expect(group.count).to.equal(2);
        expect(group.severity).to.equal("critical");
        expect(group.summary).to.equal("b down");
        expect(group.startsAt).to.equal(Date.parse("2026-10-02T10:00:00Z"));
        expect(group.entries.map(entry => entry.instance)).to.deep.equal(["b", "a"]);
    });

    it("lists inactive rules so they exist before they ever fire", () => {
        const rules: AlertRule[] = [{ name: "AdGuardDown", severity: "critical" }];

        expect(groupAlerts([], rules)).to.deep.equal([
            {
                key: "AdGuardDown",
                name: "AdGuardDown",
                active: false,
                silenced: false,
                count: 0,
                severity: "critical",
                summary: "",
                startsAt: null,
                entries: [],
            },
        ]);
    });

    it("joins the severities of rules sharing a name", () => {
        const rules: AlertRule[] = [
            { name: "SSLCertExpiringSoon", severity: "warning" },
            { name: "SSLCertExpiringSoon", severity: "critical" },
        ];

        const groups = groupAlerts([], rules);

        expect(groups).to.have.length(1);
        expect(groups[0].severity).to.equal("critical, warning");
    });

    it("prefers the severity of the firing alerts over the rule", () => {
        const rules: AlertRule[] = [
            { name: "SSLCertExpiringSoon", severity: "warning" },
            { name: "SSLCertExpiringSoon", severity: "critical" },
        ];

        const [group] = groupAlerts([alert("SSLCertExpiringSoon", "warning", "2026-10-01T10:00:00Z")], rules);

        expect(group.severity).to.equal("warning");
    });

    it("marks an alert as silenced without counting it as active", () => {
        const silenced = [alert("Watchdog", "none", "2026-10-01T10:00:00Z", "x")];

        const [group] = groupAlerts([], [{ name: "Watchdog", severity: "none" }], silenced);

        expect(group.silenced).to.equal(true);
        expect(group.active).to.equal(false);
        expect(group.count).to.equal(0);
        expect(group.entries).to.deep.equal([]);
        expect(group.summary).to.equal("x");
        expect(group.startsAt).to.equal(Date.parse("2026-10-01T10:00:00Z"));
    });

    it("prefers the unsilenced instance for summary and start", () => {
        const [group] = groupAlerts(
            [alert("Down", "critical", "2026-10-01T10:00:00Z", "active", "a")],
            [],
            [alert("Down", "critical", "2026-10-02T10:00:00Z", "muted", "b")],
        );

        expect(group.summary).to.equal("active");
        expect(group.startsAt).to.equal(Date.parse("2026-10-01T10:00:00Z"));
    });

    it("creates a group for a silenced alert without a rule", () => {
        const [group] = groupAlerts([], [], [alert("Watchdog", "none", "2026-10-01T10:00:00Z")]);

        expect(group.key).to.equal("Watchdog");
        expect(group.name).to.equal("Watchdog");
        expect(group.severity).to.equal("none");
        expect(group.silenced).to.equal(true);
    });

    it("can be active and silenced at the same time for different instances", () => {
        const [group] = groupAlerts(
            [alert("Down", "critical", "2026-10-01T10:00:00Z", "", "a")],
            [],
            [alert("Down", "critical", "2026-10-01T10:00:00Z", "", "b")],
        );

        expect(group.active).to.equal(true);
        expect(group.silenced).to.equal(true);
        expect(group.count).to.equal(1);
    });

    it("sanitizes the key but keeps the display name", () => {
        const [group] = groupAlerts([alert("Disk.Full 1", "info", "2026-10-01T10:00:00Z")], []);

        expect(group.key).to.match(/^Disk_Full_1_[0-9a-f]{6}$/);
        expect(group.name).to.equal("Disk.Full 1");
    });

    it("keeps alerts away from the names of the summary states", () => {
        const groups = groupAlerts(
            [],
            [
                { name: "count", severity: "" },
                { name: "json", severity: "" },
            ],
        );

        expect(groups.map(group => group.key)).to.deep.equal(["count_alert", "json_alert"]);
        expect(groups[0].name).to.equal("count");
    });

    it("keeps names apart that sanitize to the same id", () => {
        const groups = groupAlerts(
            [],
            [
                { name: "Disk Full", severity: "" },
                { name: "Disk_Full", severity: "" },
                { name: "日本", severity: "" },
                { name: "ÄÖ", severity: "" },
            ],
        );

        expect(new Set(groups.map(group => group.key)).size).to.equal(4);
        expect(groups.map(group => group.key)).to.include("Disk_Full");
    });

    it("collects alerts without a name in one group", () => {
        const [group] = groupAlerts([alert(undefined, "info", "2026-10-01T10:00:00Z")], []);
        expect(group.key).to.equal("unnamed");
    });

    it("sorts groups by key and does not modify its input", () => {
        const alerts = [alert("b", "", "2026-10-01T10:00:00Z"), alert("a", "", "2026-10-01T10:00:00Z")];

        expect(groupAlerts(alerts, []).map(group => group.key)).to.deep.equal(["a", "b"]);
        expect(alerts[0].labels.alertname).to.equal("b");
    });
});
