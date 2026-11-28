/** Opener chains let a newer dialog return focus if its older opener is removed first. */
const openerChains = new WeakMap<HTMLDialogElement, HTMLElement[]>();

/** Close native modals before Svelte removes them so browsers restore the opener's focus. */
export function showModalWithFocusReturn(dialog: HTMLDialogElement): () => void {
 const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
 const openerDialog = opener?.closest('dialog[open]') as HTMLDialogElement | null;
 const chain = [...(opener ? [opener] : []), ...(openerDialog ? openerChains.get(openerDialog) ?? [] : [])];
 openerChains.set(dialog, chain);
 dialog.showModal();
 return () => {
  const another = [...document.querySelectorAll('dialog[open]')].some(other => other !== dialog);
  const parent = opener?.closest('dialog[open]');
  const childOfOpenDialog = !!parent && parent !== dialog;
  const current = document.activeElement;
  const returnFocus = (!another || childOfOpenDialog) && (current === document.body || current === dialog || dialog.contains(current));
  // Do not explicitly close an older modal while an unrelated newer modal is active.
  if (dialog.open && (!another || childOfOpenDialog)) dialog.close();
  const remaining = [...document.querySelectorAll('dialog[open]')];
  if (returnFocus) {
   const target=chain.find(candidate=>candidate.isConnected&&!candidate.closest('[hidden],[inert]') &&
    (remaining.length===0||remaining.every(other=>other.contains(candidate))));
   target?.focus();
  }
  openerChains.delete(dialog);
 };
}
