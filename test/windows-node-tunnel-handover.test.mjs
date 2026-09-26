// A re-attach is make-before-break (windows/node/tunnel-handover.mjs): the standby tunnel takes over only when the relay
// accepts it, the tunnel it replaces is dropped without a redial, and a replacement that fails leaves the old one serving.
// The relay side of the same handover - the name never leaves the hub while a same-key standby attaches - is proven
// against the real relay in test/windows-node-hv-attach-relay.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tunnelHandover } from "../windows/node/tunnel-handover.mjs";

test("a standby accepted by the relay takes over; the replaced tunnel's close is neither a loss nor a redial", () => {
  const h = tunnelHandover(), a = { n: "a" }, b = { n: "b" };
  h.opened(a);
  assert.equal(h.accepted(a), null, "the first attach replaces nothing");
  assert.equal(h.canReattach(), true);
  h.opened(b, { standby: true });
  assert.equal(h.canReattach(), false, "one standby at a time");
  assert.equal(h.current, a, "the old tunnel serves until the relay accepts the new one");
  assert.equal(h.accepted(b), a);
  assert.equal(a.superseded, true);
  assert.equal(h.current, b);
  assert.deepEqual(h.closed(a), { lost: false, redial: false }, "the relay terminating the replaced tunnel must not take the node down");
  assert.equal(h.canReattach(), true);
});

test("a standby that fails leaves the old tunnel serving, and nothing redials", () => {
  const h = tunnelHandover(), a = {}, b = {};
  h.opened(a); h.accepted(a);
  h.opened(b, { standby: true });
  assert.deepEqual(h.closed(b), { lost: false, redial: false });
  assert.equal(h.current, a);
  assert.equal(h.canReattach(), true, "a later owners change may try again");
});

test("the serving tunnel lost while a standby is in flight: the node is off the relay, and the standby IS the redial", () => {
  const h = tunnelHandover(), a = {}, b = {};
  h.opened(a); h.accepted(a);
  h.opened(b, { standby: true });
  assert.deepEqual(h.closed(a), { lost: true, redial: false });
  assert.equal(h.accepted(b), null, "it replaces nothing: the old one is already gone");
  assert.equal(h.current, b);
  // ...and if that standby fails too, the node redials
  const h2 = tunnelHandover(), c = {}, d = {};
  h2.opened(c); h2.accepted(c); h2.opened(d, { standby: true });
  h2.closed(c);
  assert.deepEqual(h2.closed(d), { lost: false, redial: true });
});

test("without a standby, a lost tunnel is lost and redials, as before", () => {
  const h = tunnelHandover(), a = {};
  h.opened(a); h.accepted(a);
  assert.deepEqual(h.closed(a), { lost: true, redial: true });
  assert.equal(h.canReattach(), false, "nothing serves: the next dial is a plain one, not a standby");
});
