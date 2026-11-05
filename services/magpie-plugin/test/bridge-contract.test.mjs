import test from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../../src/model.mjs';
import { normalizedTurn } from '../src/projection.mjs';

test('actual bridge accepts normalized identity and replaces observation row with real turn', () => {
  const model = new Model();
  const args = { sourceId: 'magpie-local', session: { id: 'synthetic', header: { isSeeded: false }, inheritedEventCount: 0 },
    agent: { status: 'running' }, live: new Map(), snapshot: { asOfSeq: 1, values: {} }, revision: 1 };
  assert.equal(model.ingest(normalizedTurn({ ...args, lifecycle: { turn: 0, startSeq: null, ended: false } })), true);
  const current = normalizedTurn({ ...args, revision: 2, lifecycle: { turn: 1, startSeq: 1, ended: false } });
  assert.equal(model.ingest(current), true);
  assert.equal(model.tasks.size, 1);
  assert.equal([...model.identities.values()][0].run_id, 'turn-1-1');
  assert.equal(model.ingest(current), false);
  assert.equal([...model.tasks.values()][0].task_outcome, null);
});
