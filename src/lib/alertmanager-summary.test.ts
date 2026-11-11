import { expect } from "chai";
import type { AlertEntry, SilenceEntry } from "./alertmanager-client";
import { MAX_JSON_ENTRIES, MAX_TEXT_LENGTH, summarizeAlerts, summarizeSilences } from "./alertmanager-summary";

function alert(fingerprint: string, startsAt: string, labels: Record<string, string> = {}): AlertEntry {
    return { fingerprint, startsAt, labels, annotations: {} };
}

describe("alertmanager-summary => summarizeAlerts", () => {
    it("produces compact entries, newest first and independent of the input order", () => {
        const first = alert("a", "2026-10-01T10:00:00.000Z", { alertname: "A", instance: "i", severity: "info" });
        const second = alert("b", "2026-10-02T10:00:00Z", { alertname: "B" });
        const tied = alert("c", "2026-10-02T10:00:00.000Z", { alertname: "C" });

        const summary = summarizeAlerts([first, second, tied]);

        expect(summary.entries.map(entry => entry.fingerprint)).to.deep.equal(["b", "c", "a"]);
        expect(summary.entries).to.deep.equal(summarizeAlerts([tied, first, second]).entries);
        expect(summary.entries[2]).to.deep.equal({
            alertname: "A",
            severity: "info",
            instance: "i",
            summary: "",
            startsAt: "2026-10-01T10:00:00.000Z",
            fingerprint: "a",
        });
    });

    it("caps entries and long texts but keeps the real count", () => {
        const alerts = Array.from({ length: MAX_JSON_ENTRIES + 3 }, (_, index) => ({
            ...alert(String(index), "2026-10-01T10:00:00Z"),
            annotations: { summary: "x".repeat(MAX_TEXT_LENGTH + 10) },
        }));

        const summary = summarizeAlerts(alerts);

        expect(summary.count).to.equal(MAX_JSON_ENTRIES + 3);
        expect(summary.entries).to.have.length(MAX_JSON_ENTRIES);
        expect(summary.entries[0].summary).to.have.length(MAX_TEXT_LENGTH);
    });

    it("does not modify its input", () => {
        const alerts = [alert("a", "2026-10-01T10:00:00Z"), alert("b", "2026-10-02T10:00:00Z")];
        summarizeAlerts(alerts);
        expect(alerts.map(entry => entry.fingerprint)).to.deep.equal(["a", "b"]);
    });
});

describe("alertmanager-summary => summarizeSilences", () => {
    it("sorts by end time and keeps the real count", () => {
        const silence = (id: string, endsAt: string): SilenceEntry => ({
            id,
            matchers: [],
            createdBy: "martin",
            comment: "c",
            startsAt: "2026-10-01T10:00:00Z",
            endsAt,
        });

        const summary = summarizeSilences([
            silence("late", "2026-10-03T10:00:00Z"),
            silence("soon", "2026-10-02T10:00:00Z"),
        ]);

        expect(summary.count).to.equal(2);
        expect(summary.entries.map(entry => entry.id)).to.deep.equal(["soon", "late"]);
    });
});
