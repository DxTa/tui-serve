// Command allowlist validation
// No raw commands from clients — only allowlisted IDs

import { config, type CommandAllowlistEntry } from './config.js';

const SESSION_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNSUPPORTED_COMMAND_IDS = new Set(['shell']);

export function validateSessionId(id: string): boolean {
  return SESSION_ID_REGEX.test(id);
}

export function getCommandEntry(commandId: string): CommandAllowlistEntry | null {
  if (UNSUPPORTED_COMMAND_IDS.has(commandId)) return null;
  return config.commands.find((c) => c.id === commandId) ?? null;
}

export function validateCommandId(commandId: string): boolean {
  return !UNSUPPORTED_COMMAND_IDS.has(commandId) && config.commands.some((c) => c.id === commandId);
}

export function resolveCommand(commandId: string): string | null {
  const entry = getCommandEntry(commandId);
  return entry?.command ?? null;
}

export function validateCwd(commandId: string, cwd: string): boolean {
  const entry = getCommandEntry(commandId);
  if (!entry) return false;

  // Resolve the path (remove . and ..)
  const resolved = resolveCwd(cwd);

  return entry.allowedCwdRoots.some((root) => {
    const resolvedRoot = resolveCwd(root);
    return resolved.startsWith(resolvedRoot + '/') || resolved === resolvedRoot;
  });
}

export function requiresConfirmation(commandId: string): boolean {
  const entry = getCommandEntry(commandId);
  return entry?.requiresConfirmation ?? false;
}

function resolveCwd(path: string): string {
  // Simple path resolution without touching the filesystem
  const parts = path.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return '/' + resolved.join('/');
}

export function getAllCommandIds(): string[] {
  return config.commands.filter((c) => !UNSUPPORTED_COMMAND_IDS.has(c.id)).map((c) => c.id);
}

export function getCommandLabels(): Array<{ id: string; label: string; requiresConfirmation: boolean; allowedCwdRoots: string[] }> {
  return config.commands.filter((c) => !UNSUPPORTED_COMMAND_IDS.has(c.id)).map((c) => ({
    id: c.id,
    label: c.label,
    requiresConfirmation: c.requiresConfirmation ?? false,
    allowedCwdRoots: c.allowedCwdRoots,
  }));
}