/**
 * Normalizes and validates the Alertmanager settings from the Admin UI.
 */

import { clampPollIntervalMs, validateUrl } from "./source-config";

/** The Alertmanager settings as stored in the adapter configuration */
export interface RawAlertmanagerConfig {
    /** Base URL as entered */
    url?: string;
    /** Poll interval in seconds */
    pollInterval?: unknown;
}

/** Validated Alertmanager settings */
export interface NormalizedAlertmanagerConfig {
    /** Validated base URL */
    url: string;
    /** Poll interval in milliseconds */
    pollIntervalMs: number;
}

/**
 * Validates the Alertmanager settings
 *
 * @param raw - The settings from the adapter configuration
 * @returns The validated settings, or undefined if they are unusable
 */
export function normalizeAlertmanagerConfig(raw: RawAlertmanagerConfig): NormalizedAlertmanagerConfig | undefined {
    const url = validateUrl(raw.url?.trim());
    return url ? { url, pollIntervalMs: clampPollIntervalMs(raw.pollInterval) } : undefined;
}
