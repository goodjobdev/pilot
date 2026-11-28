import { PrivateStore } from './private-store';
import { HttpError } from './board-store';
import {
  defaultHarnessSettings,effectiveCapabilities,parseHarnessSettings,parseHarnessSettingsInput,
  MAX_OUTPUT_TOKENS_DEFAULT,
  type HarnessCapabilities,type HarnessCapabilitiesDeployed,type HarnessSettings,type HarnessSettingsInput,type HarnessSettingsView,
  type ThinkingLevel
} from '../shared/harness-settings';

/**
 * The owner's harness settings, stored as one private JSON file beside the other settings.
 *
 * Every write is revision-checked: the caller sends the revision it read, and a mismatch is a
 * conflict that changes nothing, exactly like a board or document edit. The store keeps one number
 * per write, so a stale browser cannot overwrite a change made in another tab.
 */
export class HarnessSettingsStore {
  private store: PrivateStore<{ revision: number; settings: HarnessSettings }>;
  constructor(root: string, private deployed: HarnessCapabilitiesDeployed, private startBound: number, private startOutputTokens = MAX_OUTPUT_TOKENS_DEFAULT) {
    this.store = new PrivateStore(root, 'settings/harness.json',
      () => ({ revision: 1, settings: defaultHarnessSettings(this.startBound, this.startOutputTokens) }),
      value => {
        const parsed = value as { revision?: unknown; settings?: unknown };
        if (typeof parsed?.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1)
          throw Error('Harness settings have no valid revision');
        return { revision: parsed.revision, settings: parseHarnessSettings(parsed.settings) };
      });
  }
  /** The settings as stored, with what each capability really is on this instance. */
  async view(): Promise<HarnessSettingsView> {
    const { revision, settings } = await this.store.read();
    const capabilities: HarnessCapabilities = effectiveCapabilities(this.deployed, settings.capabilities);
    return Object.freeze({
      revision,
      settings,
      effective: Object.freeze({
        maxModelTurns: settings.preferences.maxModelTurns,
        maxOutputTokens: settings.preferences.maxOutputTokens,
        defaultThinking: settings.preferences.defaultThinking,
        capabilities
      })
    });
  }
  /** The bound in force, read per dispatch so a change applies to the next request. */
  async maxModelTurns(): Promise<number> { return (await this.store.read()).settings.preferences.maxModelTurns; }
  /** How many tokens one request may produce, reasoning included. Also read per dispatch. */
  async maxOutputTokens(): Promise<number> { return (await this.store.read()).settings.preferences.maxOutputTokens; }
  /** The thinking level a new conversation starts with, or null for the host's default. */
  async defaultThinking(): Promise<ThinkingLevel | null> {
    return (await this.store.read()).settings.preferences.defaultThinking;
  }
  /** Whether one capability is enabled: the deployment's switch and the owner's setting together. */
  async capability(name: keyof HarnessCapabilitiesDeployed): Promise<boolean> {
    const { settings } = await this.store.read();
    return effectiveCapabilities(this.deployed, settings.capabilities)[name].enabled;
  }
  /** Replace the settings a caller read at `revision`; a stale revision is a conflict. */
  async update(input: { revision: unknown; settings: unknown }): Promise<HarnessSettingsView> {
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new HttpError(422, 'The harness settings request must carry the revision it read');
    let next: HarnessSettingsInput;
    try { next = parseHarnessSettingsInput(input.settings); }
    catch (error) { throw new HttpError(422, 'The harness settings are invalid: ' + (error as Error).message); }
    await this.store.update(async value => {
      if (value.revision !== input.revision) throw new HttpError(409, 'Harness settings changed since you read them. Reload and review; nothing was written.');
      value.revision += 1;
      value.settings = { version: 1, preferences: next.preferences, capabilities: next.capabilities };
      return value;
    });
    return this.view();
  }
  async drain() { await this.store.drain(); }
}
