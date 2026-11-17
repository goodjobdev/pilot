/** Trusted marker for a fork-action refusal produced before the host invokes conversation.submit. */
export class ForkDispatchNotStarted extends Error {
  constructor() {
    super('Fork dispatch was refused before conversation submission; no input was submitted.');
    this.name = 'ForkDispatchNotStarted';
  }
}
