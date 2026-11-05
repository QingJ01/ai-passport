// Browser-safe companion. No IPC secrets, fetch-to-loopback, or window focus.
export function startCompanion(ctx, { remote, clientId = globalThis.crypto.randomUUID(),
  visible = () => globalThis.document?.visibilityState !== 'hidden', now = () => globalThis.performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, interval = 1000 } = {}) {
  let active = true;
  let timer;
  let polling = false;
  let left = false;
  const decisions = new Map();
  const acknowledge = async (id, decision) => {
    if (decision.acknowledged) return;
    const result = await remote.result(clientId, id, decision.status);
    if (result.ok && result.value === true) decision.acknowledged = true;
  };
  const poll = async () => {
    if (!active || polling) return;
    polling = true;
    try {
      for (const [id, decision] of decisions) {
        if (now() - decision.created >= 60000) { decisions.delete(id); continue; }
        if (!decision.acknowledged) { try { await acknowledge(id, decision); } catch { /* Same decision retries later. */ } }
      }
      if (!active) return;
      if (!visible()) {
        if (!left) { left = true; try { await remote.leave(clientId); } catch { /* Host lease expires. */ } }
        return;
      }
      left = false;
      const requestedAt = now();
      const result = await remote.poll(clientId);
      if (!active || !result.ok || !visible() || now() - requestedAt >= 5000) return;
      for (const command of result.value.commands) {
        if (!active || !visible()) break;
        let decision = decisions.get(command.command_id);
        if (!decision) {
          if (decisions.size >= 256 || command.type !== 'open_on_host') continue;
          // Record uncertainty BEFORE invoking navigation. Never invoke this ID twice.
          decision = { status: 'unknown', created: now(), acknowledged: false };
          decisions.set(command.command_id, decision);
          try {
            ctx.uiWorkspace.openSession(command.session_id);
            decision.status = ctx.uiWorkspace.selection.getSnapshot().sessionId === command.session_id ? 'succeeded' : 'unknown';
          } catch { decision.status = 'failed'; }
        }
        try { await acknowledge(command.command_id, decision); } catch { /* Do not repeat navigation after lost acknowledgments. */ }
      }
    } catch { /* No private transport error or task text enters browser diagnostics. */ }
    finally {
      polling = false;
      if (active) timer = setTimer(() => { void poll(); }, interval);
    }
  };
  void poll();
  const stop = () => {
    if (!active) return;
    active = false; clearTimer(timer);
    // Disposing the mounted Remote aborts an unfinished leave. The host lease is the fallback.
    try { Promise.resolve(remote.leave(clientId)).catch(() => {}); } catch { /* Namespace may already be withdrawing. */ }
    decisions.clear();
  };
  return { stop, poll };
}
