// DSH 0.2.2-rc.1 lifecycle vocabulary. Never retain text, arguments or outputs.
export const COMPATIBLE_DSH = '0.2.2-rc.1';
export const initialLifecycle = () => ({ turn: 0, startSeq: null, ended: false });
export function foldLifecycle(state, event) {
  if (event.type === 'turn/start') return { turn: event.data.turn, startSeq: event.seq, ended: false };
  if (event.type === 'turn/end' && event.data.turn === state.turn) return { ...state, ended: true };
  return state;
}

export function decimal(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_token_counter');
  return String(value);
}

// tokenUsage is the HOST wire projection. No local stream/chunk summation.
export function normalizeUsage(snapshot, session) {
  // Host tokenUsage includes a fork's inherited prefix. Do not bill that twice.
  if (session.header.isSeeded || session.inheritedEventCount > 0) return undefined;
  const value = snapshot.values.tokenUsage;
  if (!value) return undefined;
  return {
    kind: 'session_total', revision: snapshot.asOfSeq + 1,
    input_tokens: decimal(value.uncachedInputTokens),
    output_tokens: decimal(value.outputTokens),
    cache_read_tokens: decimal(value.cacheReadTokens),
    cache_write_tokens: decimal(value.cacheWriteTokens),
    coverage: 'loaded_session', accounting: `dsh-token-meter@${COMPATIBLE_DSH}`,
  };
}

export function interactions(questionView, live, revision) {
  const pending = new Map();
  for (const question of questionView?.active ?? []) {
    pending.set(question.callId, {
      request_id: question.callId, revision,
      blocks_execution: false, // Only the live waterfall proves blocking.
    });
  }
  for (const question of live.values()) {
    pending.set(question.request_id, { ...question, revision });
  }
  return [...pending.values()];
}

export function normalizedTurn({ sourceId, session, lifecycle, snapshot, agent, live, revision }) {
  const usage = normalizeUsage(snapshot, session);
  return {
    source_id: sourceId, session_id: session.id,
    run_id: lifecycle.startSeq === null ? 'session-observed' : `turn-${lifecycle.turn}-${lifecycle.startSeq}`,
    revision, title: 'Magpie session', entity_kind: 'turn',
    execution_state: agent?.status === 'running' ? 'running' : agent?.status === 'idle' ? 'idle' : 'unknown',
    pending_interactions: interactions(snapshot.values.userQuestions, live, revision),
    task_outcome: null, turn_outcome: lifecycle.ended ? 'ended' : null,
    capabilities: { open_on_host: false },
    ...(usage ? { usage } : {}),
  };
}
