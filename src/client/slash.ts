import type { ActionDescriptor } from '../shared/actions';

/**
 * The slash command surface of the composer, driven by the registry and nothing else.
 *
 * There is deliberately **no second list of commands here**. The composer asks the server for the
 * same typed action descriptors the command palette uses (`/api/actions`), and this module only
 * decides which of them the composer may offer and how the typed text filters them:
 *
 * 1. **Eligible actions.** An action is offered as a slash command when its declared `surfaces`
 *    include `'slash'`. The registry is the one place a surface is declared, so when a build adds
 *    `'slash'` to an action it appears here with no client change. This build's registry declares no
 *    `'slash'` action yet, so the fallback is every action the server offers in the current scope —
 *    which is still the registry's own list, never a hand-written one — and an action that needs
 *    parameters reports the server's own refusal in its own words when it is chosen.
 * 2. **Filtering.** The text after `/` is matched, case-insensitively, against each descriptor's
 *    `id` and `label`, exactly as the palette matches.
 * 3. **Execution.** A chosen action runs through the same `/api/actions/execute` path the palette
 *    calls, in the composer's own project and session scope. Nothing here runs anything itself.
 *
 * `slashMode` is true only while the composer holds a single line that begins with `/`: a message
 * with a newline, or one that does not begin with the slash, is an ordinary message.
 */

/** Whether an action declares the slash surface itself. */
export function declaresSlash(action: ActionDescriptor): boolean {
  return action.surfaces.includes('slash');
}

/**
 * The actions the composer may offer: the registry's own slash-declared actions when any exist,
 * otherwise every action the server offered in this scope (the documented fallback above).
 */
export function slashEligible(actions: readonly ActionDescriptor[]): ActionDescriptor[] {
  const declared = actions.filter(declaresSlash);
  return declared.length > 0 ? declared : [...actions];
}

/** The typed query of a composer text that is in slash mode, or null when it is not. */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  return text.slice(1).trim().toLowerCase();
}

/** The eligible actions whose id or label contains the query, in registry order. */
export function slashMatches(actions: readonly ActionDescriptor[], text: string): ActionDescriptor[] | null {
  const query = slashQuery(text);
  if (query === null) return null;
  return slashEligible(actions).filter(
    (action) => query === '' || action.id.toLowerCase().includes(query) || action.label.toLowerCase().includes(query)
  );
}
