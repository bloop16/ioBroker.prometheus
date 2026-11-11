import { expect } from "chai";
import tls from "node:tls";
import { buildHttpsAgent, parseCaCertificates, tlsSettingsFromMessage } from "./tls-options";

// Self-signed test certificates (no private keys), only used by these tests

const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUL8QRrTZa1vJSP9VzvuZOrYjNz+0wDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMVGVzdCBSb290IENBMB4XDTI2MTExMTE3MzMwMloXDTM2
MTEwODE3MzMwMlowFzEVMBMGA1UEAwwMVGVzdCBSb290IENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAilMRBNne8kQ5fyaqY93fF4vIG2b5EGAGiDKw
0+qvbAye5DxnMhvYFYimAC9lGePa72FwgVhVq9AnIUBHe7BRXk+arjQ6bMtUfc7F
/WHj/zibd1xxSs3Xa0GF+LW6ikKoOL5g2TLlqkBQWC8nEaceT/8RCxzVOXaHlZjV
Qf6eeRaKkXm58wuGUivU6GS7H1cxFFRArec+3gd9Ff59PTSQJshsWWLrWLG3rBjN
LLCCQaqyo8gwquHG9vHXCT/ptCwOffAe6ZFHpGdp4cMPgN+gKU+VTUBzJKuQnop8
4ok8DAtxzS6cP/9e6qapXfjFXMGMUfS75wZZOWzYGYHXESQUxQIDAQABo1MwUTAd
BgNVHQ4EFgQUXyqgnUNiNTs8e+bBDJyWQ1xQqggwHwYDVR0jBBgwFoAUXyqgnUNi
NTs8e+bBDJyWQ1xQqggwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAM+iG5RLfqxTEN62fMSCqc7tSXZDGQOmy6ytZJ0GGN2zSVF2EKDhvr6eCVKG4
Bs1uittKo7xhNzBc/O6mX2IlIlUQRy2jUc4Ro0sZ5J6gPdpPtwIZdAJdP+2wI75h
a7CyrU+eWTXZ0B7GwknY0Te0tpkhRVY9/SbPFpGSPri3JxxW37/Sh+LGw7p2dvoz
znW+3I2kzHHdGo+1PGjV6WI1bbBBlPlia1k1pAcKd/YnWGbe+lnmeYcYKtGVJvNb
8suJOXZKT7H1mCJMICSrKjoIw+vH3ss6Sklx28BUQFzQs+d4EKjoBt97q9ZZrJH+
vVo7XBbOX0uyjZbfEc7DCIB1+g==
-----END CERTIFICATE-----`;

const SECOND_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUZCqmFS+8ynDI20MvYvzM3XezO3UwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNVGVzdCBJbnRlciBDQTAeFw0yNjExMTExNzMzMDJaFw0z
NjExMDgxNzMzMDJaMBgxFjAUBgNVBAMMDVRlc3QgSW50ZXIgQ0EwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDLqqBC2jZgq2E7k3lF4KLGD3rQ0erBOmaO
XdXCcmbDwSComMkK+dnZyTopczQM3FCO8XX+BNkJV/P27lpnf76S7qrUl0Xgh4OK
NAkg3y2By5bTR///LIZ/LAl4BR4iiqhNwyXeCqD+agaO/PkeVKvX1lFrYoUIN1Jf
9l0GEBOu3/QwSs0DUEhEU/YBMQT+fWLXb1ZmcWwY/dJ/j3+TVR/26488OPI00Xd2
bcFY44VuPPxTtsVNQCsAZERKjKt/IDY7L716k7booZWPFjDoG7ejF6a+mExfYonL
PLALiKF1vI6JxeVk4EU16jXobsF1N7BwF/7d5SZr8eA+e6alvVrxAgMBAAGjUzBR
MB0GA1UdDgQWBBSFE2ajCKzsycUDPJD6lZh+1RctXjAfBgNVHSMEGDAWgBSFE2aj
CKzsycUDPJD6lZh+1RctXjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBoIQN9+oMGWT6yNKCPnDgtj/jM6jtWEYA097PUclMz9wN5gfZgxiR4j0aP
WjI7Lo8ECeH5SYRMBwJG9S5hScJf6zTE0gewXFPeLeUaQDzEmN2VLHX35zRNCYWa
W8Vd+6Cr8nYqtfNGDxyV5L9Te+CmYXiDefVaahAMGSUGDVNaK6LyIh+uthrM+SqC
Qj+idPqJ6GeV58lw9RZjEdOMb33nGjnae3zNeLHVakpsUHBkeW/iyk5NCZl+OEYi
6+18Xy0qihtkxkRAqMomOlsNd5gnY1w1cOht/DGMspVxPMQomtNN0zpZLFqvZBjh
kUpHCA+gAmRdMV4jBxEK6jWDusPw
-----END CERTIFICATE-----`;

describe("tls-options => parseCaCertificates", () => {
    it("returns an empty list for empty input", () => {
        expect(parseCaCertificates(undefined)).to.deep.equal([]);
        expect(parseCaCertificates("")).to.deep.equal([]);
        expect(parseCaCertificates("   \n ")).to.deep.equal([]);
    });

    it("extracts a single certificate", () => {
        const certs = parseCaCertificates(`\n${TEST_CA_PEM}\n`);
        expect(certs).to.have.length(1);
        expect(certs[0]).to.equal(TEST_CA_PEM.trim());
    });

    it("extracts every certificate of a bundle", () => {
        const certs = parseCaCertificates(`${TEST_CA_PEM}\n${SECOND_CA_PEM}`);
        expect(certs).to.deep.equal([TEST_CA_PEM.trim(), SECOND_CA_PEM.trim()]);
    });

    it("accepts Windows line endings", () => {
        const certs = parseCaCertificates(TEST_CA_PEM.replace(/\n/g, "\r\n"));
        expect(certs).to.have.length(1);
    });

    it("rejects text without a PEM certificate block", () => {
        expect(() => parseCaCertificates("not a certificate")).to.throw(/no PEM certificate/i);
    });

    it("rejects a PEM block with broken content", () => {
        const broken = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
        expect(() => parseCaCertificates(broken)).to.throw(/invalid CA certificate/i);
    });
});

describe("tls-options => buildHttpsAgent", () => {
    it("returns undefined when nothing is configured", () => {
        expect(buildHttpsAgent({})).to.equal(undefined);
        expect(buildHttpsAgent({ caCert: "", allowInsecureTls: false })).to.equal(undefined);
    });

    it("keeps the default root certificates when adding a custom CA", () => {
        const agent = buildHttpsAgent({ caCert: TEST_CA_PEM });
        const ca = agent?.options.ca as string[];
        expect(ca).to.include(TEST_CA_PEM.trim());
        expect(ca).to.include.members([...tls.rootCertificates]);
        expect(agent?.options.rejectUnauthorized).to.equal(true);
    });

    it("disables certificate verification only when explicitly allowed", () => {
        const agent = buildHttpsAgent({ allowInsecureTls: true });
        expect(agent?.options.rejectUnauthorized).to.equal(false);
        expect(agent?.options.ca).to.equal(undefined);
    });

    it("throws on an invalid CA certificate", () => {
        expect(() => buildHttpsAgent({ caCert: "garbage" })).to.throw();
    });
});

describe("tls-options => tlsSettingsFromMessage", () => {
    it("returns undefined when the message carries no TLS values", () => {
        expect(tlsSettingsFromMessage({ url: "https://prom:9090" })).to.equal(undefined);
    });

    it("reads the CA certificate and the insecure flag", () => {
        expect(tlsSettingsFromMessage({ caCert: TEST_CA_PEM, allowInsecureTls: true })).to.deep.equal({
            caCert: TEST_CA_PEM,
            allowInsecureTls: true,
        });
    });

    it("accepts the insecure flag as string and ignores non-string CA values", () => {
        expect(tlsSettingsFromMessage({ caCert: 42, allowInsecureTls: "true" })).to.deep.equal({
            caCert: undefined,
            allowInsecureTls: true,
        });
        expect(tlsSettingsFromMessage({ caCert: "", allowInsecureTls: "false" })).to.deep.equal({
            caCert: "",
            allowInsecureTls: false,
        });
    });
});
