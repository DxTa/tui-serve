// Server configuration
// Loads from environment variables with sensible defaults

export interface CommandAllowlistEntry {
  id: string;
  label: string;
  command: string;
  allowedCwdRoots: string[];
  requiresConfirmation?: boolean;
}

export interface HostConfig {
  id: string;
  name: string;
  address: string;
  port: number;
}

export interface Config {
  port: number;
  bindHost: string;
  authToken: string;
  authRequired: boolean;
  commands: CommandAllowlistEntry[];
  hosts: HostConfig[];
  maxScrollback: number;
  snapshotLines: number;
  maxSessions: number;
  maxWsConnections: number;
  healthCheckIntervalMs: number;
  heartbeatIntervalMs: number;
  staleSessionTimeoutHours: number;
  wsBackpressureLimitBytes: number;
  enablePollingPtyFallback: boolean;
}

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDefaultConfig(): { commands: CommandAllowlistEntry[]; hosts: HostConfig[] } {
  // TUI_SERVE_CONFIG overrides the config file path (for packaged installs)
  const configPath = process.env.TUI_SERVE_CONFIG || resolve(__dirname, '..', 'default-config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return {
    commands: [
      {
        id: 'pi',
        label: 'Pi Coding Agent',
        command: 'pi',
        allowedCwdRoots: ['/home/pi/projects', '/home/pi/code', process.env.HOME || '/root', '/tmp'],
      },
      {
        id: 'claude',
        label: 'Claude Coding Agent',
        command: 'claude',
        allowedCwdRoots: ['/home/pi/projects', '/home/pi/code', process.env.HOME || '/root', '/tmp'],
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        command: 'opencode',
        allowedCwdRoots: ['/home/pi/projects', process.env.HOME || '/root', '/tmp'],
      },
      {
        id: 'codex',
        label: 'Codex Coding Agent',
        command: 'codex',
        allowedCwdRoots: ['/home/pi/projects', process.env.HOME || '/root', '/tmp'],
      },
    ],
    hosts: [
      { id: 'local', name: 'This Machine', address: 'localhost', port: 5555 },
    ],
  };
}

const defaults = loadDefaultConfig();

// Ensure every command allows the current user's home directory
// This is always injected at runtime so config files don't need to hard-code it
const home = process.env.HOME || '/root';
const commandsWithHome = defaults.commands.map((cmd) => {
  const roots = new Set<string>(cmd.allowedCwdRoots);
  // Also add common subdirectories of home
  for (const root of [...roots]) {
    if (root.startsWith('/home/pi')) {
      // Replace /home/pi paths with actual home equivalent
      const relPath = root.slice('/home/pi'.length);
      if (relPath) roots.add(home + relPath);
    }
  }
  roots.add(home);
  return { ...cmd, allowedCwdRoots: [...roots] };
});

export const config: Config = {
  port: parseInt(process.env.PORT || '5555', 10),
  bindHost: process.env.BIND_HOST || process.env.TUI_SERVE_BIND_HOST || '0.0.0.0',
  authToken: process.env.AUTH_TOKEN || '',
  authRequired: !!(process.env.AUTH_TOKEN && process.env.AUTH_TOKEN.length > 0),
  commands: commandsWithHome,
  hosts: defaults.hosts,
  maxScrollback: 10000,
  snapshotLines: 2000,
  maxSessions: 20,
  maxWsConnections: 50,
  healthCheckIntervalMs: 30000,
  heartbeatIntervalMs: 60000,
  staleSessionTimeoutHours: 24,
  wsBackpressureLimitBytes: parseInt(process.env.TUI_SERVE_WS_BACKPRESSURE_LIMIT_BYTES || String(1024 * 1024), 10),
  enablePollingPtyFallback: process.env.TUI_SERVE_ENABLE_POLLING_PTY_FALLBACK === '1',
};