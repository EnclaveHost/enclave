import { esc } from './util.js';
import { appResourceRows, shareLabel, supportsCpuFallback } from './app-resources.js';
import { shareBounds, changeShares } from './share-allocation.js';

export function shareEditor({ id, spec, mins, allocation, maxGpu, rev, cpuMinimum, editable = true, hostName, hardware, onCompareHosts, onChange = () => {} }) {
  const root = document.createElement('div');
  root.className = 'enc-share-editor';
  const options = { mins, maxGpu, rev, cpuMinimum };
  let draft = { ...allocation }, fallback = false;
  const hasFallback = supportsCpuFallback(spec);
  const pct = value => shareLabel(value / 1000);
  const number = value => String(Number(value.toFixed(2)));
  const memoryAt = (key, value) => hardware ? number((key === 'cpu' ? hardware.nodeRamGb : hardware.cardVramGb) * value / 1000) + ' GB' : pct(value);
  const capacityAt = (key, value) => !hardware ? pct(value) : memoryAt(key, value) + (key === 'cpu'
    ? ' RAM · ' + number(hardware.nodeGflops * value / 1000) + ' GFLOPs CPU'
    : ' VRAM · ' + number(hardware.cardTflops * value / 1000) + ' TFLOPs GPU');
  const panelId = key => esc(id + '-' + key);
  const pool = (key, mode) => {
    const name = key === 'cpu' ? 'CPU / RAM' : 'GPU / VRAM', inputId = panelId(mode + '-' + key);
    return '<section class="enc-resource-pool enc-resource-' + key + '" data-pool="' + key + '" data-mode="' + mode + '">'
      + '<div class="enc-resource-poolhead"><label for="' + inputId + '">' + name + '</label><output for="' + inputId + '"></output></div>'
      + '<div class="enc-share-control"><div class="enc-share-rail" aria-hidden="true">'
      + '<span class="enc-share-fill"></span><span class="enc-share-blocked"></span>'
      + '<span class="enc-share-limit"></span><span class="enc-share-limit-label"></span></div>'
      + '<input class="enc-share-slider" id="' + inputId + '" type="range" step="0.1" aria-describedby="' + inputId + '-bounds"></div>'
      + '<div class="enc-share-bounds" id="' + inputId + '-bounds"></div><dl class="enc-resource-metrics"></dl></section>';
  };
  root.innerHTML = '<h3>Allocation' + (hostName ? ' on ' + esc(hostName) : '') + '</h3><p class="enc-resource-note enc-resource-context">'
    + (editable ? 'Drag to adjust this host’s allocation. ' : 'Allocation changes are unavailable for this deployment. ')
    + 'Memory and compute in each pool move together. The marked minimum keeps the app runnable.</p>'
    + (onCompareHosts ? '<button type="button" class="btn btn-sm enc-compare-hosts">Need more? Compare host capacity ↓</button>' : '')
    + (hasFallback ? '<div class="enc-resource-tabs" role="tablist" aria-label="Resource mode">'
      + '<button type="button" role="tab" id="' + panelId('current-tab') + '" aria-controls="' + panelId('current') + '" aria-selected="true">Allocation</button>'
      + '<button type="button" role="tab" id="' + panelId('fallback-tab') + '" aria-controls="' + panelId('fallback') + '" aria-selected="false" tabindex="-1">CPU fallback</button></div>' : '')
    + '<div id="' + panelId('current') + '"' + (hasFallback ? ' role="tabpanel" aria-labelledby="' + panelId('current-tab') + '"' : '') + '>'
    + pool('cpu', 'current') + pool('gpu', 'current') + '</div>'
    + (hasFallback ? '<div id="' + panelId('fallback') + '" role="tabpanel" aria-labelledby="' + panelId('fallback-tab') + '" hidden>'
      + '<p class="enc-resource-note enc-resource-context">This is the same CPU / RAM allocation used in Allocation. Changes here keep your GPU share and size the CPU allocation for running without a GPU.</p>'
      + pool('cpu', 'fallback') + '</div>' : '')
    + '<p class="enc-share-warning" role="status"></p>';
  const problem = () => {
    if (!spec) return 'App requirements are unavailable.';
    const b = shareBounds(draft, options, fallback);
    if (b.cpuMin > b.cpuMax || b.gpuMin > b.gpuMax) return 'The app’s minimum allocation exceeds the available share limits.';
    if (draft.cpuMilli < b.cpuMin) return 'CPU / RAM needs at least ' + pct(b.cpuMin) + (fallback ? ' for CPU fallback.' : '.');
    if (draft.gpuMilli < b.gpuMin) return 'GPU / VRAM needs at least ' + pct(b.gpuMin) + '.';
    if (draft.cpuMilli > b.cpuMax || draft.gpuMilli > b.gpuMax) return 'The allocation exceeds the available share limits.';
    return '';
  };
  const render = () => {
    for (const group of root.querySelectorAll('[data-pool]')) {
      const key = group.dataset.pool, isFallback = group.dataset.mode === 'fallback';
      const b = shareBounds(draft, options, isFallback), min = b[key + 'Min'], max = b[key + 'Max'];
      const input = group.querySelector('input'), value = draft[key + 'Milli'];
      if (key === 'gpu' && hardware && !hardware.cardVramGb) { group.hidden = true; continue; }
      // Show the saved draft faithfully even if requirements have risen.
      // The input handler enforces the app floor on every actual edit.
      const low = Math.min(min, max, value), high = Math.max(max, value);
      input.min = low / 10; input.max = high / 10; input.value = value / 10;
      input.disabled = !editable || !spec || min > max;
      input.setAttribute('aria-valuetext', capacityAt(key, value) + '; ' + pct(value) + ' of ' + hostName + '; minimum ' + capacityAt(key, min));
      // Keep the visible rail on the full capacity scale. The native range
      // occupies only its permitted segment, so its thumb stops exactly at
      // the minimum marker, including while dragging beyond the left edge.
      // Its 20px thumb needs the same inset as the rail at both ends.
      const scale = Math.max(1000, high), minimum = Math.min(100, min / scale * 100);
      const control = group.querySelector('.enc-share-control');
      control.style.setProperty('--share-fill', (value / scale * 100) + '%');
      control.style.setProperty('--share-minimum', minimum + '%');
      control.style.setProperty('--slider-start', (low / scale * 100) + '%');
      control.style.setProperty('--slider-inset', (low / scale * 20) + 'px');
      control.style.setProperty('--slider-span', ((high - low) / scale * 100) + '%');
      control.style.setProperty('--slider-padding', (20 * (1 - (high - low) / scale)) + 'px');
      control.style.setProperty('--minimum-label-shift', minimum < 15 ? '0%' : minimum > 85 ? '-100%' : '-50%');
      group.querySelector('.enc-share-limit-label').textContent = 'Min ' + memoryAt(key, min);
      group.querySelector('output').innerHTML = esc(capacityAt(key, value)) + '<small class="enc-share-percentage">' + pct(value) + ' of ' + esc(hostName || 'host') + '</small>';
      group.querySelector('.enc-share-bounds').innerHTML = '<span>' + memoryAt(key, 0) + '</span><span class="enc-share-floor-text">'
        + (key === 'gpu' && hasFallback ? 'GPU optional' : 'Hatched area below app minimum') + '</span><span>' + memoryAt(key, scale) + '</span>';
      const rows = appResourceRows(spec, { resources: { gpuShare: draft.gpuMilli / 1000 } }, isFallback ? 'fallback' : 'current');
      group.querySelector('dl').innerHTML = rows.slice(key === 'cpu' ? 0 : 2, key === 'cpu' ? 2 : 4)
        .map(row => '<div><dt>' + row.name + (key === 'gpu' && hasFallback ? ' preferred' : ' required') + '</dt><dd>' + row.required + '</dd></div>').join('');
    }
    root.querySelector('.enc-share-warning').textContent = problem();
  };
  root.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
    const group = input.closest('[data-pool]');
    draft = changeShares(draft, group.dataset.pool, Number(input.value) * 10, options, group.dataset.mode === 'fallback');
    render(); onChange();
  }));
  root.querySelector('.enc-compare-hosts')?.addEventListener('click', onCompareHosts);
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const selectTab = tab => {
    fallback = tab === tabs[1];
    for (const t of tabs) {
      const active = t === tab;
      t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1;
      root.querySelector('[id="' + t.getAttribute('aria-controls') + '"]').hidden = !active;
    }
    render(); onChange();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1)
        : e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? tabs[1 - index] : null;
      if (next) { e.preventDefault(); selectTab(next); next.focus(); }
    });
  });
  render();
  return { element: root, values: () => ({ ...draft }), problem,
    cpuMinimum: () => shareBounds(draft, options, fallback).cpuMin / 10 };
}
