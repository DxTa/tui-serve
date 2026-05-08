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

  // Create a shell session first, then send the agent command.
  // This keeps the pane alive long enough to surface command/path/permission errors
  // instead of returning null when the agent executable exits immediately.
  execSync(`tmux new-session -d -s '${esc(name)}' -c '${esc(cwd)}'`, {
    encoding: 'utf-8', timeout: 10000,
  });

  if (env && Object.keys(env).length > 0) {
    for (const [key, value] of Object.entries(env)) {
      setEnv(name, key, value);
    }
  }

  execSync(`tmux send-keys -t '${esc(name)}' '${esc(command)}' Enter`, {
    encoding: 'utf-8', timeout: 10000,
  });

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

/** Send keys to a tmux session (for resume commands) */
export function sendKeys(name: string, keys: string): void {
  try {
    execSync(`tmux send-keys -t '${esc(name)}' '${esc(keys)}'`, {
      encoding: 'utf-8', timeout: 5000,
    });
  } catch (err) {
    log.warn('sendKeys failed', { name, error: String(err) });
  }
}

// ── @pi-web-* custom option helpers ──
// All metadata is stored in tmux session options with @pi-web- prefix

const PI_WEB_PREFIX = '@pi-web-';

/** Set a @pi-web-* option on a tmux session */
export function setSessionOption(name: string, key: string, value: string): void {
  try {
    execSync(`tmux set-option -t '${esc(name)}' ${PI_WEB_PREFIX}${esc(key)} '${esc(value)}'`, {
      encoding: 'utf-8', timeout: 5000,
    });
  } catch (err) {
    log.warn('setSessionOption failed', { name, key, error: String(err) });
  }
}

/** Get a single @pi-web-* option from a tmux session */
export function getSessionOption(name: string, key: string): string | null {
  try {
    const output = execSync(
      `tmux show-options -t '${esc(name)}' -v ${PI_WEB_PREFIX}${esc(key)} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (!output || output.includes('unknown option') || output.includes('invalid option')) return null;
    // tmux wraps values with spaces in double quotes
    if (output.startsWith('"') && output.endsWith('"')) {
      return output.slice(1, -1);
    }
    return output;
  } catch {
    return null;
  }
}

/** Get all @pi-web-* options from a tmux session */
export function getSessionOptions(name: string): string {
  try {
    const output = execSync(
      `tmux show-options -t '${esc(name)}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    // Filter to only @pi-web-* options
    return output
      .split('\n')
      .filter(line => line.startsWith(PI_WEB_PREFIX))
      .join('\n');
  } catch {
    return '';
  }
}

/** Get the foreground command running in a tmux session pane */
export function getForegroundCommand(name: string): string | null {
  try {
    const output = execSync(`tmux display-message -t '${esc(name)}' -p '#{pane_current_command}'`, {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Get the current working directory of a tmux session pane */
export function getSessionCwd(name: string): string | null {
  try {
    const output = execSync(`tmux display-message -t '${esc(name)}' -p '#{pane_current_path}'`, {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Set a shell trap to capture exit code into a tmux option.
 * When the agent process exits, the shell trap writes the exit code
 * to @pi-web-lastExitCode so we can distinguish clean exits from crashes.
 */
export function setExitTrap(name: string): void {
  try {
    // Send a trap command to the session that captures $?:
    // trap 'tmux set-option -t <session> @pi-web-lastExitCode $? EXIT
    // This needs to be sent after the initial command so the shell has started.
    // We use a delayed send-keys approach.
    const target = esc(name);
    // The trap is set in the shell. When the agent process inside exits,
    // the shell's EXIT trap fires and stores the exit code.
    // Note: this only works if the agent process is a child of the shell.
    // For agents launched via `tmux new-session -- command`, the command
    // replaces the shell, so there's no shell to run the trap.
    // For agents launched via `tmux send-keys command Enter` (env mode),
    // the shell remains and the trap can fire.
    // We set it as a tmux hook instead, which fires when the pane exits.
    execSync(
      `tmux set-hook -t '${target}' pane-exited "set-option -t '${target}' ${PI_WEB_PREFIX}lastExitCode '#{pane_dead_status}'"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    log.info('setExitTrap', { name });
  } catch (err) {
    log.warn('setExitTrap failed', { name, error: String(err) });
  }
}

/** List all sessions with their @pi-web-* options in bulk */
export function listSessionsWithDetails(): Array<{
  name: string;
  pid: number | null;
  cwd: string;
  foregroundCommand: string | null;
  options: Record<string, string>;
}> {
  const names = listSessions();
  return names.map(name => {
    const pid = getSessionPid(name);
    const cwd = getSessionCwd(name);
    const foregroundCommand = getForegroundCommand(name);
    const optionsRaw = getSessionOptions(name);
    const options: Record<string, string> = {};
    for (const line of optionsRaw.split('\n')) {
      const match = line.match(/^@pi-web-(\w+)\s+(.*)$/);
      if (match) {
        let value = match[2].trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        options[match[1]] = value;
      }
    }
    return { name, pid, cwd: cwd || '', foregroundCommand, options };
  });
}

/** Return descendant command names for a process tree rooted at rootPid. */
export function getDescendantCommands(rootPid: number): string[] {
  try {
    const out = execSync(`ps -eo pid=,ppid=,comm=`, { encoding: 'utf-8', timeout: 5000 });
    const children = new Map<number, Array<{ pid: number; comm: string }>>();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const comm = m[3].trim();
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push({ pid, comm });
    }

    const result: string[] = [];
    const stack = [...(children.get(rootPid) || [])];
    while (stack.length) {
      const proc = stack.pop()!;
      result.push(proc.comm);
      stack.push(...(children.get(proc.pid) || []));
    }
    return result;
  } catch {
    return [];
  }
}

/** True if expected command is running under tmux pane pid. */
export function hasDescendantCommand(rootPid: number | null, expected: string): boolean {
  if (!rootPid || !expected || expected === 'shell') return false;
  const commands = getDescendantCommands(rootPid);
  return commands.some((cmd) => cmd === expected || cmd.includes(expected));
}