import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkHolderSlots, checkSlots, Slots, slotsLine } from '../src/provider/slots.ts';

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
    assert.deepEqual(s.state, { size: 1, busy: 1, waiting: 4, holdersWaiting: 2, holdersAhead: 0, holderSlots: 0 });
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
    assert.deepEqual(s.state, { size: 1, busy: 0, waiting: 0, holdersWaiting: 0, holdersAhead: 2, holderSlots: 0 });
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
    assert.equal(slotsLine({ size: 4, busy: 4, waiting: 2, holdersWaiting: 1, holdersAhead: 3, holderSlots: 0 }), '  slots                 4 of 4 answering, 2 waiting (1 a holder); holders went ahead 3 times since start');
    assert.equal(slotsLine({ size: 4, busy: 1, waiting: 0, holdersWaiting: 0, holdersAhead: 1, holderSlots: 0 }), '  slots                 1 of 4 answering, none waiting; holders went ahead once since start');
    assert.equal(slotsLine({ size: 2, busy: 2, waiting: 3, holdersWaiting: 0, holdersAhead: 0, holderSlots: 0 }), '  slots                 2 of 2 answering, 3 waiting');
  });

  it('keeps holder lanes: requests without a holder price never take them, a holder goes straight in while they wait', async () => {
    const s = new Slots(2, 5_000, 1);
    const a = await s.take(0);
    assert.ok(a);
    const order: string[] = [];
    const b = s.take(0).then((t) => { order.push('plain-b'); return t!; });
    assert.deepEqual(s.state, { size: 2, busy: 1, waiting: 1, holdersWaiting: 0, holdersAhead: 0, holderSlots: 1 });
    const h = await s.take(3_500);
    order.push('holder');
    assert.ok(h);
    assert.equal(h!.passed, 1);
    assert.equal(h!.waitedMs, 0);
    assert.deepEqual(s.state, { size: 2, busy: 2, waiting: 1, holdersWaiting: 0, holdersAhead: 1, holderSlots: 1 });
    h!.give();
    assert.equal(s.state.waiting, 1, 'the holder lane it freed is not given to a request without a holder price');
    a!.give();
    (await b).give();
    assert.deepEqual(order, ['holder', 'plain-b']);
    assert.equal(slotsLine(s.state), '  slots                 0 of 2 answering (1 kept for holders), none waiting; holders went ahead once since start');
  });

  it('reads "holderSlots" only with "slots" and holder prices, leaving everyone else at least one slot', () => {
    assert.equal(checkHolderSlots(undefined, undefined, false), 0);
    assert.equal(checkHolderSlots(1, 4, true), 1);
    assert.equal(checkHolderSlots(3, 4, true), 3);
    assert.throws(() => checkHolderSlots(1, undefined, true), /set "slots" too/);
    assert.throws(() => checkHolderSlots(1, 4, false), /set "holder" tiers too/);
    for (const bad of [0, 4, 5, 1.5, '1']) assert.throws(() => checkHolderSlots(bad, 4, true), /"holderSlots" must be a whole number from 1 to 3/);
  });

  it('reads "slots" from provider.json as a whole number from 1 to 1,024', () => {
    assert.equal(checkSlots(undefined), undefined);
    assert.equal(checkSlots(4), 4);
    for (const bad of [0, -1, 2.5, 1_025, '4', null]) assert.throws(() => checkSlots(bad), /"slots" must be a whole number from 1 to 1024/);
  });
});
