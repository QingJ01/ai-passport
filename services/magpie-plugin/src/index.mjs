import z from '@deepseek-ai/schemastery';
import { z as schema } from 'zod';
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';
import { startAdapter } from './adapter.mjs';
import { COMPATIBLE_DSH, initialLifecycle, foldLifecycle } from './projection.mjs';
import { NavigationService } from './navigation-service.mjs';
import { navigationDefinition } from './remote-definition.mjs';
import { resolveConnection } from './connection.mjs';

export const name = 'agent-pet-adapter';
export const inject = ['sessions', 'agents', 'sessionProjections', 'tokenMeter', 'userQuestions', 'typert'];
export const Config = z.object({
  sourceId: z.string().default('magpie-local'),
  bridgeUrl: z.string().default('http://127.0.0.1:7445'),
  ipcTokenEnv: z.string().default('AGENT_PET_IPC_TOKEN'),
  sourceTokenEnv: z.string().default('AGENT_PET_SOURCE_TOKEN'),
  sessionIds: z.array(z.string()).default([]),
  includeAllSessions: z.boolean().default(false),
  connectionFile: z.string().default(''),
});
export const lifecycleDefinition = {
  key: 'petLifecycle', stateVersion: 1,
  stateSchema: schema.object({ turn: schema.number().int().nonnegative(),
    startSeq: schema.number().int().nonnegative().nullable(), ended: schema.boolean() }).strict(),
  init: initialLifecycle, apply: foldLifecycle,
};
export async function apply(ctx, config) {
  if (getDshRuntimeVersion() !== COMPATIBLE_DSH) throw new Error('unsupported_dsh_version');
  const connection = await resolveConnection(config);
  if (!connection) { ctx.logger.info('Agent Pet adapter inactive: connection not configured'); return; }
  const adapter = await startAdapter(ctx, connection.settings, { version: getDshRuntimeVersion(), lifecycleDefinition, env: connection.env });
  new NavigationService(ctx, adapter.navigation, adapter.diagnostics);
  const definition = navigationDefinition(schema);
  ctx.typert.register({ package: definition.package, face: 'host', schemas: [], invocations: definition.descriptors,
    model: { services: [], events: [], objects: [] } });
}
