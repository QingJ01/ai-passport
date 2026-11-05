// One browser owner lease, one assignment per bridge intent, no answer/cancel API.
export function createNavigationRelay({ get, post, allowed, onAvailability, now = () => globalThis.performance.now(), leaseMs = 5000 }) {
  let owner = null;
  let expires = 0;
  let timer;
  let closed = false;
  let busy = false;
  const assignments = new Map();
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(id);
  const available = () => !closed && owner !== null && now() < expires;
  const prune = () => {
    for (const [id, value] of assignments) if (now() - value.created >= 60000) assignments.delete(id);
  };
  const disarm = () => {
    owner = null; expires = 0; clearTimeout(timer); onAvailability(false);
  };
  return {
    available,
    async poll(clientId) {
      if (closed || !validId(clientId)) throw new Error('invalid_navigation_client');
      prune();
      if (available() && owner !== clientId) return { commands: [] };
      const wasAvailable = available();
      owner = clientId; expires = now() + leaseMs;
      clearTimeout(timer);
      timer = setTimeout(disarm, leaseMs); timer.unref?.();
      if (!wasAvailable) onAvailability(true);
      if (busy) return { commands: [] };
      busy = true;
      try {
        const response = await get('/v1/commands');
        if (!available() || owner !== clientId) return { commands: [] };
        if (!Array.isArray(response.commands) || response.commands.length > 64) throw new Error('invalid_navigation_commands');
        const result = [];
        for (const command of response.commands) {
          if (!validId(command.command_id) || command.type !== 'open_on_host' || typeof command.session_id !== 'string') continue;
          let value = assignments.get(command.command_id);
          if (!value) {
            // Capacity failures do not cause navigation or evict an in-flight decision.
            if (assignments.size >= 256) continue;
            value = { clientId, sessionId: command.session_id, created: now(), status: null, acknowledged: false };
            assignments.set(command.command_id, value);
          }
          if (value.sessionId !== command.session_id || value.clientId !== clientId || value.acknowledged) continue;
          if (!allowed(value.sessionId) && value.status === null) value.status = 'failed';
          if (value.status !== null) {
            try { await post('/v1/commands/result', { command_id: command.command_id, status: value.status }); value.acknowledged = true; }
            catch { /* Retry same result, never re-dispatch a known decision. */ }
            continue;
          }
          result.push({ command_id: command.command_id, type: 'open_on_host', session_id: value.sessionId });
        }
        return { commands: result };
      } finally { busy = false; }
    },
    async result(clientId, commandId, status) {
      if (closed || !['succeeded', 'failed', 'unknown'].includes(status)) throw new Error('invalid_navigation_result');
      const value = assignments.get(commandId);
      if (!value || value.clientId !== clientId) throw new Error('unassigned_navigation_command');
      if (value.status !== null && value.status !== status) throw new Error('conflicting_navigation_result');
      value.status = status;
      if (!value.acknowledged) {
        await post('/v1/commands/result', { command_id: commandId, status });
        value.acknowledged = true;
      }
      return true;
    },
    leave(clientId) { if (owner === clientId) disarm(); return true; },
    close() { if (closed) return; closed = true; clearTimeout(timer); owner = null; assignments.clear(); },
  };
}
