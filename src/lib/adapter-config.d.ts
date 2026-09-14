// This file extends the AdapterConfig type from "@iobroker/types"

import type { RawSourceConfig } from "./source-config";

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** HTTP request timeout in seconds for all Prometheus API calls */
            requestTimeout: number;
            /** Optional basic auth user name applied to all sources */
            username: string;
            /** Optional basic auth password applied to all sources (encrypted) */
            password: string;
            /** Configured Prometheus sources as entered in the Admin UI */
            sources: RawSourceConfig[];
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
