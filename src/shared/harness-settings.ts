import { z } from 'zod';
import { MAX_MODEL_TURNS_CEILING, THINKING_LEVELS, type ThinkingLevel } from './agent';
export type { ThinkingLevel };
export { MAX_MODEL_TURNS_CEILING };

/**
 * The harness settings an owner changes in Pilot, rather than in the container's environment.
 *
 * Two different kinds of setting live here, and the difference is the point:
 *
 * - **Preferences** — the turn bound and the default thinking level — are the owner's, take effect
 *   at the next request, and need no restart.
 * - **Capabilities** — the coding tools, the shell and the bounded file-edit tool — decide whether a
 *   tool *exists in the process*. A stored setting can only ever **disable** one: turning a
 *   capability on stays a deployment decision (`DASHBOARD_CODING_TOOLS`, `DASHBOARD_SHELL`,
 *   `DASHBOARD_FILE_EDIT`), because otherwise a stolen session could give itself a shell. The
 *   effective state is the deployment switch **and** this setting, never either alone.
 */
export const HARNESS_SETTINGS_VERSION = 1 as const;

export interface HarnessPreferences {
  /** How many model requests one dispatch may make in a row. */
  readonly maxModelTurns: number;
  /** The thinking level a new conversation starts with, or null for the host's default. */
  readonly defaultThinking: ThinkingLevel | null;
}
export interface HarnessCapabilityIntent {
  readonly codingTools: boolean;
  readonly shell: boolean;
  readonly fileEdit: boolean;
}
export interface HarnessSettings {
  readonly version: typeof HARNESS_SETTINGS_VERSION;
  readonly preferences: HarnessPreferences;
  readonly capabilities: HarnessCapabilityIntent;
}

export function defaultHarnessSettings(maxModelTurns: number): HarnessSettings {
  return Object.freeze({
    version: HARNESS_SETTINGS_VERSION,
    preferences: Object.freeze({ maxModelTurns, defaultThinking: null }),
    capabilities: Object.freeze({ codingTools: true, shell: true, fileEdit: true })
  });
}

const settingsSchema = z.strictObject({
  version: z.literal(HARNESS_SETTINGS_VERSION),
  preferences: z.strictObject({
    maxModelTurns: z.number().int().min(1).max(MAX_MODEL_TURNS_CEILING),
    defaultThinking: z.enum(THINKING_LEVELS).nullable()
  }),
  capabilities: z.strictObject({
    codingTools: z.boolean(),
    shell: z.boolean(),
    fileEdit: z.boolean()
  })
});

/** The stored shape, validated strictly: an unknown field or an out-of-range bound is refused. */
export function parseHarnessSettings(value: unknown): HarnessSettings {
  return settingsSchema.parse(value);
}

/** What the owner sent: the same shape without the version, which the store owns. */
const inputSchema = z.strictObject({
  preferences: settingsSchema.shape.preferences,
  capabilities: settingsSchema.shape.capabilities
});
export type HarnessSettingsInput = z.infer<typeof inputSchema>;
export function parseHarnessSettingsInput(value: unknown): HarnessSettingsInput {
  return inputSchema.parse(value);
}

/** What one capability really is here: what the deployment offers, what the owner allows, and the
 * result. Reported together, so "the switch is on but the owner disabled it" is never guessed at. */
export interface CapabilityState {
  readonly deployed: boolean;
  readonly allowed: boolean;
  readonly enabled: boolean;
}
export interface HarnessCapabilities {
  readonly codingTools: CapabilityState;
  readonly shell: CapabilityState;
  readonly fileEdit: CapabilityState;
}
export interface HarnessSettingsView {
  readonly revision: number;
  readonly settings: HarnessSettings;
  readonly effective: {
    readonly maxModelTurns: number;
    readonly defaultThinking: ThinkingLevel | null;
    readonly capabilities: HarnessCapabilities;
  };
}

function state(deployed: boolean, allowed: boolean): CapabilityState {
  return Object.freeze({ deployed, allowed, enabled: deployed && allowed });
}

/** The one place a capability's real state is decided, so the interface and the harness agree. */
export function effectiveCapabilities(deployed: HarnessCapabilitiesDeployed, intent: HarnessCapabilityIntent): HarnessCapabilities {
  return Object.freeze({
    codingTools: state(deployed.codingTools, intent.codingTools),
    shell: state(deployed.shell, intent.shell),
    fileEdit: state(deployed.fileEdit, intent.fileEdit)
  });
}
export interface HarnessCapabilitiesDeployed {
  readonly codingTools: boolean;
  readonly shell: boolean;
  readonly fileEdit: boolean;
}
