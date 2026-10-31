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

    it("sanitizes the key but keeps the display name", () => {
        const [group] = groupAlerts([alert("Disk.Full 1", "info", "2026-10-01T10:00:00Z")], []);

        expect(group.key).to.equal("Disk_Full_1");
        expect(group.name).to.equal("Disk.Full 1");
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
