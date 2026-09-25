// avf-lab-root-preload.mjs -- TEST-ONLY. Loaded with `node --import test/fixtures/avf-lab-root-preload.mjs relay/api-relay.js`
// by test/pvm-u7-integration.test.mjs into a SPAWNED lab relay, so a synthetic AVF phone (test/fixtures/avf-synthetic.mjs, a
// lab CA) can attach to the REAL api-relay. It only ADDS the lab root's pin (TEST_AVF_LAB_ROOT_PIN) to relay/avf-verify.mjs's
// root map in THAT process; the production pins stay exactly as they are. Nothing in relay/, relay/deploy.sh, a systemd unit
// or CI's deploy path references this file (the integration test asserts so), and no relay code reads a root from its
// environment: a deployed relay trusts Google's roots only. Reviewed with the verifier session (enclave-99's condition 4).
import { GOOGLE_ATTESTATION_ROOT_SHA256 } from "../../relay/avf-verify.mjs";

const pin = String(process.env.TEST_AVF_LAB_ROOT_PIN || "");
if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error("avf-lab-root-preload: TEST_AVF_LAB_ROOT_PIN must be 64 lowercase hex (the lab CA root's sha256)");
if (GOOGLE_ATTESTATION_ROOT_SHA256.has("test-lab-root")) throw new Error("avf-lab-root-preload: loaded twice");
GOOGLE_ATTESTATION_ROOT_SHA256.set("test-lab-root", pin);
