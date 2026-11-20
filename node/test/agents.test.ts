import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentBook, agentFromKey, parseAgentCaps } from '../src/router/agents.ts';
import { appendTrip, spendCsv, summarize } from '../src/spend.ts';

describe('agent wallets', () => {
  it('reads limits as name=dollars and refuses anything else at start', () => {
    assert.deepEqual([...parseAgentCaps('researcher=0.50, coder=$2')], [['researcher', 500_000n], ['coder', 2_000_000n]]);
    assert.equal(parseAgentCaps(undefined).size, 0);
    assert.equal(parseAgentCaps('').size, 0);
    for (const bad of ['researcher', 'researcher=0', 'researcher=-1', 'a b=1', 'x=1.1234567']) assert.throws(() => parseAgentCaps(bad), /--agent-cap takes name=dollars/);
  });

  it('names an agent in the key for tools that cannot add headers', () => {
    assert.equal(agentFromKey('agent/researcher'), 'researcher');
    assert.equal(agentFromKey(' agent/coder-2 '), 'coder-2');
    assert.equal(agentFromKey('orrery/task'), null);
    assert.equal(agentFromKey('sk-anything'), null);
    assert.equal(agentFromKey(null), null);
  });

  it('keeps what each agent spent today, says what is left, and reads today back from the log after a restart', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'orrery-agents-')), 'trips.jsonl');
    const now = Date.parse('2026-11-20T16:30:00Z');
    const trip = (at: number, cost: string, agent?: string) => ({ at, model: 'm', provider: 'p', providerName: 'P', inputTokens: 1, outputTokens: 1, cost, ...(agent ? { agent } : {}) });
    appendTrip(log, trip(Date.parse('2026-11-19T23:59:00Z'), '0.400000', 'researcher'));
    appendTrip(log, trip(Date.parse('2026-11-20T01:00:00Z'), '0.100000', 'researcher'));
    appendTrip(log, trip(Date.parse('2026-11-20T02:00:00Z'), '0.050000'));
    const book = new AgentBook(parseAgentCaps('researcher=0.50'), log);
    assert.deepEqual(book.left('researcher', now), { cap: 500_000n, spent: 100_000n, left: 400_000n });
    assert.equal(book.left('free-agent', now), null);
    book.spend('researcher', 450_000n, now);
    book.spend('free-agent', 7n, now);
    assert.deepEqual(book.left('researcher', now), { cap: 500_000n, spent: 550_000n, left: 0n });
    assert.deepEqual(book.list(now), [{ name: 'free-agent', cap: null, spent: 7n }, { name: 'researcher', cap: 500_000n, spent: 550_000n }]);
    appendTrip(log, trip(now, '0.450000', 'researcher'));
    const restarted = new AgentBook(parseAgentCaps('researcher=0.50'), log);
    assert.deepEqual(restarted.left('researcher', now), { cap: 500_000n, spent: 550_000n, left: 0n });
    assert.deepEqual(restarted.left('researcher', Date.parse('2026-11-21T00:00:01Z')), { cap: 500_000n, spent: 0n, left: 500_000n });
  });

  it('orrery spend --by agent gives each agent its bill, with the answers that named none apart', () => {
    const now = Date.parse('2026-11-20T17:30:00Z');
    const trip = (cost: string, agent?: string) => ({ at: now - 1_000, model: 'm', provider: 'p', providerName: 'P', inputTokens: 10, outputTokens: 5, cost, ...(agent ? { agent } : {}) });
    const { rows, total } = summarize([trip('0.000006', 'researcher'), trip('0.000006', 'researcher'), trip('0.000020', 'coder'), trip('0.000001')], 'agent', 86_400_000, now);
    assert.deepEqual(rows.map((r) => [r.key, r.answers, r.units]), [['coder', 1, 20n], ['researcher', 2, 12n], ['(no agent)', 1, 1n]]);
    assert.equal(total.units, 33n);
    assert.equal(spendCsv(rows, 'agent').split('\n')[0], 'agent,answers,input_tokens,output_tokens,paid_usdc');
  });
});
