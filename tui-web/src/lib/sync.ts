// Sync layer — merges server state into Dexie database
// Server-wins for live state fields, frontend-wins for metadata fields

import { db, type Session } from './db';

// Conflict resolution rules:
// Server-wins: status, pid, attachedClients, exitCode
// Frontend-wins: title, restartPolicy, crashCount, lastCrashAt
// Server-wins-if-absent-locally: agentSessionId, commandId, command, cwd, agentType

export async function syncFromServer(serverSessions: any[]): Promise<void> {
  const now = new Date().toISOString();
  const serverIds = new Set<string>();

  // Upsert each server session
  for (const serverSession of serverSessions) {
    serverIds.add(serverSession.id);

    const existing = await db.sessions.get(serverSession.id);

    // Build merged session from server data
    const merged: Session = {
      id: serverSession.id,
      hostId: serverSession.hostId || 'local',
      tmuxSessionName: serverSession.tmuxSessionName || serverSession.id,
      // Server-wins fields
      status: serverSession.status || 'unknown',
      pid: serverSession.pid ?? null,
      attachedClients: serverSession.attachedClients ?? 0,
      exitCode: serverSession.exitCode ?? null,
      // Server-wins-if-absent-locally fields
      agentSessionId: serverSession.agentSessionId || (existing?.agentSessionId ?? null),
      commandId: serverSession.commandId || (existing?.commandId ?? ''),
      command: serverSession.command || (existing?.command ?? ''),
      cwd: serverSession.cwd || (existing?.cwd ?? ''),
      agentType: serverSession.agentType || serverSession.commandId || (existing?.agentType ?? ''),
      // Frontend-wins fields (keep existing if we have it)
      title: existing?.title ?? serverSession.title ?? serverSession.id,
      restartPolicy: existing?.restartPolicy ?? serverSession.restartPolicy ?? 'manual',
      crashCount: existing?.crashCount ?? serverSession.crashCount ?? 0,
      lastCrashAt: existing?.lastCrashAt ?? serverSession.lastCrashAt ?? null,
      lastExitCode: existing?.lastExitCode ?? serverSession.lastExitCode ?? null,
      env: serverSession.env || '{}',
      isTombstone: false,
      createdAt: serverSession.createdAt || existing?.createdAt || now,
      updatedAt: serverSession.updatedAt || now,
      lastAttachedAt: serverSession.lastAttachedAt || existing?.lastAttachedAt || null,
      lastServerSync: now,
    };

    await db.sessions.put(merged);
  }

  // Mark sessions not in server response as tombstones (if they were running before)
  const allLocal = await db.sessions.toArray();
  for (const local of allLocal) {
    if (!serverIds.has(local.id) && !local.isTombstone) {
      await db.sessions.update(local.id, {
        status: 'disconnected',
        isTombstone: true,
        attachedClients: 0,
        lastServerSync: now,
      });
    }
  }

  // Remove tombstones that are superseded by live server sessions.
  // Prefer agentSessionId as identity. Title/cwd is only a fallback when the
  // tombstone has no agentSessionId; otherwise two distinct Pi conversations
  // with the same title/cwd can collapse and reconnect the wrong session.
  const liveSessions = await db.sessions.filter(s => !s.isTombstone).toArray();
  let tombstones = await db.sessions.filter(s => s.isTombstone).toArray();
  for (const tombstone of tombstones) {
    const superseded = liveSessions.some(live => {
      if (tombstone.agentSessionId) {
        return Boolean(live.agentSessionId && tombstone.agentSessionId === live.agentSessionId);
      }
      return live.commandId === tombstone.commandId
        && live.cwd === tombstone.cwd
        && live.title === tombstone.title;
    });
    if (superseded) {
      await db.sessions.delete(tombstone.id);
    }
  }

  // Collapse duplicate tombstones for the same logical session.
  // Keep newest tombstone, delete older duplicates.
  tombstones = await db.sessions.filter(s => s.isTombstone).toArray();
  const tombstoneGroups = new Map<string, Session[]>();
  for (const tombstone of tombstones) {
    const key = tombstone.agentSessionId
      ? `agent:${tombstone.agentSessionId}`
      : `meta:${tombstone.commandId}|${tombstone.cwd}|${tombstone.title}`;
    const group = tombstoneGroups.get(key) || [];
    group.push(tombstone);
    tombstoneGroups.set(key, group);
  }
  for (const group of tombstoneGroups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => (b.lastServerSync || b.updatedAt || '').localeCompare(a.lastServerSync || a.updatedAt || ''));
    for (const stale of group.slice(1)) {
      await db.sessions.delete(stale.id);
    }
  }

  // Clean up tombstones older than 24 hours
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.sessions
    .where('lastServerSync')
    .below(twentyFourHoursAgo)
    .filter(s => s.isTombstone)
    .delete();
}

// Request persistent storage to prevent browser from clearing IndexedDB
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      console.log('Persistent storage:', granted ? 'granted' : 'denied');
      return granted;
    } catch {
      return false;
    }
  }
  return false;
}

// Get a session from local DB (may be stale)
export async function getLocalSession(id: string): Promise<Session | undefined> {
  return db.sessions.get(id);
}

// Update a session locally (frontend-wins fields only)
export async function updateLocalSession(id: string, updates: Partial<Session>): Promise<void> {
  await db.sessions.update(id, { ...updates, lastServerSync: new Date().toISOString() });
}