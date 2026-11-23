import { randomUUID } from 'node:crypto';
import { ControlStore, ControlStoreError } from './control-store';
import { ForkError, parseForkIdentifier } from '../../shared/forks';
import { readFenceChain } from './fork-fence-validation';

const SESSION = 'fork-creation-fence';
const KIND = 'fork.creation-fence';
type Fence = { readonly version: 1; readonly revision: number; readonly state: 'held' | 'released'; readonly parentSessionId: string; readonly token: string };

/**
 * A durable per-project creation fence. Each revision has a unique control-store key, so competing
 * processes cannot both reserve the next revision. A held fence is never expired or guessed away:
 * a transcript fork may have committed even when its caller did not receive a result.
 */
export class ForkCreationFence {
  constructor(private readonly store: ControlStore) {}

  read(project: string): Fence | null {
    const projectId = parseForkIdentifier(project, 'projectId');
    return readFenceChain(this.store,{projectId,sessionId:SESSION},KIND,'fork-fence.r',input=>{
      const value=input as Partial<Fence>|null;
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='parentSessionId,revision,state,token,version'||value.version!==1||!Number.isSafeInteger(value.revision)||(value.revision??0)<1||(value.state!=='held'&&value.state!=='released')||typeof value.parentSessionId!=='string'||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token))throw Error('invalid fence');
      parseForkIdentifier(value.parentSessionId,'parentSessionId');
      return value as Fence;
    },(held,released)=>held.parentSessionId===released.parentSessionId);
  }

  acquire(project: string, parent: string): Fence {
    const projectId = parseForkIdentifier(project, 'projectId'), parentSessionId = parseForkIdentifier(parent, 'parentSessionId');
    const current = this.read(projectId);
    if (current?.state === 'held') throw new ForkError('A fork creation is in progress or requires operator review; nothing was created.', 'CONFLICT');
    return this.write(projectId, { version: 1, revision: (current?.revision ?? 0) + 1, state: 'held', parentSessionId, token: randomUUID() });
  }

  release(project: string, held: Fence): void {
    const projectId = parseForkIdentifier(project, 'projectId'), current = this.read(projectId);
    if (!current || current.state !== 'held' || current.revision !== held.revision || current.token !== held.token)
      throw new ForkError('The fork creation fence changed; it remains subject to operator review.', 'CONFLICT');
    this.write(projectId, { ...current, revision: current.revision + 1, state: 'released' });
  }

  /** All sessions other than the known parent fail closed until the exact creation settles. */
  assertDispatchable(project: string, session: string): void {
    const current = this.read(project);
    if (current?.state === 'held' && current.parentSessionId !== session)
      throw new ForkError('A fork creation is in progress or requires operator review; this session cannot dispatch.', 'CONFLICT');
  }

  private write(projectId: string, fence: Fence): Fence {
    try {
      const result = this.store.admit({ scope: { projectId, sessionId: SESSION }, idempotencyKey: 'fork-fence.r' + fence.revision, kind: KIND, input: fence, outbox: { kind: KIND, payload: { version: 1, revision: fence.revision } } });
      if (result.existing) throw new ForkError('Another fork creation changed the fence; retry after review.', 'CONFLICT');
      return fence;
    } catch (error) {
      if (error instanceof ForkError) throw error;
      if (error instanceof ControlStoreError && error.code === 'CONFLICT') throw new ForkError('Another fork creation changed the fence; retry after review.', 'CONFLICT');
      throw new ForkError('The fork creation fence could not be recorded; dispatch is refused.', 'STORAGE');
    }
  }
}
