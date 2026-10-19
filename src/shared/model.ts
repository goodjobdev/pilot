import type { DocRef } from './docs';

export type Status = 'todo' | 'doing' | 'done' | 'blocked';
export type Scope = 'active' | 'deferred' | 'design-only' | 'historical';
export interface Domain { id: string; name: string; color: string }
export interface Milestone { id: string; name: string; order: number }
export interface Gate { id: string; label: string; state: 'open' | 'satisfied'; evidence: string }
export interface Source { id: string; name: string; path: string; locator: string; fingerprint: string; captured: string }
export interface Task { id: string; title: string; description: string; domain: string; tags: string[]; milestone: string | null; status: Status; scope: Scope; acceptance: string; gates: Gate[]; sources: string[]; specs: DocRef[]; archived: boolean }
export interface Relationship { id: string; source: string; target: string; kind: 'blocks' | 'related' }
export interface Placement { x: number; y: number; pinned: boolean }
export interface Board { version: 1; adoption: 'mirror' | 'adopted'; domains: Domain[]; milestones: Milestone[]; tasks: Task[]; relationships: Relationship[]; sources: Source[]; layout: Record<string, Placement>; summary: string }
export interface Project { id: string; name: string; path: string; managed: boolean; repository: string; created: string; state?: 'available' | 'missing' | 'read-only' }
export interface Snapshot { board: Board; revision: string }
export type Operation =
  | { op: 'putTask'; task: Task }
  | { op: 'removeTask'; id: string; confirmEdges: boolean }
  | { op: 'putEdge'; edge: Relationship }
  | { op: 'removeEdge'; id: string }
  | { op: 'layout'; positions: Record<string, Placement> }
  | { op: 'metadata'; domains: Domain[]; milestones: Milestone[] }
  | { op: 'adopt' }
  | { op: 'restore'; board: Board };

export const domains: Domain[] = [
  ['storage','Storage','#a78bfa'],['sync','Sync','#22d3ee'],['backend','Backend','#818cf8'],
  ['frontend','Frontend / UI','#fb923c'],['desktop','Desktop','#34d399'],
  ['mobile','Mobile','#f472b6'],['devices','Devices','#facc15'],['release','Release / Ops','#94a3b8']
].map(([id,name,color]) => ({id,name,color}));
export function emptyBoard(): Board { return {version:1,adoption:'mirror',domains: structuredClone(domains),milestones:[],tasks:[],relationships:[],sources:[],layout:{},summary:''}; }
export function newTask(id: string, title = 'New task'): Task { return {id,title,description:'',domain:'backend',tags:[],milestone:null,status:'todo',scope:'active',acceptance:'',gates:[],sources:[],specs:[],archived:false}; }
