// TEST facade for site/js/core/sessions.js (client-site-browser-r1; UNREVIEWED, NOT RUN). MOCKED SHELL around ACTUAL code.
//   sdk()             the ACTUAL vendored SDK bundle (served as /harness/vendor/sessions.js = source/sdk/sessions/dist/
//                     browser.mjs, hash-gated by the server), with ONE change: IndexedDbStore() without a name opens this
//                     run's random TEST database (any other name is refused).
//   sessionsConfig()  the same call as the site: new S.RelayClient(relayRoot()).config() (null when sessions are off);
//                     the harness can switch on a labelled "config unavailable" fault for the owner-controls phase.
//   relayRoot()       the site's own expression over Enclave.base (the shell sets Enclave.base = <loopback origin>/v1).
//   accountFromSession()  counted no-op (the site's account login is not part of this harness).
import { Enclave } from "./api.js";
import { H } from "../harness-state.js";

let _sdk = null;
export async function sdk() {
  if (!_sdk) {
    _sdk = import("/harness/vendor/sessions.js").then((S) => {
      class IndexedDbStore extends S.IndexedDbStore {
        constructor(...args) {
          if (args.length) throw new Error("TEST harness: the page must not choose a database name");
          super(H.dbName("legacy"));
        }
      }
      return Object.freeze({ ...S, IndexedDbStore });
    });
  }
  return _sdk;
}
export async function sessionsConfig() {
  if (H.configUnavailable) throw new Error("TEST fault (client-site-browser-r1): sessions config / catalog unavailable");
  try {
    const S = await sdk();
    return await new S.RelayClient(relayRoot()).config();
  } catch (e) {
    if (e && (e.code === "sessions_disabled" || /503|sessions_disabled/.test(String(e.message)))) return null;
    throw e;
  }
}
export const relayRoot = () => String(Enclave.base || "").replace(/\/v1\/?$/, "");
export async function accountFromSession() { H.counters.accountFromSession += 1; return null; }
