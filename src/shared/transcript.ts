import type { AgentEntry } from './agent';

/**
 * How a transcript is laid out for reading.
 *
 * A turn of real work produces one entry per tool result, so a busy session is mostly single-line
 * tool rows. Rendering them flat pushes the conversation itself off the screen, so a run of two or
 * more consecutive tool results is folded into one closed group; a lone tool result stays as it was,
 * and nothing is hidden that a person cannot open.
 *
 * This is deliberately pure: the filter that decides what is worth rendering and the folding rule
 * live here, so the interface only maps rows to markup and the rule is testable on its own.
 */
export type TranscriptEntry = AgentEntry;

export type TranscriptRow =
  | { readonly kind: 'one'; readonly entry: TranscriptEntry }
  | { readonly kind: 'tools'; readonly id: string; readonly entries: TranscriptEntry[] };

/** Whether an entry has anything to show: text, reasoning, a tool, an image or an error. */
export function transcriptEntryShown(entry: TranscriptEntry): boolean {
  return Boolean(entry.text || entry.thinking || (entry.tools && entry.tools.length) || (entry.images && entry.images.length) || entry.error);
}

/** The rows for one transcript, in order, with runs of tool results folded together. */
export function transcriptRows(entries: readonly TranscriptEntry[]): TranscriptRow[] {
  const shown = entries.filter(transcriptEntryShown);
  const rows: TranscriptRow[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const entry = shown[index];
    if (entry.kind === 'tool') {
      const run = [entry];
      while (index + 1 < shown.length && shown[index + 1].kind === 'tool') {
        index += 1;
        run.push(shown[index]);
      }
      if (run.length > 1) {
        rows.push({ kind: 'tools', id: 'tool-run-' + run[0].id, entries: run });
        continue;
      }
    }
    rows.push({ kind: 'one', entry });
  }
  return rows;
}
