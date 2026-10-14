// Read-only local readback. Never emits keys, private URLs, or request bodies.
import { readFileSync, readdirSync } from 'node:fs';
import { INTERNAL_SECRET_PATH, PORTS, SOURCE_ROOT, loopback } from '../src/paths.mjs';
import { gatewayBinaryPath } from '../src/gateway-config.mjs';
import { selectedConfiguredListedModels } from '../src/provider-selection.mjs';

const key = readFileSync(INTERNAL_SECRET_PATH,'utf8').trim();
async function localJson(url, authenticated=false) {
  try {
    const response = await fetch(url,{headers:authenticated?{Authorization:`Bearer ${key}`}:{},signal:AbortSignal.timeout(2000)});
    if (!response.ok) return {ok:false,http_status:response.status};
    return await response.json();
  } catch { return {ok:false}; }
}
const [router,gateway,models] = await Promise.all([localJson(loopback(PORTS.router,'/health')),localJson(loopback(PORTS.gateway,'/health/liveliness'),true),localJson(loopback(PORTS.gateway,'/v1/models'),true)]);
const ids = new Set((models.data || []).map(m=>m.id));
const selected = selectedConfiguredListedModels();
const processes=[];
let literature=[];
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const args=readFileSync(`/proc/${entry}/cmdline`,'utf8').split('\0').filter(Boolean);
    const runtime = args.includes(`${SOURCE_ROOT}/src/start.mjs`) ? 'router-launcher' : args[0]===gatewayBinaryPath ? 'rust-gateway' : args.includes(`${SOURCE_ROOT}/.venv/bin/litellm`) ? 'litellm' : null;
    const isLiterature = args.some(a=> /\/(?:parallel_literature_stage\.py|literature_autonomy_supervisor\.sh|palcome-literature|literature_collector\.py)$/.test(a));
    if (!runtime&&!isLiterature) continue;
    const stat=readFileSync(`/proc/${entry}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    const status=readFileSync(`/proc/${entry}/status`,'utf8');
    const info={pid:Number(entry),ppid:Number(fields[1]),start_ticks:fields[19],rss_kb:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]||0)};
    if (runtime) processes.push({...info,runtime});
    else {
      const selectedFlags={};
      for(const flag of ['--worker-max-ingredients','--parallel-postprocess-lanes','--workers','--max-workers','--max-ingredients']) {
        const index=args.indexOf(flag); if(index>=0) selectedFlags[flag]=args[index+1];
      }
      literature.push({...info,command:args.find(a=>/literature/.test(a))?.split('/').at(-1),flags:selectedFlags});
    }
  } catch { /* Processes may exit between these read-only snapshots. */ }
}
console.log(JSON.stringify({router:{ok:router.ok===true,active_count:router.activity?.activeCount},gateway:{ok:gateway.ok===true,backend:gateway.backend||'legacy',service:gateway.service||null,selected_models:selected.length,selected_routable:selected.filter(m=>ids.has(m.gatewayModel)).length},processes,literature,io_psi:readFileSync('/proc/pressure/io','utf8').trim()}));
