/* funding-r2 addon entry: the standalone /funding document's only module.
   Boots the qualified page once; the wallet control it bakes in restores the
   wallet and sessions through its own renderedCallback, as on every page. */
import { boot } from "enclave-addon:funding-page";
import "enclave-addon:wallet-button";
boot();
