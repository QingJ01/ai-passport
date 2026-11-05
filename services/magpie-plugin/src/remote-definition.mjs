// Explicit version-pinned Typert descriptors, shared by host and browser bundle.
// No compiler/source fallback or arbitrary endpoint invocation is used.
export function navigationDefinition(z) {
  const packageName = '@ai-passport/dsh-agent-pet';
  const identity = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
  const command = z.object({ command_id: identity, type: z.literal('open_on_host'), session_id: z.string().min(1).max(256) }).strict();
  const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const diagnostics = z.object({ active: z.boolean(), selected_configured: count, selected_live: count,
    selected_agents: count, queued: count, captured: count, capture_failures: count, lifecycle_failures: count,
    usage_failures: count, question_failures: count, event_posts_accepted: count, event_posts_failed: count,
    heartbeats_accepted: count, heartbeats_failed: count,
    last_failure_stage: z.enum(['none', 'lifecycle', 'token_usage', 'user_questions', 'normalize', 'ipc_events', 'ipc_heartbeat']),
  }).strict();
  const specifications = [
    ['poll', [['clientId', identity]], z.object({ commands: z.array(command).max(64) }).strict()],
    ['result', [['clientId', identity], ['commandId', identity], ['status', z.enum(['succeeded', 'failed', 'unknown'])]], z.boolean()],
    ['leave', [['clientId', identity]], z.boolean()],
    ['diagnostics', [], diagnostics],
  ];
  const codec = (schema, symbol) => ({ mode: 'strict', typeSymbol: `${packageName}#${symbol}`, create: () => schema,
    decode: (value) => schema.parse(value), encode: (value) => schema.parse(value) });
  return { package: packageName, descriptors: specifications.map(([method, parameters, result]) => ({
    id: `${packageName}#agentPetNavigation/${method}`, service: 'agentPetNavigation', namespace: 'agentPetNavigation', method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(([name, schema]) => ({ name, wire: name, source: 'json',
      codec: codec(schema, `${method}:${name}`), strictCodec: codec(schema, `${method}:${name}`) })),
    result: codec(result, `${method}:result`),
  })) };
}
