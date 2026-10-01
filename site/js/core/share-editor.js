import { esc } from './util.js';
import { appResourceRows, shareLabel, supportsCpuFallback } from './app-resources.js';
import { shareBounds, changeShares } from './share-allocation.js';

export function shareEditor({ id, spec, mins, allocation, maxGpu, rev, cpuMinimum, editable = true, hostName, onChange = () => {} }) {
  const root = document.createElement('div');
  root.className = 'enc-share-editor';
  const options = { mins, maxGpu, rev, cpuMinimum };
  let draft = { ...allocation }, fallback = false;
  const hasFallback = supportsCpuFallback(spec);
  const pct = value => shareLabel(value / 1000);
  const panelId = key => esc(id + '-' + key);
  const pool = (key, mode) => {
    const name = key === 'cpu' ? 'CPU / RAM' : 'GPU / VRAM', inputId = panelId(mode + '-' + key);
    return '<section class="enc-resource-pool enc-resource-' + key + '" data-pool="' + key + '" data-mode="' + mode + '">'
      + '<div class="enc-resource-poolhead"><label for="' + inputId + '">' + name + '</label><output for="' + inputId + '"></output></div>'
      + '<input class="enc-share-slider" id="' + inputId + '" type="range" step="0.1" aria-describedby="' + inputId + '-bounds">'
      + '<div class="enc-share-bounds" id="' + inputId + '-bounds"></div><dl class="enc-resource-metrics"></dl></section>';
  };
  root.innerHTML = '<p class="enc-resource-note enc-resource-context">'
    + (editable ? 'Drag to adjust the allocation. ' : 'Allocation changes are unavailable for this deployment. ')
    + (hostName ? 'Minimums are based on ' + esc(hostName) + '.' : 'Minimums are based on the fleet’s reported hardware.') + '</p>'
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
      // Show the saved draft faithfully even if requirements have risen.
      // The input handler enforces the app floor on every actual edit.
      const low = Math.min(min, max, value), high = Math.max(max, value);
      input.min = low / 10; input.max = high / 10; input.value = value / 10;
      input.disabled = !editable || !spec || min > max;
      input.setAttribute('aria-valuetext', pct(value) + ' allocated; minimum ' + pct(min));
      const fill = high > low ? Math.max(0, Math.min(100, (value - low) / (high - low) * 100)) : 100;
      input.style.setProperty('--share-fill', fill + '%');
      group.querySelector('output').textContent = pct(value);
      group.querySelector('.enc-share-bounds').innerHTML = '<span>Minimum ' + pct(min)
        + (key === 'gpu' && hasFallback ? ' · optional GPU' : '') + '</span><span>' + pct(max) + '</span>';
      const rows = appResourceRows(spec, { resources: { gpuShare: draft.gpuMilli / 1000 } }, isFallback ? 'fallback' : 'current');
      group.querySelector('dl').innerHTML = rows.slice(key === 'cpu' ? 0 : 2, key === 'cpu' ? 2 : 4)
        .map(row => '<div><dt>' + row.name + ' required</dt><dd>' + row.required + '</dd></div>').join('');
    }
    root.querySelector('.enc-share-warning').textContent = problem();
  };
  root.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
    const group = input.closest('[data-pool]');
    draft = changeShares(draft, group.dataset.pool, Number(input.value) * 10, options, group.dataset.mode === 'fallback');
    render(); onChange();
  }));
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
