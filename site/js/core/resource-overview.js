import { esc } from './util.js';
import { appResourceRows, supportsCpuFallback } from './app-resources.js';
import { resourceHosts, cpuMinimumOn } from './resource-plan.js';

export function resourceOverview({ spec, fleet, configCid = '', currentHost, unresolvedHost = false, editable = true, onChooseHost = () => {} }) {
  const root = document.createElement('div');
  root.className = 'enc-resource-overview';
  const n = value => Number.isFinite(value) ? String(Number(value.toFixed(2))) : '—';
  let hosts = [], error = '';
  try { hosts = spec ? resourceHosts(spec, fleet, configCid) : []; }
  catch { error = 'Host compatibility could not be checked. Review this deployment’s configuration in Pin.'; }
  const requirements = mode => appResourceRows(spec, null, mode).map(r => '<div><dt>' + r.name
    + (mode !== 'fallback' && supportsCpuFallback(spec) && ['gpu', 'vram'].includes(r.key) ? ' (preferred)' : '')
    + '</dt><dd>' + r.required + '</dd></div>').join('');
  root.innerHTML = (!currentHost
    ? '<h3>App requirements</h3><p class="enc-resource-note enc-resource-context">' + (unresolvedHost
      ? 'The current host’s capacity report is unavailable. Allocation controls will return when its capacity can be verified.'
      : 'No host is running this app. These are its resource requirements; there is no allocated capacity to adjust yet.') + '</p>'
      + '<dl class="enc-resource-requirements">' + requirements('current') + '</dl>'
      + (supportsCpuFallback(spec) ? '<details class="enc-resource-fallback"><summary>CPU fallback requirements</summary><dl class="enc-resource-requirements">'
        + appResourceRows(spec, null, 'fallback').slice(0, 2).map(r => '<div><dt>' + r.name + '</dt><dd>' + r.required + '</dd></div>').join('')
        + '</dl></details>' : '') : '')
    + '<h3>' + (currentHost ? 'Need more capacity?' : 'Choose where to run') + '</h3>'
    + '<p class="enc-resource-note enc-resource-context">' + (currentHost
      ? 'The bars above end at ' + esc(currentHost.name) + '’s physical capacity. Choose a larger host in Pin to scale further, then adjust the allocation after it starts there.'
      : 'Compare host capacity below, then use Pin to choose a host and start the app. Once it is running, this panel shows the actual allocation on that host.')
      + ' A share is a fraction of one host, so the same percentage buys different resources on different hosts.</p>'
    + '<div class="enc-resource-hosts">' + hosts.map((h, i) => {
      const current = currentHost?.row.id?.toLowerCase() === h.id;
      const gpu = h.gpu && h.mins ? Math.min(1000, Math.max(h.mins.gpuPct, h.mins.gpuNeedPct) * 10) : 0;
      const cpu = h.mins ? cpuMinimumOn(h, gpu) : null;
      const a = h.row.availability;
      const waiting = !h.reason && (Number(a.cpuShareFree) * 100 < cpu || Number(a.gpuShareFree) * 100 < (h.mins?.gpuPct || 0));
      return '<section class="enc-resource-host"><div class="enc-resource-host-head"><strong>' + esc(h.name) + '</strong>'
        + (current ? '<span class="ap-badge ok">current host</span>' : '') + '</div>'
        + '<p>' + n(h.spec.nodeRamGb) + ' GB RAM · ' + n(h.spec.nodeGflops) + ' GFLOPs CPU</p>'
        + '<p>' + (h.gpu ? n(h.spec.cardVramGb) + ' GB VRAM · ' + n(h.spec.cardTflops) + ' TFLOPs GPU' : 'CPU only') + '</p>'
        + '<p class="enc-resource-host-fit">' + esc(h.reason || ('App minimum: ' + cpu + '% CPU'
          + (h.mins.gpuPct ? ' · ' + h.mins.gpuPct + '% GPU' : '') + (waiting && !current ? ' · may need to wait for capacity' : ''))) + '</p>'
        + (!current && !h.reason && editable ? '<button type="button" class="btn btn-sm" data-host="' + i + '">Choose ' + esc(h.name) + ' in Pin →</button>' : '')
        + '</section>';
    }).join('') + '</div>'
    + (error || !hosts.length ? '<p class="enc-resource-note">' + esc(error || 'No host capacity reports are available. Requirements stay visible; refresh this panel when hosts are available.') + '</p>' : '')
    + (editable ? '<button type="button" class="btn btn-sm enc-resource-open-pin">Open Pin to manage placement →</button>' : '');
  root.querySelectorAll('[data-host]').forEach(button => button.addEventListener('click', () => onChooseHost(hosts[Number(button.dataset.host)].name)));
  root.querySelector('.enc-resource-open-pin')?.addEventListener('click', () => onChooseHost(''));
  return root;
}
