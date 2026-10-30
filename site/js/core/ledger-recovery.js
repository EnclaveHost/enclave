// Recovery on a ledger the platform administrator replaced (address-book profiles): which path may push refund(id) for one
// holding (independent-chain withReplacedHoldings). Pure; the dashboard and the unit tests share it.

/* Who can push refund(id) for one holding from this dashboard, judged by the record's owner ON THAT LEDGER:
   "account" - the passkey account's Safe owns it there (the account's own path: a wallet only if it pays the gas);
   "wallet"  - the connected wallet owns it there (wallet dashboards only: an account dashboard never routes through an
               unrelated gas-paying wallet);
   once that ledger is retired anyone may push the refund (it always pays the owner there), through whichever of the two
   this dashboard acts as; otherwise "" - e.g. a session vault's record, which only the vault could refund, and the vault
   acts on the book's current ledger. */
export function recoveryRoute(holding, { identity, acting }){
  const owner = String(holding.owner || "").toLowerCase(), me = String(acting || "").toLowerCase();
  if (!me) return "";
  const route = identity === "account" ? "account" : "wallet";
  return owner === me || holding.ledgerRetired ? route : "";
}
