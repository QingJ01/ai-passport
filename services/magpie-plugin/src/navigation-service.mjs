import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';

export class NavigationService extends TypertRemoteService {
  constructor(ctx, relay, diagnostics) { super(ctx, 'agentPetNavigation'); this.relay = relay; this.readDiagnostics = diagnostics; }
  assertOwner() {
    // Invocation provenance is injected by DSH Gateway, never a browser argument.
    const invocation = this.ctx.invocation;
    if (invocation && invocation.peer.principal.kind !== 'owner') {
      throw new RemoteError('agent-pet/owner-required', 'Agent Pet navigation requires the host owner client', {});
    }
  }
  poll(clientId) { this.assertOwner(); return this.relay.poll(clientId); }
  result(clientId, commandId, status) { this.assertOwner(); return this.relay.result(clientId, commandId, status); }
  leave(clientId) { this.assertOwner(); return this.relay.leave(clientId); }
  diagnostics() { this.assertOwner(); return this.readDiagnostics(); }
}
