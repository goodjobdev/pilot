import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createReadTool, createWriteTool, createBashTool } from '@earendil-works/pi-durable/tools';
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { resolve,relative,isAbsolute } from 'node:path';
import { HttpError } from '../board-store';

/**
 * The coding tools: `read`, `write` and `bash`, the same tools a person gets at a terminal running
 * Pi, installed into this project's agent harness **only** when the owner has switched them on and
 * **only** for a connected repository worktree.
 *
 * What this module does and does not promise, because the difference decides whether the owner
 * should grant it:
 *
 * - `read` and `write` are bounded to the connected worktree. Every path a model supplies is
 *   resolved against the worktree root and refused when it leaves it or traverses a symlink, using
 *   the same contained-path helper every other read and write in this application uses.
 * - `bash` is **not** contained. It runs through the environment's shell as the application user,
 *   which means it can read and write anything that user can reach: every project's files in the
 *   data volume, the durable control store, and the unencrypted credentials directory. That is why
 *   it has its own switch and its own scope, and why the vocabulary reports it in those words.
 * - No tool here inspects, filters or blacklists a command. A pattern list that pretends to make a
 *   shell safe would be worse than useless: it would be a claim this code cannot keep.
 *
 * `edit` is deliberately not installed here. The bounded file-edit tool owns that name and stays
 * governed by the acceptance policy in force, so propose-only keeps meaning something even when
 * these direct-write tools are granted.
 */
export interface CodingToolOptions {
  /** The connected worktree root every path must stay inside. */
  readonly root: string;
  /** Whether `bash` is installed. `read` and `write` are installed whenever this module is used. */
  readonly shell: boolean;
}

/** The refusal every path outside the worktree gets, worded for a model to act on. */
const outside = (path: string): never => {
  throw new HttpError(403, 'The path ' + JSON.stringify(path) + ' is not inside this project\u2019s connected repository worktree. Use a path relative to the worktree root.');
};

/**
 * Whether a client-supplied path resolves inside the worktree, as a pure check: absolute paths are
 * allowed only when they already resolve inside the root, `..` cannot climb out, and the caller
 * performs the contained-path check (which also refuses symlinks) before any file is touched.
 */
export function insideWorktree(root: string, path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false;
  if (path.includes('\0')) return false;
  const base = resolve(root);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** One tool, with its paths checked against the worktree before the tool body runs. */
function contained(root: string, tool: ToolRegistration): ToolRegistration {
  const execute = tool.execute as (args: unknown, api: unknown, context: Context) => Promise<unknown>;
  return {
    ...tool,
    execute: async (args: unknown, api: unknown, context: Context) => {
      const path = (args as { path?: unknown }).path;
      if (typeof path !== 'string' || !insideWorktree(root, path)) outside(String(path));
      return execute(args, api, context);
    }
  } as unknown as ToolRegistration;
}

/**
 * The coding-tool extension for one project. The tools are the ordinary Pi tools; the containment
 * above and the worktree-rooted environment below are what make them this application's tools.
 */
export function codingTools(options: CodingToolOptions): { readonly extension: Extension; readonly env: (target: unknown, context: Context) => NodeExecutionEnv } {
  const read: Extension = {
    name: 'coding-tools-read',
    tools: [contained(options.root, createReadTool() as unknown as ToolRegistration)]
  };
  const write: Extension = {
    name: 'coding-tools-write',
    tools: [contained(options.root, createWriteTool() as unknown as ToolRegistration)]
  };
  const extensions: Extension[] = [read, write];
  if (options.shell) {
    extensions.push({
      name: 'coding-tools-shell',
      tools: [createBashTool({
        // The command runs with the worktree as its working directory, which the environment below
        // already establishes. Nothing here rewrites or inspects the command: the switch and the
        // scope are the decision, and the transcript is the record.
        prepare: (execution) => { execution.cwd = options.root; }
      })]
    });
  }
  return {
    extension: extensions.reduce<Extension>((merged, extension) => ({
      name: 'coding-tools',
      tools: [...(merged.tools ?? []), ...(extension.tools ?? [])]
    }), { name: 'coding-tools', tools: [] }),
    // A fresh environment per use, rooted at the worktree. `read` and `write` resolve relative
    // paths against it, and `bash` starts there.
    env: () => new NodeExecutionEnv({ cwd: options.root })
  };
}

/** The tools this module installs for one capability set, for the prompt and for the audit trail. */
export function codingToolNames(shell: boolean): readonly string[] {
  return shell ? ['read', 'write', 'bash'] : ['read', 'write'];
}
