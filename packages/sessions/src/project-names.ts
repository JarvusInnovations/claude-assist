/**
 * Normalize project paths to canonical display names.
 *
 * Handles worktrees, subdirectories, cross-machine home paths, etc.
 * Operates on a batch of paths so it can discover repo roots across the set.
 */

/** Home directory patterns — strip to get relative paths */
const HOME_PATTERN = /^\/(?:Users|home)\/\w+\//;

/** Known repo root containers (immediately under home) */
const REPO_CONTAINERS = new Set(['Repositories', 'repos']);

/** Worktree patterns that extract a repo name directly */
const WORKTREE_PATTERNS = [
  /\/conductor\/workspaces\/([^/]+)/,   // conductor/workspaces/<repo>/<worktree>
  /\.claude-worktrees\/([^/]+)/,         // .claude-worktrees/<repo>/<worktree>
];

/**
 * Build a mapping from raw project paths to display names.
 *
 * Strategy:
 * 1. Extract repo name from worktree patterns
 * 2. Identify repo roots: ~/Repositories/<repo> and ~/<repo> paths
 * 3. Collapse any path that is a subdirectory of a known repo root
 */
export function normalizeProjectPaths(paths: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const uniquePaths = new Set(paths);

  // Phase 1: handle worktree patterns (these always resolve to a repo name)
  const remaining = new Set<string>();
  for (const path of uniquePaths) {
    let matched = false;
    for (const pattern of WORKTREE_PATTERNS) {
      const m = path.match(pattern);
      if (m) {
        result.set(path, m[1]!);
        matched = true;
        break;
      }
    }
    if (!matched) remaining.add(path);
  }

  // Phase 2: normalize remaining paths to home-relative form
  const homeRelative = new Map<string, string>();
  for (const path of remaining) {
    const rel = path.replace(HOME_PATTERN, '');
    homeRelative.set(path, rel);
  }

  // Phase 3: identify repo roots
  const repoRoots = new Set<string>();
  for (const rel of homeRelative.values()) {
    const parts = rel.split('/');
    if (parts.length >= 2 && REPO_CONTAINERS.has(parts[0]!)) {
      repoRoots.add(parts[0] + '/' + parts[1]);
    } else if (parts[0]) {
      repoRoots.add(parts[0]);
    }
  }

  // Phase 4: for each remaining path, find its repo root and use that as the name
  for (const [path, rel] of homeRelative) {
    let bestRoot = '';
    for (const root of repoRoots) {
      if ((rel === root || rel.startsWith(root + '/')) && root.length > bestRoot.length) {
        bestRoot = root;
      }
    }

    if (bestRoot) {
      const parts = bestRoot.split('/');
      result.set(path, parts[parts.length - 1]!);
    } else {
      result.set(path, rel || path);
    }
  }

  return result;
}
