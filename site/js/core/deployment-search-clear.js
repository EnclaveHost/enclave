// Enhance both the initial deployments panel and panels mounted by soft navigation.
const selector = "c-deployments .enc-search";
const enhanced = new WeakSet();

function enhance(input) {
  if (enhanced.has(input)) return;
  enhanced.add(input);

  const field = document.createElement("div");
  field.className = "enc-search-field";
  input.before(field);
  field.append(input);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "enc-search-clear";
  clear.setAttribute("aria-label", "Clear search");
  clear.title = "Clear search";
  clear.textContent = "×";
  field.append(clear);

  const sync = () => { clear.hidden = input.value.length === 0; };
  input.addEventListener("input", sync);
  clear.addEventListener("click", () => {
    input.value = "";
    // Use the existing filter handler so rows and pagination update together.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
  });
  sync();
}

function enhanceWithin(root) {
  if (root.matches?.(selector)) enhance(root);
  root.querySelectorAll?.(selector).forEach(enhance);
}

enhanceWithin(document);
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) enhanceWithin(node);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
