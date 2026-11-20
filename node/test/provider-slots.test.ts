import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlots, Slots, slotsLine } from '../src/provider/slots.ts';

describe('provider slots', () => {
  it('lets in as many answers as there are slots, then holders go first, the larger discount first, then in order', async () => {
    const s = new Slots(1, 5_000);
    const first = await s.take(0);
    assert.ok(first);
    const order: string[] = [];
    const wait = (name: string, off: number) => s.take(off).then((t) => { order.push(name); return t!; });
    const a = wait('plain-a', 0);
    const b = wait('plain-b', 0);
    const h20 = wait('holder-20', 2_000);
    const h35 = wait('holder-35', 3_500);
    assert.deepEqual(s.state, { size: 1, busy: 1, waiting: 4, holdersWaiting: 2, holdersAhead: 0 });
    first!.give();
    const t35 = await h35;
    assert.equal(t35.passed, 2);
    t35.give();
    const t20 = await h20;
    assert.equal(t20.passed, 2);
    t20.give();
    const ta = await a;
    assert.equal(ta.passed, 0);
    ta.give();
    (await b).give();
    assert.deepEqual(order, ['holder-35', 'holder-20', 'plain-a', 'plain-b']);
    assert.deepEqual(s.state, { size: 1, busy: 0, waiting: 0, holdersWaiting: 0, holdersAhead: 2 });
  });

  it('gives a slot back once however often it is called, and turns a request away after waiting too long', async () => {
    const s = new Slots(1, 30);
    const held = await s.take(0);
    const late = await s.take(3_500);
    assert.equal(late, null);
    assert.equal(s.state.waiting, 0);
    held!.give();
    held!.give();
    assert.equal(s.state.busy, 0);
    const again = await s.take(0);
    assert.ok(again);
    assert.equal(s.state.busy, 1);
  });

  it('counts a holder as going ahead only when it passed a request without a holder price that came first', async () => {
    const s = new Slots(1, 5_000);
    const first = await s.take(0);
    const h = s.take(2_000);
    const p = s.take(0);
    first!.give();
    const th = await h;
    assert.equal(th!.passed, 0);
    th!.give();
    (await p)!.give();
    assert.equal(s.state.holdersAhead, 0);
  });

  it('says in provider status how many slots are answering, who waits and how often holders went ahead', () => {
    assert.equal(slotsLine({ size: 4, busy: 4, waiting: 2, holdersWaiting: 1, holdersAhead: 3 }), '  slots                 4 of 4 answering, 2 waiting (1 a holder); holders went ahead 3 times since start');
    assert.equal(slotsLine({ size: 4, busy: 1, waiting: 0, holdersWaiting: 0, holdersAhead: 1 }), '  slots                 1 of 4 answering, none waiting; holders went ahead once since start');
    assert.equal(slotsLine({ size: 2, busy: 2, waiting: 3, holdersWaiting: 0, holdersAhead: 0 }), '  slots                 2 of 2 answering, 3 waiting');
  });

  it('reads "slots" from provider.json as a whole number from 1 to 1,024', () => {
    assert.equal(checkSlots(undefined), undefined);
    assert.equal(checkSlots(4), 4);
    for (const bad of [0, -1, 2.5, 1_025, '4', null]) assert.throws(() => checkSlots(bad), /"slots" must be a whole number from 1 to 1024/);
  });
});
