/* ============================================================
   funding-r2 addon: hard navigation for the standalone /funding
   document. Stands in for the old soft-nav router's navigate(view)
   (js/boot.js is never loaded on this page): the two calls its
   bundled components make (wallet-button after sign-in ->
   dashboard; wallet popover "Add credit" -> checkout) become full
   document loads of those existing pages.
   ============================================================ */
export const VIEWS = Object.freeze(["dashboard", "checkout"]);

export function navigate(view) {
  if (!VIEWS.includes(view)) throw new Error("No page for " + String(view) + " from /funding");
  location.assign(new URL(view, document.baseURI).href);
}
