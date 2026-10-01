import { esc } from "./util.js";
import { appResourceRows, shareLabel, supportsCpuFallback, cpuFallbackAllocation } from "./app-resources.js";

export function resourceDialog({ title, spec, deployment, trigger, onClose, loadHost }){
  const dialog = document.createElement("dialog");
  dialog.className = "enc-resource-dialog";
  dialog.setAttribute("aria-labelledby", "enc-resource-title");
  const running = deployment.status === "running", hasFallback = supportsCpuFallback(spec);
  const group = (key, name, rows, share, label) =>
    '<section class="enc-resource-pool enc-resource-' + key + '" aria-label="' + name + '">'
    + '<div class="enc-resource-poolhead"><h3>' + name + '</h3><span>' + label + ' <b>' + shareLabel(share) + '</b></span></div>'
    + '<div class="enc-resource-track" aria-hidden="true">'
    + (share == null ? '' : '<span style="width:' + Math.min(100, share * 100) + '%"></span>') + '</div>'
    + '<dl class="enc-resource-metrics">' + rows.map(row => '<div><dt>' + row.name + ' required</dt><dd>' + row.required + '</dd></div>').join('') + '</dl></section>';
  const rows = appResourceRows(spec, deployment);
  dialog.innerHTML =
    '<div class="enc-resource-head"><div><h2 id="enc-resource-title">Resource breakdown</h2>'
    + '<p class="enc-resource-app">' + esc(title) + '</p></div>'
    + '<button type="button" class="enc-resource-close" aria-label="Close resource breakdown" autofocus>×</button></div>'
    + (hasFallback ? '<div class="enc-resource-tabs" role="tablist" aria-label="Resource mode">'
      + '<button type="button" role="tab" id="enc-resource-current-tab" aria-controls="enc-resource-current" aria-selected="true" tabindex="0">Current allocation</button>'
      + '<button type="button" role="tab" id="enc-resource-fallback-tab" aria-controls="enc-resource-fallback" aria-selected="false" tabindex="-1">CPU fallback</button></div>' : '')
    + '<div id="enc-resource-current"' + (hasFallback ? ' role="tabpanel" aria-labelledby="enc-resource-current-tab"' : '') + '>'
    + group('cpu', 'CPU / RAM', rows.slice(0, 2), rows[0].share, 'Allocated')
    + group('gpu', 'GPU / VRAM', rows.slice(2), rows[2].share, 'Allocated')
    + '<p class="enc-resource-note">' + (!spec ? 'App requirements are unavailable. ' : '')
    + (running ? 'Each bar shows the allocated share of one resource pool.' : 'This app is not running. Only its resource requirements are shown.') + '</p></div>'
    + (hasFallback ? '<div id="enc-resource-fallback" role="tabpanel" aria-labelledby="enc-resource-fallback-tab" hidden></div>' : '');

  let hostLoading = false, hostRead = false, host = null;
  const paintFallback = () => {
    const allocation = cpuFallbackAllocation(spec, host);
    const fallbackRows = appResourceRows(spec, deployment, "fallback");
    const currentShare = rows[0].share;
    let note = 'Runs without a GPU. ';
    if (hostLoading) note += 'Reading the current host’s capacity…';
    else if (allocation) {
      note += 'Minimum allocation on ' + allocation.name + '. ';
      if (allocation.share > 1) note += 'These requirements exceed this host’s CPU / RAM capacity.';
      else if (currentShare != null) note += 'Your current ' + shareLabel(currentShare) + ' CPU share '
        + (currentShare + 1e-9 >= allocation.share ? 'covers these requirements.' : 'is below this minimum.');
    } else note += 'A minimum share needs a host with reported RAM and CPU capacity. Fallback requirements are shown below.';
    dialog.querySelector('#enc-resource-fallback').innerHTML =
      '<p class="enc-resource-note enc-resource-context" role="status">' + esc(note) + '</p>'
      + group('cpu', 'CPU / RAM', fallbackRows.slice(0, 2), allocation?.share ?? null, 'Minimum share');
  };
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const selectTab = (tab) => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected)); t.tabIndex = selected ? 0 : -1;
      dialog.querySelector('#' + t.getAttribute('aria-controls')).hidden = !selected;
    }
    if (tab.id !== 'enc-resource-fallback-tab') return;
    if (!hostRead && !hostLoading && loadHost) {
      hostLoading = true;
      Promise.resolve().then(loadHost).then(value => { host = value; }).catch(() => {})
        .finally(() => { hostLoading = false; hostRead = true; if (dialog.isConnected) paintFallback(); });
    }
    paintFallback();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1)
        : e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? tabs[1 - index] : null;
      if (next) { e.preventDefault(); selectTab(next); next.focus(); }
    });
  });
  dialog.querySelector(".enc-resource-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", e => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove(); onClose?.();
    if (trigger?.isConnected) trigger.focus();
  }, { once: true });
  return dialog;
}
