// TEST facade for site/js/core/api.js (client-site-browser-r1; UNREVIEWED, NOT RUN). MOCKED SHELL.
// The /funding page reads only Enclave.address / chainId / provider / base and WALLET_SESSION_KEY. The shell sets these
// fields (the public fixture owner, chain 8453, the TEST fixture signer, this loopback origin) and emits enclave:wallet
// exactly as site/js/core/wallet.js does on accountsChanged / chainChanged. No wallet, no provider discovery.
export const WALLET_SESSION_KEY = "client-site-browser-r1-TEST-wallet-session";   // never the site's enclave_wallet_session
export const Enclave = { address: null, chainId: null, provider: null, base: null };
