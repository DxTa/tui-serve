// Agent session ID extraction
// Each coding agent stores session IDs differently.
// This module reads the agent's internal session ID
// so we can resume after a crash.

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();

// ── CWD encoding helpers ──
// pi encodes: -- + cwd (with / → -) + --
// claude encodes: - + cwd (with / → - and . → -) 

function encodeCwdPi(cwd: string): string {
  const relative = cwd.startsWith('/') ? cwd.slice(1) : cwd;
  // Pi encodes path separators as dashes but preserves dots in path segments.
  // Example: /home/dxta/.dotfiles -> --home-dxta-.dotfiles--
  const encoded = relative.replace(/\//g, '-');
  return `--${encoded}--`;
}

function encodeCwdClaude(cwd: string): string {
  const relative = cwd.startsWith('/') ? cwd.slice(1) : cwd;
  const encoded = relative.replace(/\//g, '-').replace(/\./g, '-');
  return `-${encoded}`;
}

// ── Per-agent extraction ──

function parsePiTimestampFromFilename(name: string): number | null {
  const tsMatch = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
  if (!tsMatch) return null;
  const isoTs = tsMatch[1]
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const fileTimeMs = new Date(isoTs).getTime();
  return isNaN(fileTimeMs) ? null : fileTimeMs;
}

function readPiSessionCandidates(cwd: string): Array<{ id: string; fileTimeMs: number; mtimeMs: number; fileName: string }> {
  const encoded = encodeCwdPi(cwd);
  const sessionsDir = join(HOME, '.pi', 'agent', 'sessions', encoded);
  if (!existsSync(sessionsDir)) return [];

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
    .sort((a, b) => b.name.localeCompare(a.name));

  const candidates: Array<{ id: string; fileTimeMs: number; mtimeMs: number; fileName: string }> = [];
  for (const entry of entries) {
    const file = join(sessionsDir, entry.name);
    try {
      const firstLine = readFileSync(file, 'utf-8').split('\n')[0];
      const header = JSON.parse(firstLine);
      if (!header.id || (header.cwd && header.cwd !== cwd)) continue;
      const fileTimeMs = parsePiTimestampFromFilename(entry.name);
      if (fileTimeMs === null) continue;
      candidates.push({ id: header.id, fileTimeMs, mtimeMs: statSync(file).mtimeMs, fileName: entry.name });
    } catch { continue; }
  }
  return candidates;
}

function extractPiSessionId(cwd: string, createdAt?: string): string | null {
  try {
    const candidates = readPiSessionCandidates(cwd);

    // Strategy 1: If createdAt is provided, find the .jsonl file whose timestamp
    // is closest to the tmux session creation time. This works because when Pi
    // starts a FRESH session (no --session flag), it creates a new .jsonl file
    // within seconds of the tmux session being created.
    //
    // This strategy FAILS for resumed sessions where Pi reuses an older .jsonl
    // file (via --session <id>), but those sessions should already have their
    // agentSessionId set via opts.resumeFrom and shouldn't need extraction.
    if (createdAt && candidates.length > 0) {
      const createdMs = new Date(createdAt).getTime();
      if (!isNaN(createdMs)) {
        // Sort candidates by distance to creation time (ascending)
        const sorted = [...candidates].sort((a, b) =>
          Math.abs(a.fileTimeMs - createdMs) - Math.abs(b.fileTimeMs - createdMs)
        );
        const closest = sorted[0];
        // The .jsonl file should be created within ±10 seconds of the tmux session.
        // Allow wider buffer for slow startup but prefer tight matches.
        if (Math.abs(closest.fileTimeMs - createdMs) < 10_000) {
          return closest.id;
        }
      }
    }

    // Strategy 2: Most recently modified file in the directory. When Pi is
    // actively running, it continuously writes to its .jsonl file. The file
    // that was most recently modified (by mtime) is likely the one being used
    // by a currently-running Pi session. If multiple Pi sessions run in the
    // same cwd, each writes to its own file, and the most recently active one
    // has the most recent mtime.
    //
    // This is a heuristic and may return the wrong ID if multiple sessions
    // are active. It's used as a fallback when Strategy 1 doesn't apply.
    for (const candidate of candidates) {
      // candidates are sorted newest-first by filename timestamp
      return candidate.id;
    }
    return null;
  } catch {
    return null;
  }
}

function extractPiSessionIdAfter(cwd: string, afterMs: number, excludeId?: string): string | null {
  try {
    const candidates = readPiSessionCandidates(cwd)
      .filter(c => c.id !== excludeId)
      .filter(c => c.fileTimeMs >= afterMs - 1000 || c.mtimeMs >= afterMs - 1000)
      .sort((a, b) => Math.max(b.fileTimeMs, b.mtimeMs) - Math.max(a.fileTimeMs, a.mtimeMs));

    return candidates[0]?.id || null;
  } catch {
    return null;
  }
}

function extractClaudeSessionId(cwd: string, _createdAt?: string): string | null {
  try {
    const encoded = encodeCwdClaude(cwd);
    const sessionsDir = join(HOME, '.claude', 'projects', encoded);
    if (!existsSync(sessionsDir)) return null;

    // Find most recent .jsonl file (filename IS the UUID)
    const entries = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('subagents'))
      .sort((a, b) => b.localeCompare(a));

    if (entries.length === 0) return null;

    // Extract UUID from filename (remove .jsonl extension)
    const filename = entries[0];
    return filename.replace(/\.jsonl$/, '');
  } catch {
    return null;
  }
}

function extractOpencodeSessionId(cwd: string, _createdAt?: string): string | null {
  try {
    const dbPath = join(HOME, '.local', 'share', 'opencode', 'opencode.db');
    if (!existsSync(dbPath)) return null;

    const result = execSync(
      `sqlite3 '${dbPath}' "SELECT id FROM session WHERE directory = '${cwd.replace(/'/g, "''")}' ORDER BY time_updated DESC LIMIT 1"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    return result || null;
  } catch {
    return null;
  }
}

function extractCodexSessionId(cwd: string, _createdAt?: string): string | null {
  try {
    // Find latest state_*.sqlite
    const codexDir = join(HOME, '.codex');
    if (!existsSync(codexDir)) return null;

    const dbFiles = readdirSync(codexDir)
      .filter(f => /^state_\d+\.sqlite$/.test(f))
      .sort();

    if (dbFiles.length === 0) return null;

    const dbPath = join(codexDir, dbFiles[dbFiles.length - 1]);

    const result = execSync(
      `sqlite3 '${dbPath}' "SELECT id FROM threads WHERE cwd = '${cwd.replace(/'/g, "''")}' AND archived = 0 ORDER BY updated_at DESC LIMIT 1"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    return result || null;
  } catch {
    return null;
  }
}

// ── Public API ──

export type AgentType = 'pi' | 'claude' | 'opencode' | 'codex' | 'shell';

const EXTRACTORS: Record<AgentType, (cwd: string, createdAt?: string) => string | null> = {
  pi: extractPiSessionId,
  claude: extractClaudeSessionId,
  opencode: extractOpencodeSessionId,
  codex: extractCodexSessionId,
  shell: () => null, // Shell sessions have no agent session ID
};

/** Extract the agent session ID for a given agent type and working directory.
 *  When createdAt is provided for Pi sessions, uses time-based matching to
 *  find the correct session file when multiple sessions share a CWD. */
export function extractSessionId(agentType: string, cwd: string, createdAt?: string): string | null {
  const extractor = EXTRACTORS[agentType as AgentType];
  if (!extractor) return null;
  return extractor(cwd, createdAt);
}

/** Extract a newly-created agent session ID after an in-agent session switch (e.g. Pi `/new`). */
export function extractSessionIdAfter(agentType: string, cwd: string, afterMs: number, excludeId?: string): string | null {
  if (agentType === 'pi') return extractPiSessionIdAfter(cwd, afterMs, excludeId);
  return null;
}

// ── Resume commands ──

const RESUME_COMMANDS: Record<AgentType, (sessionId: string, cwd: string) => string> = {
  pi: (id) => `pi --session ${id}`,
  claude: (id) => `claude --resume ${id}`,
  opencode: (id) => `opencode run --session ${id} ''`,
  codex: (id, cwd) => `codex resume ${id} -C ${cwd}`,
  shell: () => '', // Shell sessions cannot be resumed
};

/** Get the resume command for an agent type and session ID */
export function getResumeCommand(agentType: string, sessionId: string, cwd: string): string {
  const cmd = RESUME_COMMANDS[agentType as AgentType];
  if (!cmd) return '';
  return cmd(sessionId, cwd);
}

/** Check if an agent type supports resume */
export function supportsResume(agentType: string): boolean {
  return agentType !== 'shell' && agentType in RESUME_COMMANDS;
}