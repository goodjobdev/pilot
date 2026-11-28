import { randomUUID } from 'node:crypto';
import { ControlStore, ControlStoreError } from './control-store';
import { ForkError, parseForkIdentifier } from '../../shared/forks';
import { readFenceChain } from './fork-fence-validation';

const KIND = 'fork.lifecycle-fence';
type Fence = { readonly version: 1; readonly revision: number; readonly state: 'held' | 'released'; readonly token: string };

/** A durable per-child lifecycle reservation, shared by resume, discard and dispatch admission. */
export class ForkLifecycleFence {
  constructor(private readonly store: ControlStore) {}

  read(project: string, child: string): Fence | null {
    const projectId = parseForkIdentifier(project, 'projectId'), sessionId = parseForkIdentifier(child, 'childSessionId');
    return readFenceChain(this.store,{projectId,sessionId},KIND,'fork-lifecycle.r',input=>{
      const value=input as Partial<Fence>|null;
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='revision,state,token,version'||value.version!==1||!Number.isSafeInteger(value.revision)||(value.revision??0)<1||(value.state!=='held'&&value.state!=='released')||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token))throw Error('invalid fence');
      return value as Fence;
    },()=>true);
  }

  acquire(project: string, child: string): Fence {
    const current = this.read(project, child);
    if (current?.state === 'held') throw new ForkError('A fork lifecycle operation is in progress or requires operator review.', 'CONFLICT');
    return this.write(project, child, { version: 1, revision: (current?.revision ?? 0) + 1, state: 'held', token: randomUUID() });
  }

  release(project: string, child: string, held: Fence): void {
    const current = this.read(project, child);
    if (!current || current.state !== 'held' || current.revision !== held.revision || current.token !== held.token)
      throw new ForkError('The fork lifecycle fence changed; operator review is required.', 'CONFLICT');
    this.write(project, child, { ...current, revision: current.revision + 1, state: 'released' });
  }

  assertDispatchable(project: string, child: string, heldToken?: string): void {
    const fence = this.read(project, child);
    if (fence?.state === 'held' && fence.token !== heldToken)
      throw new ForkError('A fork operation is in progress or requires operator review; this session cannot dispatch.', 'CONFLICT');
  }

  private write(project: string, child: string, fence: Fence): Fence {
    const projectId = parseForkIdentifier(project, 'projectId'), sessionId = parseForkIdentifier(child, 'childSessionId');
    try {
      const result = this.store.admit({ scope: { projectId, sessionId }, idempotencyKey: 'fork-lifecycle.r' + fence.revision, kind: KIND, input: fence, outbox: { kind: KIND, payload: { version: 1, revision: fence.revision } } });
      if (result.existing) throw new ForkError('Another fork lifecycle operation changed the fence.', 'CONFLICT');
      return fence;
    } catch (error) {
      if (error instanceof ForkError) throw error;
      if (error instanceof ControlStoreError && error.code === 'CONFLICT') throw new ForkError('Another fork lifecycle operation changed the fence.', 'CONFLICT');
      throw new ForkError('The fork lifecycle fence could not be recorded; dispatch is refused.', 'STORAGE');
    }
  }
}
