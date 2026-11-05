import { randomUUID } from 'node:crypto';
import { COMPATIBLE_DSH, initialLifecycle, normalizedTurn, normalizeUsage } from './projection.mjs';
import { createTransport, validateBridgeUrl } from './transport.mjs';
import { createNavigationRelay } from './navigation.mjs';

export function validateConfig(config, env) {
  const allowed = new Set(['sourceId', 'bridgeUrl', 'ipcTokenEnv', 'sourceTokenEnv', 'sessionIds', 'includeAllSessions']);
  if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error('unknown_adapter_setting');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.sourceId)) throw new Error('invalid_source_id');
  validateBridgeUrl(config.bridgeUrl);
  if (!Array.isArray(config.sessionIds) || config.sessionIds.length > 128 || config.sessionIds.some((id) =>
    typeof id !== 'string' || id.length > 256 || /[\x00-\x1f\x7f]/.test(id))) throw new Error('invalid_session_selection');
  if (typeof config.includeAllSessions !== 'boolean') throw new Error('invalid_session_selection');
  for (const key of ['ipcTokenEnv', 'sourceTokenEnv']) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(config[key]) || !/^[\x21-\x7e]{32,512}$/.test(env[config[key]] ?? '')) {
      throw new Error('missing_adapter_credential');
    }
  }
  return config;
}

// The caller supplies the actual launcher version, never a user-configured version.
export async function startAdapter(ctx, config, { version, lifecycleDefinition, env = process.env,
  transportFactory = createTransport, now = Date.now, interval = 15000 } = {}) {
  if (version !== COMPATIBLE_DSH) throw new Error('unsupported_dsh_version');
  validateConfig(config, env);
  const transport = transportFactory({ bridgeUrl: config.bridgeUrl,
    ipcToken: env[config.ipcTokenEnv], sourceToken: env[config.sourceTokenEnv] });
  const handle = await ctx.sessionProjections.register(lifecycleDefinition);
  const pendingRequests = new Set();
  const track = (pending) => {
    pendingRequests.add(pending);
    const forget = () => pendingRequests.delete(pending);
    pending.then(forget, forget);
    return pending;
  };
  const post = (path, body) => track(transport.post(path, body));
  const get = (path) => track(transport.get(path));
  const liveQuestions = new Map();
  const revisions = new Map();
  const queue = new Map();
  const counts = { captured: 0, capture_failures: 0, lifecycle_failures: 0, usage_failures: 0,
    question_failures: 0, event_posts_accepted: 0, event_posts_failed: 0,
    heartbeats_accepted: 0, heartbeats_failed: 0 };
  let lastFailure = 'none';
  const increment = (key) => { counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1); };
  const failure = (key, stage) => { increment(key); lastFailure = stage; };
  let active = true;
  let flushing = false;
  let retryAt = 0;
  let timer;
  let warned = false;
  const selection = new Set(config.sessionIds);
  const observedSessions = new WeakSet();
  const selected = (session) => active && ctx.sessions.get(session.id) === session &&
    (config.includeAllSessions || selection.has(session.id));
  const warn = () => { if (!warned) { warned = true; ctx.logger.warn('Agent Pet source degraded; inspect counts-only owner diagnostics'); } };
  const revisionOf = (id) => {
    const revision = Math.max(now() * 1000, (revisions.get(id) ?? 0) + 1);
    if (!Number.isSafeInteger(revision)) throw new Error('adapter_revision_exhausted');
    revisions.set(id, revision);
    return revision;
  };
  function capture(session, detached = false) {
    if (detached ? !active || !observedSessions.has(session) : !selected(session)) return;
    observedSessions.add(session);
    try {
      let lifecycle = initialLifecycle();
      try { lifecycle = handle.stateOf(session); }
      catch { failure('lifecycle_failures', 'lifecycle'); warn(); }
      // Optional views must never suppress current live execution state. Each is read
      // through the host registry independently, without private storage or cached hints.
      const snapshot = { asOfSeq: session.seq - 1, values: {} };
      try {
        const usageSnapshot = ctx.sessionProjections.snapshot(session, ['tokenUsage']);
        normalizeUsage(usageSnapshot, session); // Validate before attaching optional usage.
        snapshot.asOfSeq = usageSnapshot.asOfSeq;
        snapshot.values.tokenUsage = usageSnapshot.values.tokenUsage;
      } catch { failure('usage_failures', 'token_usage'); warn(); }
      try {
        const questionSnapshot = ctx.sessionProjections.snapshot(session, ['userQuestions']);
        snapshot.values.userQuestions = questionSnapshot.values.userQuestions;
      } catch { failure('question_failures', 'user_questions'); warn(); }
      const candidate = detached ? undefined : ctx.agents.get(session.id);
      const event = normalizedTurn({ sourceId: config.sourceId, session,
        lifecycle, agent: candidate?.session === session ? candidate : undefined, snapshot,
        live: liveQuestions.get(session.id) ?? new Map(), revision: revisionOf(session.id) });
      if (detached) event.pending_interactions = [];
      event.capabilities.open_on_host = !detached && navigation.available();
      const key = `${event.session_id}:${event.run_id}`;
      if (!queue.has(key) && queue.size >= 256) {
        queue.delete(queue.keys().next().value);
        warn(); // Historical transition coverage is not guaranteed after overflow.
      }
      queue.set(key, event); increment('captured'); schedule();
    } catch { failure('capture_failures', 'normalize'); warn(); }
  }
  function schedule() {
    if (!active || timer || flushing) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, Math.max(100, retryAt - now()));
    timer.unref?.();
  }
  async function flush() {
    if (!active || flushing) return;
    flushing = true;
    try {
      while (active && queue.size) {
        const [key, event] = queue.entries().next().value;
        await post('/v1/events', { event }); increment('event_posts_accepted');
        if (queue.get(key) === event) queue.delete(key);
        warned = false;
      }
      retryAt = 0;
    } catch { retryAt = now() + 5000; failure('event_posts_failed', 'ipc_events'); warn(); }
    finally { flushing = false; if (queue.size) schedule(); }
  }
  const navigation = createNavigationRelay({ get, post,
    allowed: (id) => { const session = ctx.sessions.get(id); return !!session && selected(session); },
    onAvailability: () => { for (const session of ctx.sessions.list()) capture(session); },
  });
  const disposers = [];
  const on = (event, listener, options = {}) => disposers.push(ctx.on(event, listener, { global: true, ...options }));
  on('session/created', capture);
  on('session/event', (session, event) => {
    if (['turn/start', 'turn/end', 'assistant/message', 'assistant/attempt', 'llm/retry-started',
      'tool/call', 'tool/result', 'user/message'].includes(event.type)) capture(session);
  });
  on('agent/status', ({ agent }) => capture(agent.session));
  on('session/disposed', (session) => {
    liveQuestions.delete(session.id); capture(session, true); revisions.delete(session.id);
  });
  disposers.push(ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'tokenUsage' || key === 'userQuestions') capture(session);
  }));
  on('user-questions/request', async (request, next) => {
    const session = request.agent?.session;
    if (!session || !selected(session)) return next();
    const questions = liveQuestions.get(session.id) ?? new Map();
    liveQuestions.set(session.id, questions);
    const id = request.wait?.callId ?? `question-${randomUUID()}`;
    questions.set(id, { request_id: id, blocks_execution: request.wait?.timed !== true });
    capture(session);
    try { return await next(); }
    finally { questions.delete(id); if (!questions.size) liveQuestions.delete(session.id); capture(session); }
  }, { prepend: true });
  const reconcile = async () => {
    if (!active) return;
    try { await post('/v1/source/heartbeat', { connected: true }); increment('heartbeats_accepted'); }
    catch { failure('heartbeats_failed', 'ipc_heartbeat'); warn(); }
    // Always republish selected whole values, even when there are no new host events.
    for (const session of ctx.sessions.list()) capture(session);
    await flush();
  };
  const heartbeatTimer = setInterval(() => { void reconcile(); }, interval);
  heartbeatTimer.unref?.();
  for (const session of ctx.sessions.list()) capture(session);
  void reconcile();
  const diagnostics = () => {
    let selectedLive = 0; let selectedAgents = 0;
    if (active) for (const session of ctx.sessions.list()) if (selected(session)) {
      selectedLive++; if (ctx.agents.get(session.id)?.session === session) selectedAgents++;
    }
    return { active, selected_configured: selection.size, selected_live: selectedLive,
      selected_agents: selectedAgents, queued: queue.size, ...counts, last_failure_stage: lastFailure };
  };
  const stop = async () => {
    if (!active) return;
    active = false; clearTimeout(timer); clearInterval(heartbeatTimer); navigation.close();
    for (const dispose of disposers.reverse()) dispose();
    queue.clear(); liveQuestions.clear(); revisions.clear();
    await Promise.allSettled([...pendingRequests]);
    try { await post('/v1/source/heartbeat', { connected: false }); } catch { /* Host TTL is authoritative. */ }
    transport.close(); await handle.dispose();
  };
  ctx.effect(() => stop);
  return { stop, flush, navigation, reconcile, diagnostics };
}
