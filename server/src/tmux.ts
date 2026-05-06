// tmux CLI wrappers
// All commands sanitize inputs to prevent shell injection

import { execSync } from 'child_process';

// Simple logger to avoid circular dependency with index.ts
const log = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', action: `tmux.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', action: `tmux.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
};

function esc(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function tmuxExec(args: string[], opts?: { timeout?: number }): string {
  const cmd = `tmux ${args.map((a) => `'${esc(a)}'`).join(' ')}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: opts?.timeout ?? 10000 }).trim();
  } catch (err: any) {
    if (err.stderr?.includes('no session') || err.message?.includes('no session')) {
      throw new Error('TMUX_SESSION_NOT_FOUND');
    }
    throw new Error(`tmux command failed: ${err.message}`);
  }
}

export function createSession(name: string, cwd: string, command: string, env?: Record<string, string>): void {
  log.info('createSession', { name, cwd, command });

  if (env && Object.keys(env).length > 0) {
    // Create session first, then set environment and send command
    execSync(`tmux new-session -d -s '${esc(name)}' -c '${esc(cwd)}'`, {
      encoding: 'utf-8', timeout: 10000,
    });
    for (const [key, value] of Object.entries(env)) {
      setEnv(name, key, value);
    }
    execSync(`tmux send-keys -t '${esc(name)}' '${esc(command)}' Enter`, {
      encoding: 'utf-8', timeout: 10000,
    });
  } else {
    // Use -- separator to prevent shell interpolation
    execSync(`tmux new-session -d -s '${esc(name)}' -c '${esc(cwd)}' -- ${command}`, {
      encoding: 'utf-8', timeout: 10000,
    });
  }

  // Set scrollback limit and hide status bar
  // (status bar is redundant — our dashboard shows session info)
  try {
    execSync(`tmux set-option -t '${esc(name)}' history-limit 10000`, {
      encoding: 'utf-8', timeout: 5000,
    });
    execSync(`tmux set-option -t '${esc(name)}' status off`, {
      encoding: 'utf-8', timeout: 5000,
    });
  } catch {
    // Non-critical
  }
}

export function killSession(name: string): void {
  log.info('killSession', { name });
  try {
    execSync(`tmux kill-session -t '${esc(name)}'`, { encoding: 'utf-8', timeout: 10000 });
  } catch (err: any) {
    if (err.stderr?.includes('no session') || err.message?.includes('no session')) {
      throw new Error('TMUX_SESSION_NOT_FOUND');
    }
    throw err;
  }
}

export function hasSession(name: string): boolean {
  try {
    execSync(`tmux has-session -t '${esc(name)}'`, { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(name: string, lines = 2000): string {
  try {
    return execSync(`tmux capture-pane -t '${esc(name)}' -p -S -${lines}`, {
      encoding: 'utf-8', timeout: 10000,
    });
  } catch {
    return '';
  }
}

export function listSessions(): string[] {
  try {
    const output = execSync(`tmux list-sessions -F '#{session_name}'`, {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function getSessionPid(name: string): number | null {
  try {
    const output = execSync(`tmux list-panes -t '${esc(name)}' -F '#{pane_pid}'`, {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const pid = parseInt(output.split('\n')[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function setEnv(name: string, key: string, value: string): void {
  try {
    execSync(`tmux set-environment -t '${esc(name)}' '${esc(key)}' '${esc(value)}'`, {
      encoding: 'utf-8', timeout: 5000,
    });
  } catch (err) {
    log.warn('setEnv failed', { name, key, error: String(err) });
  }
}

export function resizeWindow(name: string, cols: number, rows: number): void {
  try {
    execSync(`tmux resize-window -t '${esc(name)}' -x ${cols} -y ${rows}`, {
      encoding: 'utf-8', timeout: 5000,
    });
  } catch (err) {
    log.warn('resizeWindow failed', { name, cols, rows, error: String(err) });
  }
}