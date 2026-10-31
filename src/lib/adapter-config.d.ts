// This file extends the AdapterConfig type from "@iobroker/types"

import type { RawSourceConfig } from "./source-config";

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Base URL of the Prometheus server, e.g. http://host:9090 */
            url: string;
            /** HTTP request timeout in seconds for all Prometheus API calls */
            requestTimeout: number;
            /** Optional basic auth user name applied to all sources */
            username: string;
            /** Optional basic auth password applied to all sources (encrypted) */
            password: string;
            /** Configured Prometheus sources as entered in the Admin UI */
            sources: RawSourceConfig[];
            /** Whether the /metrics pull exporter is active */
            exporterEnabled: boolean;
            /** TCP port of the /metrics endpoint */
            port: number;
            /** Bind address of the /metrics endpoint */
            bind: string;
            /** Whether alerts and silences are read from an Alertmanager */
            alertmanagerEnabled: boolean;
            /** Base URL of the Alertmanager, e.g. http://host:9093 */
            alertmanagerUrl: string;
            /** Optional basic auth user name of the Alertmanager */
            alertmanagerUsername: string;
            /** Optional basic auth password of the Alertmanager (encrypted) */
            alertmanagerPassword: string;
            /** Poll interval of the Alertmanager in seconds */
            alertmanagerPollInterval: number;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
