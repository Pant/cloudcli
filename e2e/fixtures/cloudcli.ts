import { createServer, type Server } from 'node:http';
import { test as base, expect, type Page } from '@playwright/test';

const harness = `<!doctype html><meta charset="utf-8"><style>
body{font:14px sans-serif;margin:0}.sessions{display:flex;gap:8px;padding:8px}.viewport{height:160px;overflow:auto;border:1px solid;width:360px}.row{box-sizing:border-box;min-height:40px;padding:8px;border-bottom:1px solid #ccc}
</style><div class="sessions"><button data-session="A">A</button><button data-session="B">B</button></div><div class="viewport" data-testid="viewport"><div id="rows"></div></div><script>
const dbName='cloudcli-e2e', channel=new BroadcastChannel('cloudcli-e2e'), rows=document.querySelector('#rows'), viewport=document.querySelector('.viewport');
let state={session:'A',sessions:{A:[],B:[]},revision:{A:0,B:0},cursor:{A:{generation:1,seq:0},B:{generation:1,seq:0}},epoch:0}, deferred=new Map(), scrolls={};
const clone=x=>JSON.parse(JSON.stringify(x));
function unique(xs){const m=new Map; xs.forEach(x=>m.set(x.id,x)); return [...m.values()]}
function render(){rows.replaceChildren(...state.sessions[state.session].map(m=>{const d=document.createElement('div');d.className='row';d.dataset.messageKey=m.id;d.textContent=m.content;d.style.height=(m.height||40)+'px';return d}));}
function save(){return new Promise((ok,no)=>{const r=indexedDB.open(dbName,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>no(r.error);r.onsuccess=()=>{const t=r.result.transaction('state','readwrite');t.objectStore('state').put(clone(state),'snapshot');t.oncomplete=()=>{r.result.close();ok()}}})}
function load(){return new Promise(ok=>{const r=indexedDB.open(dbName,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const q=r.result.transaction('state').objectStore('state').get('snapshot');q.onsuccess=()=>{if(q.result)state=q.result;r.result.close();render();ok()}}})}
function publish(){save();channel.postMessage(clone(state));render()}
channel.onmessage=e=>{state=e.data;render()};
document.querySelectorAll('button').forEach(b=>b.onclick=()=>{scrolls[state.session]=viewport.scrollTop;state.session=b.dataset.session;render();requestAnimationFrame(()=>viewport.scrollTop=scrolls[state.session]||0)});
function rest(name,session,messages,revision){return new Promise(resolve=>deferred.set(name,()=>{if(revision>=state.revision[session]){state.sessions[session]=unique(messages);state.revision[session]=revision;publish()}resolve()}))}
function frame(session,generation,seq,message){const c=state.cursor[session];if(generation<c.generation||generation===c.generation&&seq<=c.seq)return 'stale';if(generation!==c.generation?seq!==1:seq!==c.seq+1)return 'gap';state.cursor[session]={generation,seq};state.sessions[session]=unique([...state.sessions[session],message]);publish();return 'accepted'}
window.harness={state,load,save,publish,rest,resolve:n=>{const f=deferred.get(n);deferred.delete(n);f()},frame,recover:(s,msgs,rev)=>{state.sessions[s]=unique(msgs);state.revision[s]=rev;publish()},rotateToken:()=>++state.epoch,grow:(id,h)=>{const row=[...document.querySelectorAll('.row')].find(x=>x.dataset.messageKey===id),atBottom=viewport.scrollHeight-viewport.scrollTop-viewport.clientHeight<2,anchor=[...document.querySelectorAll('.row')].find(x=>x.getBoundingClientRect().bottom>viewport.getBoundingClientRect().top),before=anchor?.getBoundingClientRect().top;row.style.height=h+'px';requestAnimationFrame(()=>{if(atBottom)viewport.scrollTop=viewport.scrollHeight;else if(anchor)viewport.scrollTop+=anchor.getBoundingClientRect().top-before})}};
load();
</script>`;

type Fixtures = { stablePage: Page };
type WorkerFixtures = { harnessUrl: string };
export const test = base.extend<Fixtures, WorkerFixtures>({
  harnessUrl: [async ({}, use) => {
    let server: Server;
    await new Promise<void>((resolve) => { server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(harness); }).listen(0, '127.0.0.1', resolve); });
    const address = server!.address();
    await use(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }, { scope: 'worker' }],
  stablePage: async ({ page, harnessUrl }, use) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') failures.push(`console.error: ${message.text()}`); });
    await page.addInitScript(() => addEventListener('unhandledrejection', event => console.error('unhandledrejection', event.reason)));
    await page.goto(harnessUrl);
    await use(page);
    expect(failures, failures.join('\n')).toEqual([]);
    const keys = await page.locator('[data-message-key]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.messageKey));
    expect(new Set(keys).size).toBe(keys.length);
  },
});
export { expect };
