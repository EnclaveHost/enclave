// TEST facade for site/js/core/wallet.js (client-site-browser-r1; UNREVIEWED, NOT RUN). MOCKED SHELL.
// The page calls connectWallet() only from its "Connect wallet" button. This harness never discovers or injects a
// wallet: the owner is connected by the shell's TEST Start button (fixture owner + TEST fixture signer).
export async function connectWallet() {
  throw new Error("TEST harness: no wallet here; the fixture owner is connected by the harness TEST Start button");
}
