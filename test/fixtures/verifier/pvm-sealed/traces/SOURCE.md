# Device traces: streamed sealed answers on a Pixel 10 with a malicious relay in the path

Copied byte for byte from branch `pvm-cpu/portable-runtime` at fbd87038 (`shielded/anchor/avf/results/pvm-cpu-streaming/
traces/`), the owner's streaming device run (build rt14, code hash `433dd3dfa08f5be8d77cefcc93cd5297acdf022d7fa9dfc9d584fe081f1c0dfd`,
app stream-probe `29e8942369846359b5936dbef1268c28f7097cccb3101b86345dc4dd8f4c1373`). Each `<mode>.json` is `{ mode, orig, sent }`:
`orig` is the VM's genuine stream as the relay recorded it, `sent` is what the relay delivered to the page after its
mutation. `l2/stream-replay.json` is launch 1's stream replayed to launch 2's page after a reconnect. `contexts.json` is
derived here from the owner's `results.jsonl` (the page's opening context `enc`, `exported`, `nonce` per label) and
`browser.jsonl` (the class the page reported); no response bodies are copied. Public content only: ciphertext, encapsulated
keys, the exported response secrets of finished exchanges and evidence nonces; none of it opens anything else.

What a passing test proves: with no device and no HPKE, every genuine `orig` opens complete under the page's context
(`mode-flip` is the exception by construction: the relay turned the request's key id, the VM could not open it and
answered its unauthenticated refusal, so `orig` is a refusal frame), and every mutated `sent` fails in this branch's
reader with the class the page reported, releasing only an authentic prefix of `orig`'s plaintext. The owner's reader at
the same commit is run beside it as a differential.
