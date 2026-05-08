// Agent session ID extraction
// Each coding agent stores session IDs differently.
// This module reads the agent's internal session ID
// so we can resume after a crash.

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
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

function extractPiSessionId(cwd: string): string | null {
  try {
    const encoded = encodeCwdPi(cwd);
    const sessionsDir = join(HOME, '.pi', 'agent', 'sessions', encoded);
    if (!existsSync(sessionsDir)) return null;

    // Pi's primary sessions are top-level <timestamp>_<uuid>.jsonl files.
    // Nested session.jsonl files are subagent/chain runs; using them resumes the wrong Pi session.
    const entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
      .sort((a, b) => b.name.localeCompare(a.name)); // filenames start with sortable timestamp

    for (const entry of entries) {
      const file = join(sessionsDir, entry.name);
      try {
        const firstLine = readFileSync(file, 'utf-8').split('\n')[0];
        const header = JSON.parse(firstLine);
        if (header.id && (!header.cwd || header.cwd === cwd)) return header.id;
      } catch { continue; }
    }
    return null;
  } catch {
    return null;
  }
}

function extractClaudeSessionId(cwd: string): string | null {
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

function extractOpencodeSessionId(cwd: string): string | null {
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

function extractCodexSessionId(cwd: string): string | null {
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

const EXTRACTORS: Record<AgentType, (cwd: string) => string | null> = {
  pi: extractPiSessionId,
  claude: extractClaudeSessionId,
  opencode: extractOpencodeSessionId,
  codex: extractCodexSessionId,
  shell: () => null, // Shell sessions have no agent session ID
};

/** Extract the most recent agent session ID for a given agent type and working directory */
export function extractSessionId(agentType: string, cwd: string): string | null {
  const extractor = EXTRACTORS[agentType as AgentType];
  if (!extractor) return null;
  return extractor(cwd);
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