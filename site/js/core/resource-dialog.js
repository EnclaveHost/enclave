import { esc } from "./util.js";
import { appResourceRows, shareLabel } from "./app-resources.js";

export function resourceDialog({ title, spec, deployment, trigger, onClose }){
  const dialog = document.createElement("dialog");
  dialog.className = "enc-resource-dialog";
  dialog.setAttribute("aria-labelledby", "enc-resource-title");
  dialog.setAttribute("aria-describedby", "enc-resource-note");
  const running = deployment.status === "running";
  dialog.innerHTML =
    '<div class="enc-resource-head"><div><h2 id="enc-resource-title">Resource breakdown</h2>'
    + '<p class="enc-resource-app">' + esc(title) + '</p></div>'
    + '<button type="button" class="enc-resource-close" aria-label="Close resource breakdown" autofocus>×</button></div>'
    + '<table class="enc-resource-chart"><caption class="sr-only">App requirements and allocated host shares</caption>'
    + '<thead><tr><th scope="col">Resource</th><th scope="col">Required</th><th scope="col">Allocated share</th></tr></thead><tbody>'
    + appResourceRows(spec, deployment).map(row =>
      '<tr class="enc-resource-' + row.key + '"><th scope="row">' + row.name + '</th><td>' + row.required + '</td><td>'
      + '<div class="enc-resource-allocation"><span class="enc-resource-track" aria-hidden="true">'
      + (row.share == null ? '' : '<span style="width:' + Math.min(100, row.share * 100) + '%"></span>')
      + '</span><span title="' + esc(row.share == null ? 'No running allocation reported' : row.pool + ' pool allocated to this app') + '">'
      + shareLabel(row.share) + '</span></div></td></tr>').join('')
    + '</tbody></table>'
    + '<p id="enc-resource-note" class="enc-resource-note">'
    + (!spec ? 'App requirements are unavailable. ' : '')
    + (running ? 'Bars show allocated host shares. RAM and CPU share the CPU pool; VRAM and GPU compute share the GPU pool.'
       : 'This app is not running. Only its resource requirements are shown.')
    + '</p>';
  dialog.querySelector(".enc-resource-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", e => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
    if (trigger?.isConnected) trigger.focus();
  }, { once: true });
  return dialog;
}
