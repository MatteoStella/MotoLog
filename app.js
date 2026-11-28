
/* =========================================================
   MOTOLOG — note di progetto
   -----------------------------------------------------------
   - File unico, no framework: state + render manuale.
   - IndexedDB per tutti i dati (offline-first).
   - Le funzioni AI chiamano l'API Gemini (Google) con una chiave
     personale salvata dall'utente in Impostazioni: richiedono
     connessione internet, il resto dell'app funziona offline.
   - Il service worker viene registrato via Blob URL: in alcuni
     contesti (es. iframe sandboxato) la registrazione puo'
     fallire silenziosamente — l'app resta comunque funzionale
     perche' i dati vivono in IndexedDB, non nella cache SW.
   - Changelog: v1 — build iniziale completa (dashboard, veicoli,
     log unificato, AI, backup, gauge component).
     v2 — fix contrasto testo (bottoni non ereditavano colore), tab
     "Diario" rinominata, sezione Impostazioni dedicata (backup,
     promemoria, notifiche, cancellazione dati), fix DB_VERSION.
     v3 — motore AI migrato da Anthropic (proxy artifact, inaffidabile
     fuori contesto claude.ai) a Google Gemini con chiave personale
     gratuita configurabile in Impostazioni.
   ========================================================= */

/* ---------------- CONFIG ---------------- */
const GEMINI_MODEL = "gemini-flash-latest"; // alias ufficiale, punta sempre all'ultima versione stabile
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash"; // usato solo se il modello principale è sovraccarico
function geminiURL(model){ return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`; }
const DEFAULT_SETTINGS = { kmReminderDays: 10, scadenzaReminderDays: 14, includiAllegatiBackup: true, geminiApiKey: '', themeMode: 'dark', themeAccent: 'blu', ultimoBackup: null };

const MODE_TOKENS = {
  dark:  { bg:'#0B1220', 'bg-rgb':'11,18,32', 'bg-2':'#0F1829', surface:'#111B2E', 'surface-2':'#17233A', border:'#22304D', text:'#E8EEF9', 'text-muted':'#8A97B2', ok:'#2ED47A', 'ok-dim':'rgba(46,212,122,.16)', warn:'#E8A33D', 'warn-dim':'rgba(232,163,61,.14)', danger:'#E4483C', 'danger-dim':'rgba(228,72,60,.14)', info:'#FF8A3D', 'info-dim':'rgba(255,138,61,.16)', 'ok-text':'#2ED47A', 'warn-text':'#E8A33D', 'danger-text':'#E86257', 'info-text':'#FF8A3D' },
  light: { bg:'#F4F3EE', 'bg-rgb':'244,243,238', 'bg-2':'#EDEBE3', surface:'#FFFFFF', 'surface-2':'#F0EEE6', border:'#E1DCCF', text:'#15171C', 'text-muted':'#6D6F78', ok:'#2E8B57', 'ok-dim':'rgba(46,139,87,.12)', warn:'#B68100', 'warn-dim':'rgba(217,154,0,.14)', danger:'#D81E3A', 'danger-dim':'rgba(216,30,58,.10)', info:'#D9660F', 'info-dim':'rgba(217,102,15,.12)', 'ok-text':'#287A4D', 'warn-text':'#8F6600', 'danger-text':'#D21D38', 'info-text':'#AE520C' },
};
const ACCENT_TOKENS = {
  blu:     { accent:'#2F80FF', 'accent-dim':'rgba(47,128,255,.16)',  'on-accent':'#FFFFFF', 'accent-shadow-rgb':'47,128,255',  label:'Blu elettrico' },
  viola:   { accent:'#7B5FFF', 'accent-dim':'rgba(123,95,255,.16)',  'on-accent':'#FFFFFF', 'accent-shadow-rgb':'123,95,255',  label:'Viola indaco' },
  ciano:   { accent:'#00B4CC', 'accent-dim':'rgba(0,180,204,.16)',   'on-accent':'#08181A', 'accent-shadow-rgb':'0,180,204',   label:'Ciano digitale' },
  magenta: { accent:'#E0368E', 'accent-dim':'rgba(224,54,142,.16)',  'on-accent':'#FFFFFF', 'accent-shadow-rgb':'224,54,142',  label:'Magenta acceso' },
};
// Nel tema chiaro il ciano standard ha contrasto troppo basso (≈2:1): variante più scura
const LIGHT_ACCENT_OVERRIDES = {
  ciano: { accent:'#00788C', 'accent-dim':'rgba(0,120,140,.14)', 'on-accent':'#FFFFFF', 'accent-shadow-rgb':'0,120,140' },
};
function applyTheme(){
  const mode = MODE_TOKENS[state.settings.themeMode] || MODE_TOKENS.dark;
  const accentKey = ACCENT_TOKENS[state.settings.themeAccent] ? state.settings.themeAccent : 'blu';
  const accent = { ...ACCENT_TOKENS[accentKey], ...(state.settings.themeMode==='light' ? (LIGHT_ACCENT_OVERRIDES[accentKey]||{}) : {}) };
  const root = document.documentElement.style;
  Object.entries(mode).forEach(([k,v]) => root.setProperty('--'+k, v));
  Object.entries(accent).forEach(([k,v]) => { if(k!=='label') root.setProperty('--'+k, v); });
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) metaTheme.setAttribute('content', mode.bg);
}

/* ---------------- UTILS ---------------- */
const uid = () => crypto.randomUUID();
const todayISO = () => new Date().toISOString().slice(0,10);
const addMonths = (dateStr, months) => { const d = new Date(dateStr); d.setMonth(d.getMonth()+months); return d.toISOString().slice(0,10); };
const addDays = (dateStr, days) => { const d = new Date(dateStr); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };

function calStatoHTML(s){
  const c = s.calendarAggiunto;
  if(!c) return '';
  const aggiornato = c.data===s.data && c.ricorrenza===(s.ricorrenza||'nessuna');
  return aggiornato
    ? `<div class="badge badge-ok" style="display:block;text-align:center;margin-top:14px;padding:8px;">✓ Già aggiunto a Google Calendar</div>`
    : `<div class="badge badge-warn" style="display:block;text-align:center;margin-top:14px;padding:8px;">Aggiunto a Calendar, ma data o ricorrenza sono cambiate: aggiungilo di nuovo</div>`;
}
function googleCalendarLink({ title, dateISO, details='', recurRule=null }){
  const start = dateISO.replace(/-/g,'');
  const endDate = new Date(dateISO); endDate.setDate(endDate.getDate()+1);
  const end = endDate.toISOString().slice(0,10).replace(/-/g,'');
  const params = new URLSearchParams({ action:'TEMPLATE', text:title, dates:`${start}/${end}`, details });
  if(recurRule) params.set('recur', recurRule);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
const fmtDate = (iso) => { if(!iso) return "—"; const d=new Date(iso); return d.toLocaleDateString('it-IT',{day:'2-digit',month:'short',year:'numeric'}); };
const fmtKm = (n) => n==null ? "—" : Math.round(n).toLocaleString('it-IT') + " km";
const fmtEuro = (n) => n==null ? "—" : n.toLocaleString('it-IT',{style:'currency',currency:'EUR'});
const daysBetween = (a,b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
function base64ToBlob(base64, mime){
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type:mime});
}
function escapeHTML(s){
  if(s==null) return "";
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- ICONS (inline SVG, stroke style) ---------------- */
const ICONS = {
  dashboard: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 3v4M4.2 7.2l2.8 2.8M19.8 7.2 17 10M3 15a9 9 0 0 1 18 0"/><path d="M12 15l4-6"/></svg>`,
  bike: `<svg class="icon" viewBox="0 0 24 24"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M5.5 17.5 9 10h5l3.5 7.5M9 10 7 6h3M12.5 10l2 4"/></svg>`,
  list: `<svg class="icon" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  chart: `<svg class="icon" viewBox="0 0 24 24"><path d="M4 20h16M7 20v-7M12 20V5M17 20v-10"/></svg>`,
  spark: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/></svg>`,
  plus: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  back: `<svg class="icon" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>`,
  close: `<svg class="icon" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  edit: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  star: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 2.5l3 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3l-6.3 3.5 1.6-6.8L2.1 9.4l6.9-.6z"/></svg>`,
  camera: `<svg class="icon" viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/></svg>`,
  upload: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>`,
  trash: `<svg class="icon" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>`,
  wrench: `<svg class="icon" viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.6 5.1L4 16.5V20h3.5l5.1-5.1a4 4 0 0 0 5.1-5.6l-2.8 2.8-2-2 2.8-2.8z"/></svg>`,
  gas: `<svg class="icon" viewBox="0 0 24 24"><path d="M5 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M5 21h10M5 11h10M15 8l3 3v6a1.5 1.5 0 0 0 3 0v-5l-2-3"/></svg>`,
  alert: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>`,
  calendar: `<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  car: `<svg class="icon" viewBox="0 0 24 24"><path d="M4 16V11l2-5h12l2 5v5"/><circle cx="7.5" cy="16.5" r="1.5"/><circle cx="16.5" cy="16.5" r="1.5"/><path d="M4 13h16"/></svg>`,
  chevron: `<svg class="icon" viewBox="0 0 24 24" style="width:18px;height:18px;"><path d="M9 6l6 6-6 6"/></svg>`,
  file: `<svg class="icon" viewBox="0 0 24 24"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/></svg>`,
  send: `<svg class="icon" viewBox="0 0 24 24"><path d="M4 12 20 4l-8 16-2-7-6-1z"/></svg>`,
  check: `<svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px;stroke-width:2.4;"><path d="M5 12l5 5L19 7"/></svg>`,
  oliva: `<svg class="icon" viewBox="0 0 24 24"><path d="M12 3c3 4.2 6 7.7 6 11a6 6 0 0 1-12 0c0-3.3 3-6.8 6-11z"/></svg>`,
  gomma: `<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 4.7V9M12 15v4.3M5.9 8.3l3.4 2M14.7 13.7l3.4 2M5.9 15.7l3.4-2M14.7 10.3l3.4-2"/></svg>`,
  catena: `<svg class="icon" viewBox="0 0 24 24"><rect x="2.3" y="9.3" width="7" height="5.4" rx="2.7"/><rect x="7.9" y="9.3" width="7" height="5.4" rx="2.7"/><rect x="13.5" y="9.3" width="7" height="5.4" rx="2.7"/><circle cx="7.9" cy="12" r="0.95" fill="currentColor" stroke="none"/><circle cx="13.5" cy="12" r="0.95" fill="currentColor" stroke="none"/></svg>`,
  tagliandoIcon: `<svg class="icon" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 12.5l2 2 4.5-5"/></svg>`,
  settings: `<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.06 2.06 0 1 1-2.92 2.92l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2.06 2.06 0 1 1-4.13 0v-.1a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2.06 2.06 0 1 1-2.92-2.92l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2.06 2.06 0 1 1 0-4.13h.1A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2.06 2.06 0 1 1 2.92-2.92l.06.06a1.7 1.7 0 0 0 1.87.34H9.2A1.7 1.7 0 0 0 10.75 3v-.1a2.06 2.06 0 1 1 4.13 0V3a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.06 2.06 0 1 1 2.92 2.92l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2.06 2.06 0 1 1 0 4.13h-.1a1.7 1.7 0 0 0-1.5 1.87z"/></svg>`,
};

/* ---------------- DB LAYER ---------------- */
const DB_NAME = "motolog-db", DB_VERSION = 2;
let dbInstance = null;

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const mk = (name) => { const s = db.createObjectStore(name,{keyPath:'id'}); s.createIndex('veicoloId','veicoloId'); return s; };
      if(!db.objectStoreNames.contains('veicoli')) db.createObjectStore('veicoli',{keyPath:'id'});
      if(!db.objectStoreNames.contains('manutenzioni')) mk('manutenzioni');
      if(!db.objectStoreNames.contains('scadenze')) mk('scadenze');
      if(!db.objectStoreNames.contains('problemi')) mk('problemi');
      if(!db.objectStoreNames.contains('rifornimenti')) mk('rifornimenti');
      if(!db.objectStoreNames.contains('manuali')) mk('manuali');
      if(!db.objectStoreNames.contains('allegati')) db.createObjectStore('allegati',{keyPath:'id'});
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getDB(){ if(!dbInstance) dbInstance = await openDB(); return dbInstance; }
async function storeFor(name, mode='readonly'){ const db = await getDB(); return db.transaction(name, mode).objectStore(name); }

async function dbGetAll(name){ const s = await storeFor(name); return new Promise((res,rej)=>{ const r=s.getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbGet(name,id){ const s = await storeFor(name); return new Promise((res,rej)=>{ const r=s.get(id); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbPut(name,obj){ const s = await storeFor(name,'readwrite'); return new Promise((res,rej)=>{ const r=s.put(obj); r.onsuccess=()=>res(obj); r.onerror=()=>rej(r.error); }); }
async function dbDelete(name,id){ const s = await storeFor(name,'readwrite'); return new Promise((res,rej)=>{ const r=s.delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function dbByVeicolo(name,veicoloId){ const s = await storeFor(name); return new Promise((res,rej)=>{ const idx=s.index('veicoloId'); const r=idx.getAll(veicoloId); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }

/* ---------------- STATE ---------------- */
const state = {
  tab: 'dashboard',
  veicoli: [],
  selectedVeicoloId: null,
  logFilter: 'tutti',
  aiSubtab: 'chat',
  chatHistory: [],
  modal: null,
  stats: null,
  toast: null,
  bannerDismissed: {},
  cache: { manutenzioni:[], scadenze:[], problemi:[], rifornimenti:[], manuale:null },
  busy: false,
  settings: { ...DEFAULT_SETTINGS },
  editAttachments: [],
  lightbox: null,
  manualeError: null,
  calendarMonth: null,
  calendarSelectedDate: null,
  backupExcluded: new Set(),
  busyStatus: null,
  chatError: null,
  toastAction: null,
  storagePersisted: null,
};

async function loadSettings(){
  const rows = await dbGetAll('settings');
  const map = {}; rows.forEach(r=>{ map[r.key]=r.value; });
  state.settings = { ...DEFAULT_SETTINGS, ...map };
}
async function saveSetting(key, value){
  state.settings[key] = value;
  await dbPut('settings', { key, value });
}

let toastSeq = 0;
function setToast(t, ms){
  const id = ++toastSeq;
  if(!t.actionLabel) state.toastAction = null;
  state.toast = { ...t, id };
  render();
  setTimeout(()=>{ if(state.toast && state.toast.id===id){ state.toast=null; state.toastAction=null; render(); } }, ms);
}
function showToast(text){ setToast({text, success:false}, 3200); }
function showSuccessToast(text){ setToast({text, success:true}, 2400); }
// Toast con un pulsante (es. "Annulla", "Riprova"); resta visibile più a lungo
function showActionToast(text, label, fn, ms=6500){ state.toastAction = fn; setToast({text, success:false, actionLabel:label}, ms); }

async function loadVeicoli(){
  state.veicoli = await dbGetAll('veicoli');
  state.veicoli.sort((a,b)=>a.marca.localeCompare(b.marca));
  if(!state.selectedVeicoloId && state.veicoli.length){
    const preferito = state.veicoli.find(v=>v.preferito);
    state.selectedVeicoloId = (preferito || state.veicoli[0]).id;
  }
  if(state.selectedVeicoloId && !state.veicoli.find(v=>v.id===state.selectedVeicoloId)){
    state.selectedVeicoloId = state.veicoli[0]?.id || null;
  }
}
async function loadVeicoloData(veicoloId){
  if(!veicoloId){ state.cache = { manutenzioni:[], scadenze:[], problemi:[], rifornimenti:[], manuale:null }; return; }
  const [manutenzioni, scadenze, problemi, rifornimenti, manuali] = await Promise.all([
    dbByVeicolo('manutenzioni', veicoloId),
    dbByVeicolo('scadenze', veicoloId),
    dbByVeicolo('problemi', veicoloId),
    dbByVeicolo('rifornimenti', veicoloId),
    dbByVeicolo('manuali', veicoloId),
  ]);
  manutenzioni.sort((a,b)=> new Date(b.data)-new Date(a.data));
  scadenze.sort((a,b)=> new Date(a.data)-new Date(b.data));
  problemi.sort((a,b)=> new Date(b.data)-new Date(a.data));
  rifornimenti.sort((a,b)=> new Date(b.data)-new Date(a.data));
  state.cache = { manutenzioni, scadenze, problemi, rifornimenti, manuale: manuali[0] || null };
}
function currentVeicolo(){ return state.veicoli.find(v=>v.id===state.selectedVeicoloId) || null; }

async function loadEditAttachments(manutenzione){
  state.editAttachments.forEach(a=>{ try{ URL.revokeObjectURL(a.url); }catch(e){} });
  state.editAttachments = [];
  if(manutenzione && manutenzione.allegati && manutenzione.allegati.length){
    for(const aid of manutenzione.allegati){
      const a = await dbGet('allegati', aid);
      if(a && a.blob){
        state.editAttachments.push({ id:a.id, nome:a.nome, tipo:a.tipo, url:URL.createObjectURL(a.blob), existing:true });
      }
    }
  }
}

/* ---------------- LOGICA SCADENZE / PROIEZIONE KM ---------------- */
function nextScadenzaKm(veicolo){
  const items = state.cache.manutenzioni.filter(m => m.veicoloId===veicolo.id && m.prossimaScadenzaKm && m.prossimaScadenzaKm > veicolo.kmAttuali);
  if(!items.length) return null;
  items.sort((a,b)=> a.prossimaScadenzaKm - b.prossimaScadenzaKm);
  return items[0];
}
function kmReminderNeeded(veicolo){
  const d = daysBetween(veicolo.dataUltimoAggiornamentoKm, todayISO());
  return d >= state.settings.kmReminderDays && !state.bannerDismissed[veicolo.id + todayISO()];
}

/* ---------------- COMPONENTI ---------------- */
function gaugeSVG({ value, max, label, sublabel, size=150, colorOverride=null }){
  const pct = max > 0 ? Math.max(0, Math.min(1, value/max)) : 0;
  const r = (size/2) - 12;
  const c = 2 * Math.PI * r;
  const startOffset = c * 0.25; // gauge parte in basso a sx, 270°
  const arc = c * 0.75;
  const filled = arc * pct;
  let color = colorOverride;
  if(!color){ color = pct > 0.5 ? 'var(--ok)' : pct > 0.2 ? 'var(--warn)' : 'var(--danger)'; }
  return `
  <div style="position:relative;width:${size}px;height:${size}px;">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(135deg);">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="10" stroke-dasharray="${arc} ${c}" stroke-linecap="round"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${filled} ${c}" stroke-linecap="round" style="transition:stroke-dasharray .7s cubic-bezier(.4,0,.2,1);"/>
    </svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
      <div class="mono" style="font-size:${size*0.15}px;font-weight:700;">${label}</div>
      <div class="muted" style="font-size:11px;text-align:center;max-width:${size*0.7}px;margin-top:2px;">${sublabel}</div>
    </div>
  </div>`;
}

function bannerHTML(veicolo){
  if(!kmReminderNeeded(veicolo)) return '';
  return `
  <div class="banner">
    <div class="banner-icon">${ICONS.alert}</div>
    <div class="banner-text">Non aggiorni i km di <b>${escapeHTML(veicolo.marca)} ${escapeHTML(veicolo.modello)}</b> da un po'. Aggiornali per tenere le scadenze precise.
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" data-action="openKmUpdate" data-id="${veicolo.id}">Aggiorna ora</button>
      </div>
    </div>
    <button class="banner-close" data-action="dismissBanner" data-id="${veicolo.id}" aria-label="Chiudi avviso">${ICONS.close}</button>
  </div>`;
}

function scadenzeInScadenza(veicolo){
  return state.cache.scadenze.filter(s => s.stato==='attiva' && daysBetween(todayISO(), s.data) <= state.settings.scadenzaReminderDays);
}
function scadenzaBannerHTML(veicolo){
  const key = 'scad_' + veicolo.id + '_' + todayISO();
  if(state.bannerDismissed[key]) return '';
  const due = scadenzeInScadenza(veicolo);
  if(!due.length) return '';
  due.sort((a,b)=> new Date(a.data)-new Date(b.data));
  const first = due[0];
  const gg = daysBetween(todayISO(), first.data);
  const quando = gg < 0 ? `scaduta da ${Math.abs(gg)} giorni` : gg===0 ? 'scade oggi' : `tra ${gg} giorni`;
  const testo = due.length===1
    ? `<b>${tipoScadenzaLabel(first.tipo)}</b> ${quando}.`
    : `${due.length} scadenze da controllare, la più urgente: <b>${tipoScadenzaLabel(first.tipo)}</b> ${quando}.`;
  return `
  <div class="banner" style="background:var(--danger-dim);border-color:rgba(228,72,60,.35);">
    <div class="banner-icon" style="color:var(--danger);">${ICONS.calendar}</div>
    <div class="banner-text">${testo}
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" data-action="setTab" data-id="log">Vedi nel Diario</button>
      </div>
    </div>
    <button class="banner-close" data-action="dismissScadenzaBanner" data-id="${veicolo.id}" aria-label="Chiudi avviso">${ICONS.close}</button>
  </div>`;
}

const BACKUP_REMIND_DAYS = 30;
function backupDaysAgo(){
  const t = state.settings.ultimoBackup;
  if(!t) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 86400000));
}
function backupBannerHTML(){
  if(!state.veicoli.length || state.bannerDismissed['bkp_'+todayISO()]) return '';
  const d = backupDaysAgo();
  if(d !== null && d < BACKUP_REMIND_DAYS) return '';
  const nDati = state.cache.manutenzioni.length + state.cache.rifornimenti.length + state.cache.scadenze.length + state.cache.problemi.length;
  if(d === null && nDati < 3) return '';
  const testo = d === null ? 'Non hai ancora fatto nessun backup: i dati sono solo su questo dispositivo.' : `Ultimo backup ${d} giorni fa: i dati sono solo su questo dispositivo.`;
  return `
  <div class="banner">
    <div class="banner-icon">${ICONS.upload}</div>
    <div class="banner-text">${testo}
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" data-action="exportBackup">Esporta ora</button>
      </div>
    </div>
    <button class="banner-close" data-action="dismissBackupBanner" aria-label="Chiudi avviso">${ICONS.close}</button>
  </div>`;
}

function tabBarHTML(){
  const tabs = [
    {id:'dashboard', icon:ICONS.dashboard, label:'Dashboard'},
    {id:'log', icon:ICONS.list, label:'Diario'},
    {id:'veicoli', icon:ICONS.bike, label:'Veicoli'},
    {id:'ai', icon:ICONS.spark, label:'AI'},
    {id:'impostazioni', icon:ICONS.settings, label:'Impostazioni'},
  ];
  return `<div class="tabbar">${tabs.map(t=>`
    <button class="tab-item ${state.tab===t.id?'active':''}" data-action="setTab" data-id="${t.id}">
      ${t.icon}<span>${t.label}</span>
    </button>`).join('')}</div>`;
}

function fabHTML(){
  if(state.tab==='ai' || state.tab==='impostazioni') return '';
  const action = state.tab==='veicoli' ? 'openVeicoloForm' : 'openTypeChooser';
  return `<button class="fab" data-action="${action}" aria-label="${state.tab==='veicoli' ? 'Nuovo veicolo' : 'Nuovo elemento'}">${ICONS.plus}</button>`;
}

/* ---------------- VISTE ---------------- */
function viewDashboard(){
  if(!state.veicoli.length){
    return `<div class="content">${emptyState('bike','Nessun veicolo ancora','Aggiungi la tua prima moto o auto per iniziare a tracciare manutenzioni e scadenze.','Aggiungi veicolo','openVeicoloForm')}</div>`;
  }
  const v = currentVeicolo();
  if(!v) return '';
  const nextManut = nextScadenzaKm(v);
  const kmRimanenti = nextManut ? Math.max(0, nextManut.prossimaScadenzaKm - v.kmAttuali) : null;
  const maxRange = nextManut ? Math.max(1, nextManut.prossimaScadenzaKm - (nextManut.km||0)) : 1;

  const consumoKmL = consumoGlobale(state.cache.rifornimenti);

  const spese12 = speseUltimi12Mesi();
  const spesa12Mesi = spese12.reduce((t,x)=> t+x.costo, 0);

  const prossimaScadenzaData = state.cache.scadenze.find(s=>s.stato==='attiva');

  const eventi = [
    ...state.cache.manutenzioni.map(m=>({_type:'manutenzioni', id:m.id, data:m.data, label: categoriaLabel(m.categoria, m.categoriaCustom), sub: fmtKm(m.km)})),
    ...state.cache.problemi.map(p=>({_type:'problemi', id:p.id, data:p.data, label: p.sintomi, sub: p.stato})),
  ].sort((a,b)=> new Date(b.data)-new Date(a.data)).slice(0,4);

  return `
  <div class="content">
    ${bannerHTML(v)}
    ${scadenzaBannerHTML(v)}
    ${backupBannerHTML()}
    <div class="card">
      <div class="veh-head">
        <div class="veh-logo">${v.tipo==='moto'?ICONS.bike:ICONS.car}</div>
        <div style="min-width:0;">
          <div class="veh-name">${escapeHTML(v.marca)} ${escapeHTML(v.modello)}</div>
          ${v.targa ? `<div class="plate mono">${escapeHTML(v.targa)}</div>` : ''}
        </div>
      </div>
      ${veicoloStatTilesHTML(v)}
    </div>
    ${(() => {
      const pct = nextManut ? Math.max(0, Math.min(1, kmRimanenti/maxRange)) : 0;
      const col = !nextManut ? 'var(--text-muted)' : pct>0.5 ? 'var(--ok)' : pct>0.2 ? 'var(--warn)' : 'var(--danger)';
      const bg = !nextManut ? 'var(--surface-2)' : pct>0.5 ? 'var(--ok-dim)' : pct>0.2 ? 'var(--warn-dim)' : 'var(--danger-dim)';
      const label = nextManut ? fmtKm(kmRimanenti).replace(' km','') : '—';
      const sub = nextManut ? `km a ${categoriaLabel(nextManut.categoria, nextManut.categoriaCustom)}` : 'Nessuna scadenza km impostata';
      const d = daysBetween(v.dataUltimoAggiornamentoKm, todayISO());
      const kmTxt = d<=0 ? 'Km aggiornati oggi' : d===1 ? 'Km aggiornati ieri' : `Km aggiornati ${d} giorni fa`;
      return `<div class="card">
        <div class="sec-head"><div class="sec-ico" style="background:${bg};color:${col};">${ICONS.wrench}</div><h3>Prossima scadenza</h3></div>
        <div class="big-num mono">${label}</div>
        <div class="muted" style="font-size:13px;margin-top:4px;">${sub}</div>
        <div class="bar"><div class="bar-fill" style="width:${Math.round((1-pct)*100)}%;background:${col};"></div></div>
        ${nextManut ? `<div class="mono muted bar-scale"><span>${fmtKm(nextManut.km||0)}</span><span>${fmtKm(nextManut.prossimaScadenzaKm)}</span></div>` : ''}
        <button class="btn-soft" data-action="openKmUpdate" data-id="${v.id}">${ICONS.edit}<span class="mono">${kmTxt}</span></button>
        <button class="btn-soft" style="margin-top:8px;background:var(--ok-dim);color:var(--ok-text);" data-action="openForm" data-type="rifornimenti">${ICONS.gas}<span>Nuovo rifornimento</span></button>
      </div>`;
    })()}
    <div class="card row-card" data-action="openStatistiche" data-tab="spesa">
      <div class="sec-ico" style="background:var(--ok-dim);color:var(--ok);font-weight:700;font-size:18px;">€</div>
      <div class="grow">
        <div class="muted" style="font-size:12px;">Spesa ultimi 12 mesi</div>
        <div class="mono" style="font-size:22px;font-weight:700;margin-top:2px;">${fmtEuro(spesa12Mesi)}</div>
      </div>
      <div class="chev">${ICONS.chevron}</div>
    </div>

    <div class="sec-head" style="margin-top:24px;"><div class="sec-ico">${ICONS.list}</div><h3>Eventi recenti</h3></div>
    ${eventi.length ? `<div class="card">${eventi.map((e,i)=>{
      const colorOf = t => t==='problemi' ? 'var(--danger)' : 'var(--accent)';
      const topColor = colorOf(e._type);
      const nextColor = i < eventi.length-1 ? colorOf(eventi[i+1]._type) : topColor;
      const borderCss = topColor===nextColor
        ? `border-left:3px solid ${topColor};`
        : `border-left:3px solid;border-image:linear-gradient(to bottom, ${topColor} 0%, ${topColor} 65%, ${nextColor} 100%) 1;`;
      return `
      <button class="log-item" style="width:calc(100% + 16px);background:none;border:none;text-align:left;cursor:pointer;${borderCss}padding-left:11px;margin-left:-16px;padding-right:0;" data-action="openEdit" data-type="${e._type}" data-id="${e.id}">
        <div class="log-dot" style="background:${e._type==='problemi'?'var(--danger-dim)':'var(--accent-dim)'};color:${topColor};">${e._type==='problemi'?ICONS.alert:ICONS.wrench}</div>
        <div class="log-body">
          <div class="log-title">${escapeHTML(e.label)}</div>
          <div class="log-sub">${e.sub}</div>
        </div>
        <div class="log-meta">${fmtDate(e.data)}</div>
      </button>`;
    }).join('')}</div>` : `<div class="card muted" style="text-align:center;padding:24px;">Nessun evento registrato</div>`}
  </div>`;
}

function emptyState(icon, title, text, actionLabel, action){
  return `<div class="empty">
    ${ICONS[icon]}
    <h3 style="margin-bottom:6px;">${title}</h3>
    <p style="font-size:14px;margin:0 0 18px;">${text}</p>
    ${actionLabel ? `<button class="btn btn-primary" data-action="${action}">${actionLabel}</button>` : ''}
  </div>`;
}

function viewVeicoli(){
  if(!state.veicoli.length){
    return `<div class="content">${emptyState('bike','Nessun veicolo','Aggiungi la tua prima moto o auto.','Aggiungi veicolo','openVeicoloForm')}</div>`;
  }
  return `<div class="content">
    ${state.veicoli.map(v=>`
      <button class="card card-tap veh-row" data-action="openVeicoloDetail" data-id="${v.id}" style="margin-bottom:10px;">
        <div class="veh-logo">${v.tipo==='moto'?ICONS.bike:ICONS.car}</div>
        <div class="grow">
          <div class="veh-name" style="font-size:17px;display:flex;align-items:center;gap:6px;">
            <span>${escapeHTML(v.marca)} ${escapeHTML(v.modello)}</span>
            ${v.preferito ? `<span style="color:var(--warn);display:inline-flex;">${(() => { const s = ICONS.star; return s.replace('class="icon"','class="icon" fill="currentColor" style="width:14px;height:14px;"'); })()}</span>` : ''}
          </div>
          <div class="muted mono" style="font-size:13px;margin-top:4px;">${fmtKm(v.kmAttuali)} · ${v.anno}</div>
        </div>
        <div class="chev">${ICONS.chevron}</div>
      </button>`).join('')}
  </div>`;
}

function speseUltimi12Mesi(){
  const limite = new Date(); limite.setDate(limite.getDate()-365);
  const voci = [
    ...state.cache.manutenzioni.map(x=>({...x, _type:'manutenzioni', _label: categoriaLabel(x.categoria, x.categoriaCustom)})),
    ...state.cache.rifornimenti.map(x=>({...x, _type:'rifornimenti', _label: 'Rifornimento'})),
    ...state.cache.scadenze.map(x=>({...x, _type:'scadenze', _label: tipoScadenzaLabel(x.tipo)})),
  ];
  return voci
    .filter(x => new Date(x.data) >= limite && x.data <= todayISO() && (x.costo||0) > 0)
    .map(x => ({...x, costo: x.costo||0}))
    .sort((a,b)=> new Date(b.data)-new Date(a.data));
}
/* ---------------- STATISTICHE (grafici SVG a mano, colori da token tema) ---------------- */
const MESI_BREVI = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
const STATS_TABS = [{id:'spesa', label:'Spesa'},{id:'consumo', label:'Consumo'},{id:'prezzo', label:'Prezzo'}];
const STATS_PERIODI = [{v:6,label:'6 mesi'},{v:12,label:'12 mesi'},{v:0,label:'Tutto'}];

/* --- funzioni pure --- */
// Stessa formula della dashboard: (km ultimo − km primo) / litri esclusi i primi
function consumoGlobale(rifornimenti){
  const r = [...rifornimenti].sort((a,b)=> a.km-b.km);
  if(r.length < 2) return null;
  const kmTotali = r[r.length-1].km - r[0].km;
  const litri = r.slice(1).reduce((s,x)=> s+(x.litri||0), 0);
  return (kmTotali > 0 && litri > 0) ? kmTotali / litri : null;
}
const meseKey = (iso) => iso.slice(0,7);
function mesiRange(primo, ultimo){
  const out = [];
  let [y,m] = primo.split('-').map(Number);
  const [y2,m2] = ultimo.split('-').map(Number);
  while(y < y2 || (y === y2 && m <= m2)){
    out.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if(m > 12){ m = 1; y++; }
  }
  return out;
}
function mesiIndietro(ultimo, n){
  let [y,m] = ultimo.split('-').map(Number);
  m -= (n-1);
  while(m < 1){ m += 12; y--; }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function meseLungo(key){
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('it-IT',{month:'long',year:'numeric'});
}
// Voci con costo (manutenzioni + rifornimenti + scadenze), data non futura
function vociConCosto(cache){
  return [
    ...cache.manutenzioni.map(x=>({...x, _type:'manutenzioni', _label: categoriaLabel(x.categoria, x.categoriaCustom)})),
    ...cache.rifornimenti.map(x=>({...x, _type:'rifornimenti', _label:'Rifornimento'})),
    ...cache.scadenze.map(x=>({...x, _type:'scadenze', _label: tipoScadenzaLabel(x.tipo)})),
  ].filter(x => x.data && x.data <= todayISO() && (x.costo||0) > 0);
}
// periodo: 6 | 12 mesi di calendario (mese corrente incluso), 0 = tutto
function serieSpesaMensile(cache, periodo){
  const voci = vociConCosto(cache);
  const ultimo = meseKey(todayISO());
  let primo;
  if(periodo > 0) primo = mesiIndietro(ultimo, periodo);
  else{
    if(!voci.length) return { mesi:[], voci:[] };
    primo = voci.reduce((mn,x)=> meseKey(x.data) < mn ? meseKey(x.data) : mn, ultimo);
  }
  const mesi = mesiRange(primo, ultimo).map(k => ({ key:k, carb:0, manut:0 }));
  const idx = new Map(mesi.map((m,i)=>[m.key, i]));
  const inPeriodo = [];
  voci.forEach(x => {
    const i = idx.get(meseKey(x.data));
    if(i === undefined) return;
    if(x._type === 'rifornimenti') mesi[i].carb += (x.costo||0); else mesi[i].manut += (x.costo||0);
    inPeriodo.push(x);
  });
  inPeriodo.sort((a,b)=> new Date(b.data) - new Date(a.data));
  return { mesi, voci: inPeriodo };
}
// Scala Y "pulita": al massimo 5 intervalli
function scalaY(max){
  if(!(max > 0)) return { step:1, top:1 };
  const base = Math.pow(10, Math.floor(Math.log10(max)) - 1);
  for(const mult of [1,2,5,10,20,50,100]){
    const step = base * mult;
    if(Math.ceil(max/step) <= 5) return { step, top: Math.ceil(max/step) * step };
  }
  return { step:max, top:max };
}
const fmtAsse = (v) => v >= 1000 ? (v/1000).toLocaleString('it-IT',{maximumFractionDigits:1}) + 'k' : v.toLocaleString('it-IT',{maximumFractionDigits:2});

/* --- SVG --- */
function svgBarreImpilate(mesi, pick, ariaLabel){
  const W=340, H=210, L=36, R=8, T=10, B=34;
  const pw = W-L-R, ph = H-T-B, n = mesi.length;
  const max = Math.max(0, ...mesi.map(m => m.carb + m.manut));
  const { step, top } = scalaY(max);
  const yOf = (v) => T + ph - (v/top)*ph;
  const slot = pw/n, bw = Math.min(slot*0.62, 28);
  const every = Math.ceil(n/12);
  let grid = '';
  const nTick = Math.round(top/step);
  for(let k=0; k<=nTick; k++){
    const v = k*step, yy = yOf(v).toFixed(1);
    grid += `<line class="ch-grid" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text class="ch-txt" x="${L-6}" y="${(+yy+3).toFixed(1)}" text-anchor="end">${fmtAsse(v)}</text>`;
  }
  let cols = '', lastYear = null;
  mesi.forEach((m,i) => {
    const x0 = L + slot*i, bx = x0 + (slot-bw)/2;
    const hC = (m.carb/top)*ph, hM = (m.manut/top)*ph;
    const dim = (pick != null && pick !== i) ? ' style="opacity:.4"' : '';
    cols += `<g data-action="statPick" data-id="${i}">`;
    if(pick === i) cols += `<rect class="ch-sel" x="${x0.toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ph}" rx="4"/>`;
    cols += `<g${dim}>`;
    if(hC > 0) cols += `<rect class="ch-carb" x="${bx.toFixed(1)}" y="${(T+ph-hC).toFixed(1)}" width="${bw.toFixed(1)}" height="${hC.toFixed(1)}"/>`;
    if(hM > 0) cols += `<rect class="ch-manut" x="${bx.toFixed(1)}" y="${(T+ph-hC-hM).toFixed(1)}" width="${bw.toFixed(1)}" height="${hM.toFixed(1)}"/>`;
    cols += `</g>`;
    if((n-1-i) % every === 0){
      const [yy, mm] = m.key.split('-');
      cols += `<text class="ch-txt" x="${(x0+slot/2).toFixed(1)}" y="${H-B+14}" text-anchor="middle">${MESI_BREVI[+mm-1]}</text>`;
      if(yy !== lastYear){ cols += `<text class="ch-txt" x="${(x0+slot/2).toFixed(1)}" y="${H-B+26}" text-anchor="middle" style="font-size:9px">${yy}</text>`; lastYear = yy; }
    }
    cols += `<rect class="ch-hit" x="${x0.toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ph+B}"/></g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHTML(ariaLabel)}" style="display:block;font-family:var(--font-mono);">${grid}${cols}</svg>`;
}

/* --- Consumo e Prezzo (push B) --- */
const periodoDaData = (periodo) => periodo > 0 ? mesiIndietro(meseKey(todayISO()), periodo) + '-01' : '';
const statsPeriodoLabel = (p) => p > 0 ? `ultimi ${p} mesi` : 'da sempre';
const MIN_RIFORNIMENTI_STATS = 3;
const fmtKmL = (n) => n.toLocaleString('it-IT',{minimumFractionDigits:1,maximumFractionDigits:1});
const fmtPrezzoL = (n) => n.toLocaleString('it-IT',{minimumFractionDigits:3,maximumFractionDigits:3}) + ' €/L';
const fmtDataBreve = (iso) => { const [y,m] = iso.split('-'); return `${MESI_BREVI[+m-1]} ${y.slice(2)}`; };

// Consumo per tratta (Δkm / litri del rifornimento) e media mobile su 3 tratte pesata Σkm/Σlitri
function serieConsumo(rifornimenti, periodo){
  const r = rifornimenti.filter(x => x.data && x.data <= todayISO()).sort((a,b)=> a.km-b.km || a.data.localeCompare(b.data));
  const tratte = [];
  for(let i=1; i<r.length; i++){
    const km = r[i].km - r[i-1].km, litri = r[i].litri || 0;
    if(!(km > 0 && litri > 0)) continue;
    const w = tratte.concat({ km, litri }).slice(-3);
    const sk = w.reduce((s,t)=> s+t.km, 0), sl = w.reduce((s,t)=> s+t.litri, 0);
    tratte.push({ id:r[i].id, data:r[i].data, km, litri, valore: km/litri, media: sk/sl });
  }
  const da = periodoDaData(periodo);
  return { n: r.length, punti: tratte.filter(t => t.data >= da).sort((a,b)=> a.data.localeCompare(b.data)) };
}
function seriePrezzo(rifornimenti, periodo){
  const tutti = rifornimenti.filter(x => x.data && x.data <= todayISO());
  const da = periodoDaData(periodo);
  const punti = tutti.filter(x => x.litri > 0 && x.costo > 0 && x.data >= da)
    .map(x => ({ id:x.id, data:x.data, km:x.km, litri:x.litri, costo:x.costo, valore: x.costo/x.litri }))
    .sort((a,b)=> a.data.localeCompare(b.data));
  const sc = punti.reduce((s,p)=> s+p.costo, 0), sl = punti.reduce((s,p)=> s+p.litri, 0);
  return { n: tutti.length, punti, media: sl > 0 ? sc/sl : null };
}
// Scala Y per linee (non parte da zero)
function scalaLinee(lo, hi){
  let span = hi - lo;
  if(!(span > 0)) span = Math.max(Math.abs(hi) * 0.1, 0.1);
  const rough = span / 4, exp = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1,2,5,10].map(m => m*exp).find(s => s >= rough);
  const min = Math.floor((lo - span*0.05) / step) * step;
  const top = Math.ceil((hi + span*0.05) / step) * step;
  return { step, min, top };
}
// punti: {data, y, y2?}  opts: {media, pick, aria, cls ('ok'|'info'), fmtY}
function svgLinee(punti, o){
  const W=340, H=210, L=40, R=12, T=12, B=34;
  const pw = W-L-R, ph = H-T-B, n = punti.length;
  const ys = punti.flatMap(p => p.y2 != null ? [p.y, p.y2] : [p.y]).concat(o.media != null ? [o.media] : []);
  const { step, min, top } = scalaLinee(Math.min(...ys), Math.max(...ys));
  const yOf = (v) => T + ph - ((v-min)/(top-min))*ph;
  const ts = punti.map(p => Date.parse(p.data));
  const t0 = Math.min(...ts), t1 = Math.max(...ts), span = t1 - t0;
  const xi = L + 8, xw = pw - 16;
  const xOf = (t) => span > 0 ? xi + xw*(t-t0)/span : L + pw/2;
  const xs = ts.map(xOf);
  const nTick = Math.round((top-min)/step);
  let grid = '';
  for(let k=0; k<=nTick; k++){
    const v = min + k*step, yy = yOf(v).toFixed(1);
    grid += `<line class="ch-grid" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text class="ch-txt" x="${L-6}" y="${(+yy+3).toFixed(1)}" text-anchor="end">${o.fmtY(v)}</text>`;
  }
  let xlab = '';
  const nLab = span > 0 ? 4 : 1;
  for(let k=0; k<nLab; k++){
    const t = nLab === 1 ? t0 : t0 + span*k/(nLab-1);
    const iso = new Date(t).toISOString().slice(0,10);
    const anchor = nLab === 1 ? 'middle' : k === 0 ? 'start' : k === nLab-1 ? 'end' : 'middle';
    xlab += `<text class="ch-txt" x="${xOf(t).toFixed(1)}" y="${H-B+16}" text-anchor="${anchor}">${fmtDataBreve(iso)}</text>`;
  }
  const avg = o.media != null ? `<line class="ch-avg" x1="${L}" x2="${W-R}" y1="${yOf(o.media).toFixed(1)}" y2="${yOf(o.media).toFixed(1)}"/>` : '';
  const path = n > 1 ? `<path class="ch-line ch-line-${o.cls}" d="${punti.map((p,i)=> (i?'L':'M') + xs[i].toFixed(1) + ' ' + yOf(p.y).toFixed(1)).join(' ')}"/>` : '';
  let pts = '', hits = '';
  punti.forEach((p,i) => {
    const sel = o.pick === i;
    const dim = (o.pick != null && !sel) ? ' style="opacity:.5"' : '';
    if(sel) pts += `<line class="ch-selline" x1="${xs[i].toFixed(1)}" x2="${xs[i].toFixed(1)}" y1="${T}" y2="${T+ph}"/>`;
    if(p.y2 != null) pts += `<circle class="ch-raw"${dim} cx="${xs[i].toFixed(1)}" cy="${yOf(p.y2).toFixed(1)}" r="2.5"/>`;
    pts += `<circle class="ch-dot ch-dot-${o.cls}"${dim} cx="${xs[i].toFixed(1)}" cy="${yOf(p.y).toFixed(1)}" r="${sel?5.5:3.5}"/>`;
    const xl = i === 0 ? L : (xs[i-1]+xs[i])/2, xr = i === n-1 ? W-R : (xs[i]+xs[i+1])/2;
    hits += `<rect class="ch-hit" data-action="statPick" data-id="${i}" x="${xl.toFixed(1)}" y="${T}" width="${Math.max(xr-xl,1).toFixed(1)}" height="${ph+B}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHTML(o.aria)}" style="display:block;font-family:var(--font-mono);">${grid}${xlab}${avg}${path}${pts}${hits}</svg>`;
}
function statsVuotoHTML(n){
  return `<div class="card muted" style="text-align:center;padding:24px;">Servono almeno ${MIN_RIFORNIMENTI_STATS} rifornimenti per questo grafico (ne hai ${n}).</div>`;
}
function statsConsumoHTML(st){
  const { n, punti } = serieConsumo(state.cache.rifornimenti, st.periodo);
  if(n < MIN_RIFORNIMENTI_STATS) return statsVuotoHTML(n);
  if(!punti.length) return `<div class="card muted" style="text-align:center;padding:24px;">Nessun dato di consumo ${st.periodo>0 ? 'negli ultimi '+st.periodo+' mesi' : ''}.</div>`;
  const globale = consumoGlobale(state.cache.rifornimenti);
  const ultimo = punti[punti.length-1];
  const vmin = Math.min(...punti.map(p=>p.valore)), vmax = Math.max(...punti.map(p=>p.valore));
  const riassunto = `Consumo ${statsPeriodoLabel(st.periodo)}: media mobile più recente ${fmtKmL(ultimo.media)} km/l${globale!=null ? `, media globale ${fmtKmL(globale)} km/l` : ''}. Tratte da ${fmtKmL(vmin)} a ${fmtKmL(vmax)} km/l su ${punti.length} ${punti.length===1?'rifornimento':'rifornimenti'}.`;
  const sel = st.pick != null ? punti[st.pick] : null;
  return `
    <div class="mono" style="font-size:24px;font-weight:700;">${globale!=null ? fmtKmL(globale) : '—'} <span style="font-size:14px;font-weight:500;" class="muted">km/l</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:14px;">Media globale · ${punti.length} ${punti.length===1?'tratta':'tratte'} · ${statsPeriodoLabel(st.periodo)}</div>
    <div class="card" style="padding:12px;">
      ${svgLinee(punti.map(p=>({data:p.data, y:p.media, y2:p.valore})), { media:globale, pick:st.pick, aria:riassunto, cls:'ok', fmtY:v=>fmtKmL(v) })}
      <div class="ch-legend"><span><i class="ch-sw" style="background:var(--ok)"></i>Media mobile (3 tratte)</span><span><i class="ch-sw ch-sw-ring"></i>Singola tratta</span>${globale!=null ? `<span><i class="ch-sw ch-sw-dash"></i>Media globale</span>` : ''}</div>
      <div aria-live="polite" style="margin-top:12px;font-size:13px;min-height:38px;">${sel
        ? `<div style="font-weight:600;">${fmtDate(sel.data)}</div><div class="mono muted">${fmtKm(sel.km)} · ${sel.litri.toLocaleString('it-IT',{maximumFractionDigits:2})} L · tratta <span style="color:var(--text);">${fmtKmL(sel.valore)} km/l</span> · media mobile <span style="color:var(--text);">${fmtKmL(sel.media)} km/l</span></div>`
        : `<div class="muted">Tocca un punto per vedere il dettaglio del rifornimento.</div>`}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:10px 2px 0;">${escapeHTML(riassunto)}</p>`;
}
function statsPrezzoHTML(st){
  const { n, punti, media } = seriePrezzo(state.cache.rifornimenti, st.periodo);
  if(n < MIN_RIFORNIMENTI_STATS) return statsVuotoHTML(n);
  if(!punti.length) return `<div class="card muted" style="text-align:center;padding:24px;">Nessun rifornimento con prezzo ${st.periodo>0 ? 'negli ultimi '+st.periodo+' mesi' : ''}.</div>`;
  const vmin = Math.min(...punti.map(p=>p.valore)), vmax = Math.max(...punti.map(p=>p.valore));
  const ultimo = punti[punti.length-1];
  const riassunto = `Prezzo carburante ${statsPeriodoLabel(st.periodo)}: media ${fmtPrezzoL(media)}, ultimo ${fmtPrezzoL(ultimo.valore)}, da ${fmtPrezzoL(vmin)} a ${fmtPrezzoL(vmax)} su ${punti.length} ${punti.length===1?'rifornimento':'rifornimenti'}.`;
  const sel = st.pick != null ? punti[st.pick] : null;
  return `
    <div class="mono" style="font-size:24px;font-weight:700;">${fmtPrezzoL(media)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:14px;">Prezzo medio · ${punti.length} ${punti.length===1?'rifornimento':'rifornimenti'} · ${statsPeriodoLabel(st.periodo)}</div>
    <div class="card" style="padding:12px;">
      ${svgLinee(punti.map(p=>({data:p.data, y:p.valore})), { media, pick:st.pick, aria:riassunto, cls:'info', fmtY:v=>v.toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:3}) })}
      <div class="ch-legend"><span><i class="ch-sw" style="background:var(--info)"></i>Prezzo al litro</span><span><i class="ch-sw ch-sw-dash"></i>Media del periodo</span></div>
      <div aria-live="polite" style="margin-top:12px;font-size:13px;min-height:38px;">${sel
        ? `<div style="font-weight:600;">${fmtDate(sel.data)}</div><div class="mono muted"><span style="color:var(--text);">${fmtPrezzoL(sel.valore)}</span> · ${fmtEuro(sel.costo)} per ${sel.litri.toLocaleString('it-IT',{maximumFractionDigits:2})} L</div>`
        : `<div class="muted">Tocca un punto per vedere il dettaglio del rifornimento.</div>`}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:10px 2px 0;">${escapeHTML(riassunto)}</p>`;
}

/* --- modale --- */
function statsSpesaHTML(st){
  const { mesi, voci } = serieSpesaMensile(state.cache, st.periodo);
  if(!voci.length) return `<div class="card muted" style="text-align:center;padding:24px;">Nessuna spesa registrata${st.periodo>0 ? ' negli ultimi '+st.periodo+' mesi' : ''}</div>`;
  const totC = mesi.reduce((s,m)=> s+m.carb, 0), totM = mesi.reduce((s,m)=> s+m.manut, 0), tot = totC + totM;
  const iTop = mesi.reduce((b,m,i)=> (m.carb+m.manut) > (mesi[b].carb+mesi[b].manut) ? i : b, 0);
  const label = st.periodo > 0 ? `ultimi ${st.periodo} mesi` : `da sempre (${mesi.length} ${mesi.length===1?'mese':'mesi'})`;
  const riassunto = `Spesa ${label}: totale ${fmtEuro(tot)}, di cui carburante ${fmtEuro(totC)} e manutenzione ${fmtEuro(totM)}. Media mensile ${fmtEuro(tot/mesi.length)}. Mese più alto: ${meseLungo(mesi[iTop].key)} (${fmtEuro(mesi[iTop].carb+mesi[iTop].manut)}).`;
  const sel = (st.pick != null) ? mesi[st.pick] : null;
  const nomi = {manutenzioni:'Manutenzione', rifornimenti:'Rifornimento', scadenze:'Scadenza'};
  return `
    <div class="mono" style="font-size:24px;font-weight:700;">${fmtEuro(tot)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:14px;">${voci.length} ${voci.length===1?'voce':'voci'} · ${label}</div>
    <div class="card" style="padding:12px;">
      ${svgBarreImpilate(mesi, st.pick, riassunto)}
      <div class="ch-legend"><span><i class="ch-sw" style="background:var(--ok)"></i>Carburante</span><span><i class="ch-sw" style="background:var(--accent)"></i>Manutenzione (incl. scadenze)</span></div>
      <div aria-live="polite" style="margin-top:12px;font-size:13px;min-height:38px;">${sel
        ? `<div style="font-weight:600;text-transform:capitalize;">${meseLungo(sel.key)}</div><div class="mono muted">Carburante ${fmtEuro(sel.carb)} · Manutenzione ${fmtEuro(sel.manut)} · <span style="color:var(--text);">Totale ${fmtEuro(sel.carb+sel.manut)}</span></div>`
        : `<div class="muted">Tocca una barra per vedere il dettaglio del mese.</div>`}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:10px 2px 16px;">${escapeHTML(riassunto)}</p>
    <div class="card">${voci.map(x=>`
      <div data-action="openEdit" data-type="${x._type}" data-id="${x.id}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;min-height:44px;">
        <div style="min-width:0;">
          <div style="font-size:14px;font-weight:600;">${escapeHTML(x._label)}</div>
          <div class="muted" style="font-size:12px;">${fmtDate(x.data)} · ${nomi[x._type]}${x._type==='scadenze' && x.stato!=='completata' ? ' (attiva)' : ''}</div>
        </div>
        <div class="mono" style="font-weight:700;white-space:nowrap;">${fmtEuro(x.costo)}</div>
      </div>`).join('')}</div>`;
}
function statsBodyHTML(){
  const st = state.stats || { tab:'spesa', periodo:12, pick:null };
  if(!STATS_TABS.some(t=>t.id===st.tab)) st.tab = STATS_TABS[0].id;
  const tabs = STATS_TABS.length > 1
    ? `<div class="sub-tabs">${STATS_TABS.map(t=>`<button class="sub-tab ${st.tab===t.id?'active':''}" data-action="statsTab" data-id="${t.id}">${t.label}</button>`).join('')}</div>`
    : '';
  const periodi = `<div style="display:flex;gap:8px;margin-bottom:14px;">${STATS_PERIODI.map(p=>`<button class="chip ${st.periodo===p.v?'active':''}" style="min-height:44px;" data-action="statsPeriodo" data-value="${p.v}" aria-pressed="${st.periodo===p.v}">${p.label}</button>`).join('')}</div>`;
  const corpo = st.tab==='spesa' ? statsSpesaHTML(st) : st.tab==='consumo' ? statsConsumoHTML(st) : st.tab==='prezzo' ? statsPrezzoHTML(st) : '';
  return `
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.chart}</div><h2>Statistiche</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    ${tabs}${periodi}${corpo}`;
}
function statisticheModal(){ return modalWrapper(statsBodyHTML()); }
// Aggiorna solo il corpo della modale (niente render() completo)
function statsRefresh(){
  const sheet = document.querySelector('.modal-sheet');
  if(!sheet || state.modal?.view !== 'stats') return;
  const sc = sheet.scrollTop;
  sheet.innerHTML = statsBodyHTML();
  sheet.scrollTop = sc;
}

function calKmStatoHTML(v){
  const c = v.calendarKm;
  if(!c) return '';
  return c.giorni===state.settings.kmReminderDays
    ? `<div class="badge badge-ok" style="display:block;text-align:center;margin-top:14px;padding:8px;">✓ Promemoria km già aggiunto a Google Calendar</div>`
    : `<div class="badge badge-warn" style="display:block;text-align:center;margin-top:14px;padding:8px;">Aggiunto a Calendar ogni ${c.giorni} giorni, ma ora l'intervallo è ${state.settings.kmReminderDays}: aggiungilo di nuovo</div>`;
}
function viewVeicoloDetail(v){
  const tile = statTile;
  const nProblemi = state.cache.problemi.filter(p=>p.stato==='aperto').length;
  return `<div class="content veh-detail">
    <div class="card">
      <div class="veh-head" style="justify-content:space-between;">
        <div class="veh-name grow" style="min-width:0;overflow-wrap:anywhere;">${escapeHTML(v.marca)} ${escapeHTML(v.modello)}</div>
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <button class="icon-btn" data-action="setPreferito" data-id="${v.id}" style="${v.preferito?'color:var(--warn);':''}" title="Veicolo principale" aria-label="Veicolo principale" aria-pressed="${!!v.preferito}">${(() => { const s = ICONS.star; return v.preferito ? s.replace('class="icon"','class="icon" fill="currentColor"') : s; })()}</button>
          <button class="icon-btn" data-action="openVeicoloForm" data-id="${v.id}" aria-label="Modifica veicolo">${ICONS.wrench}</button>
        </div>
      </div>
      <div class="tile-grid">
        ${tile(v.tipo==='moto'?ICONS.bike:ICONS.car,'var(--accent-dim)','var(--accent)','Tipo',v.tipo==='moto'?'Moto':'Auto')}
        ${tile(ICONS.calendar,'var(--accent-dim)','var(--accent)','Anno',v.anno)}
        ${tile(ICONS.file,'var(--accent-dim)','var(--accent)','Targa',v.targa||'—')}
        ${tile(ICONS.dashboard,'var(--accent-dim)','var(--accent)','Km attuali',fmtKm(v.kmAttuali))}
      </div>
      <div id="calKmStato">${calKmStatoHTML(v)}</div>
      <a data-action="calendarioKmAggiunto" data-id="${v.id}" href="${googleCalendarLink({title:`Controlla km - ${v.marca} ${v.modello}`, dateISO:addDays(todayISO(), state.settings.kmReminderDays), details:'Promemoria ricorrente da MyGarage: aggiorna i km del veicolo', recurRule:`RRULE:FREQ=DAILY;INTERVAL=${state.settings.kmReminderDays}`})}" target="_blank" rel="noopener" class="btn-soft" style="margin-top:${v.calendarKm?'8':'14'}px;">${ICONS.calendar} <span>${v.calendarKm?'Aggiungi di nuovo':'Aggiungi'} promemoria km ricorrente su Calendar</span></a>
    </div>

    <div class="sec-head" style="margin-top:24px;"><div class="sec-ico">${ICONS.gomma}</div><h3>Pneumatici</h3></div>
    <div class="card">
      ${pneumaticiCardHTML(v, tile)}
      <button class="btn-soft" style="margin-top:${v.pneumatici?'14':'0'}px;" data-action="openPneumatici" data-id="${v.id}">${ICONS.wrench} <span>${v.pneumatici?'Modifica misure':'Aggiungi misure'}</span></button>
    </div>

    <div class="sec-head" style="margin-top:24px;"><div class="sec-ico">${ICONS.file}</div><h3>Manuale (per l'AI)</h3></div>
    <div class="card">
      ${state.cache.manuale ? `
        <div class="card-row">
          <div style="display:flex;align-items:center;gap:12px;min-width:0;"><div class="sec-ico" style="background:var(--surface-2);color:var(--text-muted);">${ICONS.file}</div><span style="min-width:0;overflow-wrap:anywhere;">${escapeHTML(state.cache.manuale.nome)}</span></div>
          <button class="icon-btn" data-action="deleteManuale" data-id="${state.cache.manuale.id}" aria-label="Elimina manuale">${ICONS.trash}</button>
        </div>` : `
        <label style="margin:0 0 8px;">Nessun manuale caricato</label>
        <label class="btn-soft" style="cursor:pointer;">
          ${ICONS.upload} Carica PDF manuale
          <input type="file" accept="application/pdf" style="display:none;" data-action="uploadManuale" data-id="${v.id}">
        </label>`}
    </div>

    <div class="sec-head" style="margin-top:24px;"><div class="sec-ico">${ICONS.dashboard}</div><h3>Statistiche</h3></div>
    <div class="card">
      <div class="tile-grid">
        ${veicoloStatTilesArray(v).join('')}
        ${tile('<span style="font-weight:700;font-size:13px;">€</span>','var(--ok-dim)','var(--ok)','Spesa manutenzioni',fmtEuro(state.cache.manutenzioni.reduce((s,m)=>s+(m.costo||0),0)))}
        ${tile(ICONS.alert,nProblemi>0?'var(--danger-dim)':'var(--ok-dim)',nProblemi>0?'var(--danger)':'var(--ok)','Problemi aperti',nProblemi)}
      </div>
    </div>

    <button class="btn-soft" style="margin-top:20px;" data-action="exportReportPDF" data-id="${v.id}" ${state.busy?'disabled':''}>
      ${state.busy ? '<div class="spinner"></div> Generazione...' : ICONS.file + ' Esporta report PDF'}
    </button>
    <button class="btn-soft" style="margin-top:10px;" data-action="exportRifornimentiPDF" data-id="${v.id}" ${state.busy?'disabled':''}>${ICONS.gas} Esporta rifornimenti (PDF)</button>
    <button class="btn btn-danger btn-block" style="margin-top:10px;" data-action="deleteVeicolo" data-id="${v.id}">Elimina veicolo</button>
  </div>`;
}

function pneumaticiCardHTML(v, tile){
  const p = v.pneumatici;
  if(!p || (!p.anteriore?.misura && !p.posteriore?.misura)) return `<label style="margin:0 0 8px;display:block;">Nessuna misura salvata</label>`;
  const sub = (x) => x?.marcaModello ? `<div class="muted" style="font-size:12px;margin-top:2px;overflow-wrap:anywhere;">${escapeHTML(x.marcaModello)}</div>` : '';
  const t = (lbl, x) => { const h = tile(ICONS.gomma,'var(--accent-dim)','var(--accent)',lbl, escapeHTML(x?.misura||'—')); return h.slice(0, h.lastIndexOf('</div>')) + sub(x) + '</div>'; };
  if(p.uguali) return `<div class="tile-grid">${t(v.tipo==='moto'?'Ant. e post.':'Tutte e 4', p.anteriore)}</div>`;
  return `<div class="tile-grid">${t('Anteriore', p.anteriore)}${t('Posteriore', p.posteriore)}</div>`;
}
function pneumaticiModal(payload){
  const v = state.veicoli.find(x=>x.id===payload?.id);
  if(!v) return '';
  const p = v.pneumatici || {};
  const isAuto = v.tipo==='auto';
  const uguali = isAuto && (p.uguali ?? true);
  const ph = isAuto ? 'es. 205/45 R17' : 'es. 120/70 ZR17';
  const phPost = isAuto ? 'es. 225/40 R18' : 'es. 160/60 ZR17';
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.gomma}</div><h2>Pneumatici</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <form id="pneuForm">
      ${isAuto ? `<div class="field"><label style="display:flex;align-items:center;gap:8px;margin-top:0;cursor:pointer;">
        <input type="checkbox" name="uguali" ${uguali?'checked':''} data-action="togglePneuUguali" style="width:auto;">
        <span style="font-size:13px;color:var(--text);">Anteriori e posteriori uguali</span>
      </label></div>` : ''}
      <div class="field"><label id="pneuAntLbl">${uguali?'Misura (tutte e 4)':'Misura anteriore'}</label><input name="antMisura" value="${escapeHTML(p.anteriore?.misura||'')}" placeholder="${ph}" autocapitalize="characters"></div>
      <div class="field"><label>Marca / modello (opzionale)</label><input name="antMarca" value="${escapeHTML(p.anteriore?.marcaModello||'')}"></div>
      <div id="pneuPost" style="${uguali?'display:none;':''}">
        <div class="field"><label>Misura posteriore</label><input name="postMisura" value="${escapeHTML(p.posteriore?.misura||'')}" placeholder="${phPost}" autocapitalize="characters"></div>
        <div class="field"><label>Marca / modello posteriore (opzionale)</label><input name="postMarca" value="${escapeHTML(p.posteriore?.marcaModello||'')}"></div>
      </div>
      <div class="actions-footer">
        <button type="submit" class="btn btn-primary btn-block" data-action="savePneumatici" data-id="${v.id}">Salva</button>
      </div>
    </form>
  `);
}

/* Tessera statistica: icona SEMPRE colorata. Se non viene passato un colore (o è neutro) si usa l'accent. */
function statTile(icon,bg,col,lbl,val,sub,act){
  const neutro = !bg || bg==='var(--surface)' || bg==='var(--surface-2)';
  if(neutro){ bg = 'var(--accent-dim)'; col = 'var(--accent)'; }
  return `<div class="tile"${act ? ` data-action="openStatistiche" data-tab="${act}" role="button" style="cursor:pointer;" aria-label="${lbl}: apri statistiche"` : ''}><div class="tile-head"><div class="tile-ico" style="background:${bg};color:${col};">${icon}</div><div class="tile-lbl">${lbl}</div></div><div class="tile-val mono">${val}</div>${sub?`<div class="tile-sub">${sub}</div>`:''}</div>`;
}
/* Le 4 statistiche della card principale (Km attuali, Anno, Consumo, Scadenza): usate in Dashboard e nella scheda veicolo */
function veicoloStatTilesArray(v){
  const consumoKmL = consumoGlobale(state.cache.rifornimenti);
  const prossima = state.cache.scadenze.find(s=>s.stato==='attiva');
  const gScad = prossima ? daysBetween(todayISO(),prossima.data) : null;
  const scadVal = gScad===null ? '—' : (gScad>30 ? Math.ceil(gScad/30)+' '+(Math.ceil(gScad/30)===1?'mese':'mesi') : gScad+' gg');
  const scadSub = gScad===null ? 'Nessuna scadenza' : tipoScadenzaLabel(prossima.tipo);
  return [
    statTile(ICONS.dashboard,'var(--info-dim)','var(--info)','Km attuali',fmtKm(v.kmAttuali)),
    v.anno ? statTile(ICONS.calendar,'var(--accent-dim)','var(--accent)','Anno',escapeHTML(String(v.anno))) : '',
    statTile(ICONS.gas,'var(--ok-dim)','var(--ok)','Consumo',consumoKmL ? consumoKmL.toLocaleString('it-IT',{minimumFractionDigits:1,maximumFractionDigits:1}) : '—',consumoKmL ? 'km al litro' : 'Servono 2+ rifornimenti','consumo'),
    statTile(ICONS.calendar,'var(--warn-dim)','var(--warn)','Scadenza',scadVal,scadSub),
  ];
}
function veicoloStatTilesHTML(v){
  return `<div class="tile-grid">\n          ${veicoloStatTilesArray(v).join('\n          ')}\n        </div>`;
}

function categoriaLabel(cat, custom){
  const map = {olio:'Cambio olio', catena:'Catena', pastiglie:'Pastiglie freni', gomme:'Gomme', tagliando:'Tagliando', altro: custom || 'Altro'};
  return map[cat] || cat;
}
function tipoScadenzaLabel(t){
  const map = {bollo:'Bollo', assicurazione:'Assicurazione', revisione:'Revisione', tagliando:'Tagliando', altro:'Altro'};
  return map[t] || t;
}

function dateGroupLabel(dataISO){
  const diff = daysBetween(dataISO, todayISO());
  if(diff < 0) return 'In programma';
  if(diff === 0) return 'Oggi';
  if(diff === 1) return 'Ieri';
  if(diff <= 7) return 'Questa settimana';
  return 'Più vecchi';
}

function viewLog(){
  if(!state.veicoli.length){
    return `<div class="content">${emptyState('list','Nessun dato','Aggiungi prima un veicolo dalla scheda Veicoli.',null,null)}</div>`;
  }
  const filters = [
    {id:'tutti', label:'Tutti'},
    {id:'manutenzioni', label:'Manutenzioni'},
    {id:'scadenze', label:'Scadenze'},
    {id:'problemi', label:'Problemi'},
    {id:'rifornimenti', label:'Rifornimenti'},
  ];
  let items = [];
  if(state.logFilter==='tutti' || state.logFilter==='manutenzioni'){
    items.push(...state.cache.manutenzioni.map(m=>({...m,_type:'manutenzioni'})));
  }
  if(state.logFilter==='tutti' || state.logFilter==='scadenze'){
    items.push(...state.cache.scadenze.map(s=>({...s,_type:'scadenze'})));
  }
  if(state.logFilter==='tutti' || state.logFilter==='problemi'){
    items.push(...state.cache.problemi.map(p=>({...p,_type:'problemi'})));
  }
  if(state.logFilter==='tutti' || state.logFilter==='rifornimenti'){
    items.push(...state.cache.rifornimenti.map(r=>({...r,_type:'rifornimenti'})));
  }
  items.sort((a,b)=> new Date(b.data)-new Date(a.data));

  const groups = [];
  for(const it of items){
    const label = dateGroupLabel(it.data);
    const last = groups[groups.length-1];
    if(!last || last.label !== label) groups.push({label, items:[it]});
    else last.items.push(it);
  }

  return `<div class="content diario">
    <div class="chip-row">
      ${filters.map(f=>`<button class="chip ${state.logFilter===f.id?'active':''}" data-action="setLogFilter" data-id="${f.id}">${f.label}</button>`).join('')}
    </div>
    ${items.length ? groups.map(g=>`
      <div class="log-group">${g.label}</div>
      <div class="card">${g.items.map(it=>logItemHTML(it)).join('')}</div>
    `).join('') : `<div class="card muted" style="text-align:center;padding:24px;">Nessun elemento in questa categoria</div>`}
  </div>`;
}

function logItemHTML(it){
  let icon, iconBg, iconColor, title, sub, meta='';
  if(it._type==='manutenzioni'){
    const iconeCategoria = { olio: ICONS.oliva, gomme: ICONS.gomma, catena: ICONS.catena, tagliando: ICONS.tagliandoIcon };
    icon=iconeCategoria[it.categoria] || ICONS.wrench; iconBg='var(--accent-dim)'; iconColor='var(--accent)';
    title=categoriaLabel(it.categoria,it.categoriaCustom); sub=`${fmtKm(it.km)}${it.costo?' · '+fmtEuro(it.costo):''}`;
  } else if(it._type==='scadenze'){
    icon=ICONS.calendar; iconBg='var(--warn-dim)'; iconColor='var(--warn)';
    title=tipoScadenzaLabel(it.tipo); sub=(it.stato==='completata'?'Completata':'Attiva')+(it.costo?' · '+fmtEuro(it.costo):'');
  } else if(it._type==='problemi'){
    icon=ICONS.alert; iconBg='var(--danger-dim)'; iconColor='var(--danger)';
    title=it.sintomi; sub=it.stato==='risolto'?'Risolto':'Aperto';
  } else {
    icon=ICONS.gas; iconBg='var(--ok-dim)'; iconColor='var(--ok)';
    const prezzoLitro = it.litri > 0 ? (it.costo/it.litri) : null;
    title=`${it.litri} L`;
    sub=`${fmtEuro(it.costo)}${prezzoLitro?' · '+prezzoLitro.toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})+' €/L':''} · ${fmtKm(it.km)}`;
  }
  return `<button class="log-item" style="width:100%;background:none;border:none;text-align:left;cursor:pointer;" data-action="openEdit" data-type="${it._type}" data-id="${it.id}">
    <div class="log-dot" style="background:${iconBg};color:${iconColor};">${icon}</div>
    <div class="log-body">
      <div class="log-title">${escapeHTML(title)}</div>
      <div class="log-sub">${escapeHTML(sub)}</div>
    </div>
    <div class="log-meta">${fmtDate(it.data)}</div>
  </button>`;
}

function shiftCalendarMonth(delta){
  if(!state.calendarMonth) state.calendarMonth = todayISO().slice(0,7);
  const [y,m] = state.calendarMonth.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  state.calendarMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  state.calendarSelectedDate = null;
  render();
}

function getAllEventItems(){
  return [
    ...state.cache.manutenzioni.map(m=>({...m,_type:'manutenzioni'})),
    ...state.cache.scadenze.map(s=>({...s,_type:'scadenze'})),
    ...state.cache.problemi.map(p=>({...p,_type:'problemi'})),
    ...state.cache.rifornimenti.map(r=>({...r,_type:'rifornimenti'})),
  ];
}

function dotColorForType(type){
  return type==='manutenzioni' ? 'var(--accent)' : type==='scadenze' ? 'var(--warn)' : type==='problemi' ? 'var(--danger)' : 'var(--ok)';
}

function viewCalendario(){
  if(!state.veicoli.length){
    return `<div class="content">${emptyState('calendar','Nessun dato','Aggiungi prima un veicolo dalla scheda Veicoli.',null,null)}</div>`;
  }
  if(!state.calendarMonth) state.calendarMonth = todayISO().slice(0,7);
  const [year, month] = state.calendarMonth.split('-').map(Number);
  const first = new Date(year, month-1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startOffset = (first.getDay()+6)%7;

  const items = getAllEventItems();
  const byDate = {};
  items.forEach(it=>{ if(it.data) (byDate[it.data] ||= []).push(it); });

  const monthLabel = first.toLocaleDateString('it-IT',{month:'long',year:'numeric'});
  const selected = state.calendarSelectedDate;
  const dayItems = selected
    ? (byDate[selected]||[]).sort((a,b)=> new Date(b.data)-new Date(a.data))
    : items.filter(it=> it.data && it.data.slice(0,7)===state.calendarMonth).sort((a,b)=> new Date(b.data)-new Date(a.data));

  const weekDays = ['L','M','M','G','V','S','D'];
  let cells = '';
  for(let i=0;i<startOffset;i++) cells += `<div class="cal-cell cal-empty"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayEvents = byDate[dateStr] || [];
    const types = [...new Set(dayEvents.map(e=>e._type))];
    const isToday = dateStr === todayISO();
    const isSelected = dateStr === selected;
    const label = `${d} ${monthLabel}${dayEvents.length ? `, ${dayEvents.length} evento${dayEvents.length>1?'i':''}` : ''}`;
    cells += `<button class="cal-cell ${isToday?'cal-today':''} ${isSelected?'cal-selected':''}" data-action="calSelectDay" data-date="${dateStr}" aria-label="${label}" aria-pressed="${isSelected}">
      <span class="cal-daynum mono">${d}</span>
      ${types.length ? `<span class="cal-dots">${types.slice(0,3).map(t=>`<span class="cal-dot" style="background:${dotColorForType(t)}"></span>`).join('')}</span>` : ''}
    </button>`;
  }

  return `<div class="content cal">
    <div class="card">
    <div class="cal-nav">
      <button class="icon-btn" data-action="calPrevMonth" aria-label="Mese precedente"><span style="display:inline-flex;transform:rotate(180deg);">${ICONS.chevron}</span></button>
      <div class="cal-month-label">${monthLabel.charAt(0).toUpperCase()+monthLabel.slice(1)}</div>
      <button class="icon-btn" data-action="calNextMonth" aria-label="Mese successivo">${ICONS.chevron}</button>
    </div>
    <div class="cal-weekdays">${weekDays.map(w=>`<div>${w}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span><span class="cal-dot" style="background:var(--accent)"></span>Manutenzioni</span>
      <span><span class="cal-dot" style="background:var(--warn)"></span>Scadenze</span>
      <span><span class="cal-dot" style="background:var(--danger)"></span>Problemi</span>
      <span><span class="cal-dot" style="background:var(--ok)"></span>Rifornimenti</span>
    </div>
    </div>
    <div class="sec-head" style="margin-top:24px;"><div class="sec-ico">${ICONS.calendar}</div><h3>${selected ? fmtDate(selected) : 'Eventi del mese'}</h3></div>
    ${dayItems.length ? `<div class="card events-card">${dayItems.map(it=>logItemHTML(it)).join('')}</div>` : `<div class="card muted" style="text-align:center;padding:24px;">Nessun evento${selected?' in questo giorno':' in questo mese'}</div>`}
  </div>`;
}

function viewAI(){
  if(!state.veicoli.length){
    return `<div class="content">${emptyState('spark','Aggiungi un veicolo','Le funzioni AI hanno bisogno di un veicolo selezionato.',null,null)}</div>`;
  }
  const v = currentVeicolo();
  if(!state.settings.geminiApiKey){
    return `<div class="content ai">
      <div class="card" style="text-align:center;padding:30px 20px;">
        <div class="sec-ico" style="margin:0 auto;width:52px;height:52px;border-radius:16px;">${ICONS.spark}</div>
        <h3 style="margin:12px 0 6px;">Configura l'assistente AI</h3>
        <p class="muted" style="font-size:13.5px;margin:0 0 18px;">Serve una chiave Gemini gratuita (2 minuti, nessuna carta) per usare chat, analisi manuale e lettura foto.</p>
        <button class="btn btn-primary" data-action="setTab" data-id="impostazioni">Vai in Impostazioni</button>
      </div>
    </div>`;
  }
  return `<div class="content ai">
    <div class="sub-tabs">
      <button class="sub-tab ${state.aiSubtab==='chat'?'active':''}" data-action="setAiSubtab" data-id="chat">Assistente</button>
      <button class="sub-tab ${state.aiSubtab==='manuale'?'active':''}" data-action="setAiSubtab" data-id="manuale">Manuale</button>
    </div>
    ${state.aiSubtab==='chat' ? viewAIChat(v) : viewAIManuale(v)}
  </div>`;
}

function viewAIChat(v){
  return `
    <div class="chat-scroll">
      ${state.chatHistory.length===0 ? `<div class="muted" style="text-align:center;padding:30px 10px;font-size:13.5px;"><div class="sec-ico" style="margin:0 auto 12px;">${ICONS.spark}</div>Chiedimi consigli su rumori strani, spie accese, o problemi ricorrenti su ${escapeHTML(v.marca)} ${escapeHTML(v.modello)}. Uso lo storico problemi come contesto.</div>` : ''}
      ${state.chatHistory.map(m=>`<div class="msg ${m.role==='user'?'msg-user':'msg-ai'}">${escapeHTML(m.content)}</div>`).join('')}
      ${state.chatError && !state.busy ? `<div class="msg msg-ai" style="border:1px solid var(--danger);">Errore: ${escapeHTML(state.chatError)}<div style="margin-top:10px;"><button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" data-action="retryChat">Riprova</button></div></div>` : ''}
      ${state.busy ? `<div class="msg msg-ai" style="display:flex;align-items:center;gap:8px;"><div class="spinner"></div>${state.busyStatus ? `<span style="font-size:13px;">${escapeHTML(state.busyStatus)}</span>` : ''}</div>` : ''}
    </div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" placeholder="Scrivi un messaggio..." ${state.busy?'disabled':''}>
      <button class="btn btn-primary" data-action="sendChat" aria-label="Invia" ${state.busy?'disabled':''}>${ICONS.send}</button>
    </div>
    <div class="muted" style="font-size:11.5px;text-align:center;margin-top:6px;">Richiede connessione internet</div>
  `;
}

function viewAIManuale(v){
  return `
    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.file}</div><h3>Manuale del veicolo</h3></div>
      ${state.cache.manuale ? `
        <div class="tile" style="margin-bottom:14px;">
          <div class="tile-lbl">File caricato</div>
          <div class="tile-sub" style="color:var(--text);">${escapeHTML(state.cache.manuale.nome)}</div>
        </div>
        <button class="btn btn-primary btn-block" data-action="analizzaManuale" ${state.busy?'disabled':''}>
          ${state.busy ? `<div class="spinner"></div> ${escapeHTML(state.busyStatus || 'Analisi in corso...')}` : 'Analizza e proponi scadenze'}
        </button>
        ${state.manualeError ? `
        <div class="banner" style="margin-top:12px;margin-bottom:0;">
          <div class="banner-icon">${ICONS.alert}</div>
          <div class="banner-text">${escapeHTML(state.manualeError)}
            <div style="margin-top:8px;"><button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" data-action="analizzaManuale" ${state.busy?'disabled':''}>Riprova</button></div>
          </div>
          <button class="banner-close" data-action="dismissManualeError" aria-label="Chiudi avviso">${ICONS.close}</button>
        </div>` : ''}
        <div class="muted" style="font-size:11.5px;text-align:center;margin-top:8px;">Richiede connessione internet</div>
      ` : `
        <label class="btn-soft" style="cursor:pointer;">
          ${ICONS.upload} Carica PDF manuale del veicolo
          <input type="file" accept="application/pdf" style="display:none;" data-action="uploadManuale" data-id="${v.id}">
        </label>
      `}
    </div>
    ${state.proposte && state.proposte.length ? `
      <div class="sec-head" style="margin-top:24px;"><div class="sec-ico" style="background:var(--warn-dim);color:var(--warn);">${ICONS.calendar}</div><h3>Proposte scadenze</h3></div>
      <div class="card">
        ${state.proposte.map((p,i)=>`
          <div class="proposal-item">
            <button class="checkbox ${p.accettata?'checked':''}" data-action="toggleProposta" data-id="${i}" role="checkbox" aria-checked="${!!p.accettata}" aria-label="Includi proposta">${p.accettata?ICONS.check:''}</button>
            <div style="flex:1;">
              <div class="log-title">${escapeHTML(p.descrizione)}</div>
              <div class="log-sub">${p.intervalloKm?fmtKm(p.intervalloKm):''}${p.intervalloMesi?' · ogni '+p.intervalloMesi+' mesi':''}</div>
            </div>
          </div>`).join('')}
        <button class="btn btn-primary btn-block" style="margin-top:14px;" data-action="salvaProposte">Salva selezionate</button>
      </div>
    ` : ''}
  `;
}

function viewImpostazioni(){
  const hasKey = !!state.settings.geminiApiKey;
  return `<div class="content settings">
    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.edit}</div><h3>Aspetto</h3></div>
      <div class="field" style="margin-top:0;">
        <label>Modalità</label>
        <div class="sub-tabs" style="margin-bottom:0;">
          <button type="button" class="sub-tab ${state.settings.themeMode==='dark'?'active':''}" data-action="setThemeMode" data-value="dark">Scuro</button>
          <button type="button" class="sub-tab ${state.settings.themeMode==='light'?'active':''}" data-action="setThemeMode" data-value="light">Chiaro</button>
        </div>
      </div>
      <div class="field">
        <label>Colore d'accento</label>
        <div style="display:flex;gap:12px;margin-top:4px;">
          ${Object.entries(ACCENT_TOKENS).map(([key,t])=>`
            <button type="button" data-action="setThemeAccent" data-value="${key}" title="${t.label}" style="width:44px;height:44px;border-radius:50%;background:${t.accent};border:3px solid ${state.settings.themeAccent===key?'var(--text)':'transparent'};outline:1px solid var(--border);"></button>
          `).join('')}
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px;">${ACCENT_TOKENS[state.settings.themeAccent]?.label||''}</div>
      </div>
    </div>

    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.spark}</div><h3>Assistente AI</h3></div>
      ${hasKey ? `
        <div class="card-row">
          <div style="display:flex;align-items:center;gap:10px;">
            <div class="sec-ico" style="background:var(--ok-dim);color:var(--ok);">${ICONS.check}</div>
            <div>
              <div style="font-size:14px;">Chiave Gemini configurata</div>
              <div class="muted mono" style="font-size:12px;margin-top:2px;">${state.settings.geminiApiKey.slice(0,6)}••••••••</div>
            </div>
          </div>
          <button class="icon-btn" data-action="rimuoviGeminiKey" aria-label="Rimuovi chiave Gemini">${ICONS.trash}</button>
        </div>
      ` : `
        <p class="muted" style="font-size:13.5px;margin:0 0 14px;line-height:1.5;">Le funzioni AI (chat, analisi manuale, lettura foto) usano Google Gemini con una chiave gratuita tua — nessun costo, nessuna carta richiesta.</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
          <div style="display:flex;gap:10px;align-items:flex-start;"><div class="mono step-n">1</div><div style="font-size:13.5px;">Vai su <b>aistudio.google.com</b> e accedi con un account Google</div></div>
          <div style="display:flex;gap:10px;align-items:flex-start;"><div class="mono step-n">2</div><div style="font-size:13.5px;">Nella barra laterale tocca <b>"Get API key"</b> → <b>"Create API key"</b></div></div>
          <div style="display:flex;gap:10px;align-items:flex-start;"><div class="mono step-n">3</div><div style="font-size:13.5px;">Copia la chiave generata (inizia con <b>AIza...</b>)</div></div>
          <div style="display:flex;gap:10px;align-items:flex-start;"><div class="mono step-n">4</div><div style="font-size:13.5px;">Incollala qui sotto e salva</div></div>
        </div>
        <form id="geminiKeyForm">
          <input type="password" name="geminiApiKey" placeholder="AIzaSy..." autocomplete="off" required>
          <button type="submit" class="btn btn-primary btn-block" style="margin-top:10px;">Salva chiave</button>
        </form>
      `}
      <div class="muted" style="font-size:11.5px;margin-top:14px;line-height:1.5;">La chiave resta salvata solo su questo dispositivo (nel database locale dell'app) e viene inviata solo a Google, direttamente dal tuo telefono.</div>
    </div>

    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.calendar}</div><h3>Promemoria</h3></div>
      <div class="field" style="margin-top:0;">
        <label>Sollecita aggiornamento km dopo (giorni)</label>
        <input type="number" min="1" max="60" value="${state.settings.kmReminderDays}" data-action="setKmReminderDays">
      </div>
      <div class="field">
        <label>Segnala scadenze in arrivo entro (giorni)</label>
        <input type="number" min="1" max="90" value="${state.settings.scadenzaReminderDays}" data-action="setScadenzaReminderDays">
      </div>
    </div>

    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.file}</div><h3>Backup dati</h3></div>
      <p class="muted" style="font-size:13.5px;margin:0 0 10px;line-height:1.5;">Esporta tutti i dati in un unico file JSON, o ripristina da un backup precedente. La chiave Gemini non è inclusa nel file.</p>
      <div class="muted" style="font-size:12.5px;margin-bottom:${state.storagePersisted===false?'6':'14'}px;">${backupDaysAgo()===null ? 'Nessun backup ancora eseguito' : backupDaysAgo()===0 ? 'Ultimo backup: oggi' : `Ultimo backup: ${backupDaysAgo()} giorni fa`}</div>
      ${state.storagePersisted===false ? `<div style="font-size:12.5px;margin-bottom:14px;color:var(--warn-text);">Il browser non garantisce la conservazione dei dati: potrebbe cancellarli se lo spazio scarseggia. Fai backup regolari.</div>` : ''}
      ${state.veicoli.length > 1 ? `
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Veicoli da includere</div>
      ${state.veicoli.map(v=>`
      <div class="card-row" style="margin-bottom:10px;">
        <div style="font-size:14px;">${escapeHTML(v.marca)} ${escapeHTML(v.modello)}</div>
        <button class="checkbox ${!state.backupExcluded.has(v.id)?'checked':''}" data-action="toggleBackupVeicolo" data-id="${v.id}" role="checkbox" aria-checked="${!state.backupExcluded.has(v.id)}" aria-label="Includi ${escapeHTML(v.marca)} ${escapeHTML(v.modello)} nel backup">${!state.backupExcluded.has(v.id)?ICONS.check:''}</button>
      </div>`).join('')}
      <div style="height:1px;background:var(--border);margin:4px 0 14px;"></div>
      ` : ''}
      <div class="card-row" style="margin-bottom:14px;">
        <div>
          <div style="font-size:14px;">Includi foto e documenti</div>
          <div class="muted" style="font-size:12px;margin-top:2px;">Disattiva per un file più leggero</div>
        </div>
        <button class="checkbox ${state.settings.includiAllegatiBackup?'checked':''}" data-action="toggleIncludiAllegati" role="checkbox" aria-checked="${!!state.settings.includiAllegatiBackup}" aria-label="Includi foto e documenti nel backup">${state.settings.includiAllegatiBackup?ICONS.check:''}</button>
      </div>
      <button class="btn-soft" data-action="exportBackup" style="margin-bottom:10px;">${ICONS.upload} Esporta backup</button>
      <label class="btn-soft" style="cursor:pointer;">${ICONS.file} Importa backup<input type="file" accept="application/json" id="importInput" style="display:none;"></label>
    </div>

    <div class="card">
      <div class="sec-head"><div class="sec-ico" style="background:var(--danger-dim);color:var(--danger);">${ICONS.alert}</div><h3>Zona pericolosa</h3></div>
      <button class="btn btn-danger btn-block" data-action="cancellaTuttiDati">${ICONS.trash} Cancella tutti i dati</button>
    </div>

    <div class="card">
      <div class="sec-head"><div class="sec-ico">${ICONS.settings}</div><h3>App</h3></div>
      <div class="muted" style="font-size:12.5px;line-height:1.5;">MyGarage v1 — i dati restano sul dispositivo, nessun account richiesto. Le funzioni AI usano la tua chiave Gemini personale e richiedono connessione internet.</div>
    </div>
  </div>`;
}

/* ---------------- FORM MODALS ---------------- */
function modalWrapper(inner){
  return `<div class="modal-overlay" data-action="closeModalBg">
    <div class="modal-sheet" data-stop="1">${inner}</div>
  </div>`;
}

function typeChooserModal(){
  const types = [
    {id:'manutenzioni', icon:ICONS.wrench, label:'Manutenzione', bg:'var(--accent-dim)', col:'var(--accent)'},
    {id:'scadenze', icon:ICONS.calendar, label:'Scadenza', bg:'var(--warn-dim)', col:'var(--warn)'},
    {id:'problemi', icon:ICONS.alert, label:'Problema', bg:'var(--danger-dim)', col:'var(--danger)'},
    {id:'rifornimenti', icon:ICONS.gas, label:'Rifornimento', bg:'var(--ok-dim)', col:'var(--ok)'},
  ];
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.plus}</div><h2>Nuovo elemento</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <div class="type-grid">
      ${types.map(t=>`<button class="type-opt" data-action="openForm" data-type="${t.id}"><span class="sec-ico" style="background:${t.bg};color:${t.col};">${t.icon}</span><span>${t.label}</span></button>`).join('')}
    </div>
  `);
}

function veicoloFormModal(payload){
  const v = payload?.id ? state.veicoli.find(x=>x.id===payload.id) : null;
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.bike}</div><h2>${v?'Modifica veicolo':'Nuovo veicolo'}</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <form id="veicoloForm">
      <div class="field"><label>Tipo</label>
        <div class="sub-tabs" style="margin-bottom:0;">
          <button type="button" class="sub-tab ${(!v||v.tipo==='moto')?'active':''}" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;" data-action="selectTipo" data-value="moto">${ICONS.bike} Moto</button>
          <button type="button" class="sub-tab ${v?.tipo==='auto'?'active':''}" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;" data-action="selectTipo" data-value="auto">${ICONS.car} Auto</button>
        </div>
        <input type="hidden" name="tipo" id="tipoHiddenInput" value="${v?.tipo||'moto'}">
      </div>
      <div class="field"><label>Marca</label><input name="marca" value="${escapeHTML(v?.marca||'')}" required></div>
      <div class="field"><label>Modello</label><input name="modello" value="${escapeHTML(v?.modello||'')}" required></div>
      <div class="field"><label>Anno</label><input name="anno" type="number" value="${v?.anno||new Date().getFullYear()}" required></div>
      <div class="field"><label>Targa</label><input name="targa" value="${escapeHTML(v?.targa||'')}"></div>
      <div class="field"><label>Km attuali</label><input name="kmAttuali" type="number" value="${v?.kmAttuali??0}" required></div>
      <div class="actions-footer">
        <button type="submit" class="btn btn-primary btn-block" data-action="saveVeicolo" data-id="${v?.id||''}">Salva</button>
      </div>
    </form>
  `);
}

function attachThumbsHTML(){
  if(!state.editAttachments.length) return '';
  return state.editAttachments.map(a => `
    <div class="attach-thumb" data-action="viewAttachment" data-id="${a.id||a.tempId}">
      ${a.tipo==='foto' ? `<img src="${a.url}" alt="${escapeHTML(a.nome)}">` : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">${ICONS.file}</div>`}
      <button class="attach-remove" data-action="removeAttachment" data-id="${a.id||a.tempId}" aria-label="Rimuovi allegato">${ICONS.close}</button>
    </div>`).join('');
}

function presetDataDefault(){
  return (state.tab==='calendario' && state.calendarSelectedDate) ? state.calendarSelectedDate : todayISO();
}

function manutenzioneFormModal(payload){
  const m = payload?.id ? state.cache.manutenzioni.find(x=>x.id===payload.id) : null;
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.wrench}</div><h2>${m?'Modifica manutenzione':'Nuova manutenzione'}</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <form id="entryForm">
      <div class="field"><label>Data</label><input name="data" type="date" value="${m?.data||presetDataDefault()}" required data-action="toggleSyncKmField"></div>
      <div class="field"><label>Km</label><input name="km" type="number" value="${m?.km??currentVeicolo()?.kmAttuali??0}" required></div>
      <div class="field" id="syncKmField" style="margin-top:10px;${(m?.data||presetDataDefault())===todayISO()?'':'display:none;'}">
        <label style="display:flex;align-items:center;gap:8px;margin-top:0;cursor:pointer;">
          <input type="checkbox" name="syncKm" checked style="width:auto;">
          <span style="font-size:13px;color:var(--text);">Aggiorna anche i km attuali del veicolo</span>
        </label>
      </div>
      <div class="field"><label>Categoria</label>
        <select name="categoria" data-action="toggleCategoriaCustom">
          ${['olio','catena','pastiglie','gomme','tagliando','altro'].map(c=>`<option value="${c}" ${m?.categoria===c?'selected':''}>${c==='altro'?'Altro...':categoriaLabel(c)}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="categoriaCustomField" style="${m?.categoria==='altro'?'':'display:none;'}">
        <label>Titolo</label>
        <input type="text" name="categoriaCustom" value="${escapeHTML(m?.categoriaCustom||'')}" placeholder="es. Sostituzione specchietto">
      </div>
      <div class="field"><label>Descrizione</label><textarea name="descrizione" rows="2">${escapeHTML(m?.descrizione||'')}</textarea></div>
      <div class="field"><label>Costo (€)</label><input name="costo" type="number" step="0.01" value="${m?.costo??''}"></div>
      <div class="field"><label>Prossima scadenza — km</label><input name="prossimaScadenzaKm" type="number" value="${m?.prossimaScadenzaKm??''}"></div>
      <div class="field"><label>Foto e documenti</label>
        <label class="btn-soft" style="cursor:pointer;">${ICONS.camera} Aggiungi foto<input type="file" accept="image/*" multiple style="display:none;" data-action="addAttachments"></label>
        <div class="attach-row" id="attachPreview">${attachThumbsHTML()}</div>
      </div>
      <div class="actions-footer">
        ${m?`<button type="button" class="btn btn-danger" data-action="deleteEntry" data-type="manutenzioni" data-id="${m.id}" aria-label="Elimina">${ICONS.trash}</button>`:''}
        <button type="submit" class="btn btn-primary btn-block" data-action="saveManutenzione" data-id="${m?.id||''}">Salva</button>
      </div>
    </form>
  `);
}

function scadenzaFormModal(payload){
  const s = payload?.id ? state.cache.scadenze.find(x=>x.id===payload.id) : null;
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--warn-dim);color:var(--warn);">${ICONS.calendar}</div><h2>${s?'Modifica scadenza':'Nuova scadenza'}</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    ${s?.stato==='completata' ? `<div class="badge badge-ok" style="margin-bottom:14px;display:inline-block;">✓ Completata</div>` : ''}
    ${state.settings.geminiApiKey ? `<label class="btn-soft" style="cursor:pointer;margin-bottom:12px;${state.busy?'opacity:.6;pointer-events:none;':''}">${state.busy ? `<div class="spinner"></div> ${escapeHTML(state.busyStatus || 'Lettura in corso...')}` : `${ICONS.camera} Scansiona documento (AI)`}<input type="file" accept="image/*" capture="environment" style="display:none;" data-action="scansionaScadenza"></label>` : ''}
    <form id="entryForm">
      <div class="field"><label>Tipo</label>
        <select name="tipo">
          ${['bollo','assicurazione','revisione','tagliando','altro'].map(t=>`<option value="${t}" ${s?.tipo===t?'selected':''}>${tipoScadenzaLabel(t)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Data</label><input name="data" type="date" value="${s?.data||presetDataDefault()}" required></div>
      <div class="field"><label>Ricorrenza</label>
        <select name="ricorrenza">
          <option value="nessuna" ${s?.ricorrenza==='nessuna'?'selected':''}>Nessuna</option>
          <option value="annuale" ${s?.ricorrenza==='annuale'?'selected':''}>Annuale</option>
          <option value="biennale" ${s?.ricorrenza==='biennale'?'selected':''}>Biennale</option>
        </select>
      </div>
      <div class="field"><label>Costo (€)</label><input name="costo" type="number" step="0.01" value="${s?.costo??''}" placeholder="Facoltativo"></div>
      ${s ? `<div id="calStato">${calStatoHTML(s)}</div><a data-action="calendarioAggiunto" data-id="${s.id}" href="${googleCalendarLink({title:`${tipoScadenzaLabel(s.tipo)} - ${currentVeicolo()?.marca||''} ${currentVeicolo()?.modello||''}`.trim(), dateISO:s.data, details:'Promemoria da MyGarage', recurRule: s.ricorrenza==='annuale' ? 'RRULE:FREQ=YEARLY;INTERVAL=1' : s.ricorrenza==='biennale' ? 'RRULE:FREQ=YEARLY;INTERVAL=2' : null})}" target="_blank" rel="noopener" class="btn-soft" style="margin-top:${s.calendarAggiunto?'8':'14'}px;">${ICONS.calendar} ${s.calendarAggiunto?'Aggiungi di nuovo':'Aggiungi'} a Google Calendar${s.ricorrenza && s.ricorrenza!=='nessuna' ? ' (ricorrente)' : ''}</a>` : ''}
      ${s && s.stato!=='completata' ? `<button type="button" class="btn-soft" style="margin-top:14px;background:var(--ok-dim);color:var(--ok);" data-action="completaScadenza" data-id="${s.id}">✓ Segna come completata${s.ricorrenza && s.ricorrenza!=='nessuna' ? ' e rinnova' : ''}</button>` : ''}
      <div class="actions-footer">
        ${s?`<button type="button" class="btn btn-danger" data-action="deleteEntry" data-type="scadenze" data-id="${s.id}" aria-label="Elimina">${ICONS.trash}</button>`:''}
        <button type="submit" class="btn btn-primary btn-block" data-action="saveScadenza" data-id="${s?.id||''}">Salva</button>
      </div>
    </form>
  `);
}

function problemaFormModal(payload){
  const p = payload?.id ? state.cache.problemi.find(x=>x.id===payload.id) : null;
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--danger-dim);color:var(--danger);">${ICONS.alert}</div><h2>${p?'Modifica problema':'Nuovo problema'}</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <form id="entryForm">
      <div class="field"><label>Data</label><input name="data" type="date" value="${p?.data||presetDataDefault()}" required></div>
      <div class="field"><label>Sintomi</label><textarea name="sintomi" rows="2" required>${escapeHTML(p?.sintomi||'')}</textarea></div>
      <div class="field"><label>Causa (se nota)</label><textarea name="causa" rows="2">${escapeHTML(p?.causa||'')}</textarea></div>
      <div class="field"><label>Soluzione</label><textarea name="soluzione" rows="2">${escapeHTML(p?.soluzione||'')}</textarea></div>
      <div class="field"><label>Stato</label>
        <select name="stato">
          <option value="aperto" ${p?.stato==='aperto'?'selected':''}>Aperto</option>
          <option value="risolto" ${p?.stato==='risolto'?'selected':''}>Risolto</option>
        </select>
      </div>
      <div class="actions-footer">
        ${p?`<button type="button" class="btn btn-danger" data-action="deleteEntry" data-type="problemi" data-id="${p.id}" aria-label="Elimina">${ICONS.trash}</button>`:''}
        <button type="submit" class="btn btn-primary btn-block" data-action="saveProblema" data-id="${p?.id||''}">Salva</button>
      </div>
    </form>
  `);
}

function lastPrezzoLitro(){
  const arr = state.cache.rifornimenti.filter(x=>x.litri>0 && x.costo>=0)
    .sort((a,b)=> new Date(b.data)-new Date(a.data) || b.km-a.km);
  return arr.length ? arr[0].costo/arr[0].litri : null;
}
function rifornimentoFormModal(payload){
  const r = payload?.id ? state.cache.rifornimenti.find(x=>x.id===payload.id) : null;
  const prezzo0 = r ? (r.litri>0 ? r.costo/r.litri : null) : lastPrezzoLitro();
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--ok-dim);color:var(--ok);">${ICONS.gas}</div><h2>${r?'Modifica rifornimento':'Nuovo rifornimento'}</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    <form id="entryForm">
      <div class="field"><label>Data</label><input name="data" type="date" value="${r?.data||presetDataDefault()}" required data-action="toggleSyncKmField"></div>
      <div class="field"><label>Km</label><input name="km" type="number" value="${r?.km??currentVeicolo()?.kmAttuali??0}" required></div>
      <div class="field" id="syncKmField" style="margin-top:10px;${(r?.data||presetDataDefault())===todayISO()?'':'display:none;'}">
        <label style="display:flex;align-items:center;gap:8px;margin-top:0;cursor:pointer;">
          <input type="checkbox" name="syncKm" checked style="width:auto;">
          <span style="font-size:13px;color:var(--text);">Aggiorna anche i km attuali del veicolo</span>
        </label>
      </div>
      <div class="field"><label>Litri</label><input name="litri" type="number" step="0.01" value="${r?.litri??''}" required data-rif="litri"></div>
      <div class="field"><label>Prezzo al litro (€/L)</label><input name="prezzoL" type="number" step="0.001" min="0" value="${prezzo0 ? prezzo0.toFixed(3) : ''}" data-rif="prezzo">${!r && prezzo0 ? `<div class="muted" style="font-size:12px;margin-top:6px;">Precompilato con l'ultimo rifornimento: il costo si calcola da solo.</div>` : ''}</div>
      <div class="field"><label>Costo (€)</label><input name="costo" type="number" step="0.01" value="${r?.costo??''}" required data-rif="costo" data-manual="${r?'1':''}"></div>
      <div class="actions-footer">
        ${r?`<button type="button" class="btn btn-danger" data-action="deleteEntry" data-type="rifornimenti" data-id="${r.id}" aria-label="Elimina">${ICONS.trash}</button>`:''}
        <button type="submit" class="btn btn-primary btn-block" data-action="saveRifornimento" data-id="${r?.id||''}">Salva</button>
      </div>
    </form>
  `);
}

function kmUpdateModal(veicoloId){
  const v = state.veicoli.find(x=>x.id===veicoloId);
  return modalWrapper(`
    <div class="modal-header"><div class="sec-head" style="margin:0;"><div class="sec-ico" style="background:var(--accent-dim);color:var(--accent);">${ICONS.dashboard}</div><h2>Aggiorna km</h2></div><button class="icon-btn" data-action="closeModal" aria-label="Chiudi">${ICONS.close}</button></div>
    ${state.settings.geminiApiKey ? `<label class="btn-soft" style="cursor:pointer;margin-bottom:14px;${state.busy?'opacity:.6;pointer-events:none;':''}">${state.busy ? `<div class="spinner"></div> ${escapeHTML(state.busyStatus || 'Lettura in corso...')}` : `${ICONS.camera} Leggi da foto contachilometri (AI)`}<input type="file" accept="image/*" capture="environment" style="display:none;" data-action="scansionaKm" data-id="${v.id}"></label>` : ''}
    <form id="kmForm">
      <div class="field"><label>Km attuali</label><input name="km" id="kmInput" type="number" value="${v.kmAttuali}" required></div>
      <div class="actions-footer">
        <button type="submit" class="btn btn-primary btn-block" data-action="saveKm" data-id="${v.id}">Conferma</button>
      </div>
    </form>
  `);
}

/* ---------------- AI (Gemini API — chiave personale dell'utente) ---------------- */
const GEMINI_RETRY_DELAYS = [1500, 3000, 6000, 10000]; // backoff crescente sul modello principale

function setBusyStatus(msg){ state.busyStatus = msg; render(); }

async function callGeminiOnce(model, body, key){
  const res = await fetch(geminiURL(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if(!res.ok){
    const err = new Error(data?.error?.message || ("Errore API: " + res.status));
    err.overload = res.status===503 || res.status===429;
    throw err;
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p=>p.text||'').join('\n');
}

async function callGemini({ system, contents, maxOutputTokens=1024 }){
  const key = state.settings.geminiApiKey;
  if(!key) throw new Error("Nessuna chiave Gemini configurata. Vai in Impostazioni per aggiungerla.");
  const body = { contents, generationConfig: { maxOutputTokens } };
  if(system) body.systemInstruction = { parts: [{ text: system }] };

  // Tentativi sul modello principale, con attese crescenti
  for(let i=0; i<=GEMINI_RETRY_DELAYS.length; i++){
    try{
      if(i>0) setBusyStatus(`Il modello è sovraccarico, nuovo tentativo (${i+1}/${GEMINI_RETRY_DELAYS.length+1})...`);
      const text = await callGeminiOnce(GEMINI_MODEL, body, key);
      state.busyStatus = null;
      return text;
    } catch(e){
      if(!e.overload){ state.busyStatus = null; throw e; }
      if(i < GEMINI_RETRY_DELAYS.length) await new Promise(r=>setTimeout(r, GEMINI_RETRY_DELAYS[i]));
    }
  }

  // Modello principale esausto: prova un modello di riserva
  setBusyStatus("Provo un modello alternativo...");
  try{
    const text = await callGeminiOnce(GEMINI_FALLBACK_MODEL, body, key);
    state.busyStatus = null;
    return text;
  } catch(e2){
    if(!e2.overload){ state.busyStatus = null; throw e2; }
    setBusyStatus("Anche il modello alternativo è sovraccarico, ultimo tentativo...");
    await new Promise(r=>setTimeout(r, 2500));
    try{
      const text = await callGeminiOnce(GEMINI_FALLBACK_MODEL, body, key);
      state.busyStatus = null;
      return text;
    } catch(e3){
      state.busyStatus = null;
      throw new Error(`${e3.message} (Google, server sovraccarichi — riprova tra qualche minuto)`);
    }
  }
}
function extractJSON(text){
  const cleaned = text.replace(/```json|```/g,'').trim();
  try{
    return JSON.parse(cleaned);
  } catch(e){
    const start = cleaned.search(/[\[{]/);
    const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    if(start !== -1 && end > start){
      try{
        return JSON.parse(cleaned.slice(start, end+1));
      } catch(e2){ /* cade nel messaggio con estratto sotto */ }
    }
    const snippet = cleaned.slice(0, 220).trim();
    throw new Error(`Risposta AI non nel formato atteso: "${snippet}${cleaned.length>220?'…':''}"`);
  }
}

async function actionAnalizzaManuale(){
  const v = currentVeicolo();
  const manuale = state.cache.manuale;
  if(!v || !manuale) return;
  state.busy = true; state.busyStatus = null; state.manualeError = null; render();
  try{
    const base64 = await blobToBase64(manuale.file);
    const text = await callGemini({
      system: "Sei un assistente meccanico. Ricevi il manuale PDF di un veicolo. Rispondi SOLO con un array JSON valido (nessun testo extra, nessun markdown, nessuna spiegazione prima o dopo) di proposte di manutenzione periodica, in italiano, formato: [{\"descrizione\":\"...\" (max 6 parole),\"intervalloKm\":numero o null,\"intervalloMesi\":numero o null}]. Massimo 8 proposte, le piu' rilevanti.",
      contents: [{ role:"user", parts:[
        { inlineData:{ mimeType:"application/pdf", data: base64 } },
        { text:`Veicolo: ${v.marca} ${v.modello} ${v.anno}. Estrai gli interventi di manutenzione periodica raccomandati.` }
      ]}],
      maxOutputTokens: 2048
    });
    const proposte = extractJSON(text).map(p=>({...p, accettata:true}));
    state.proposte = proposte;
  } catch(e){
    state.manualeError = e.message || "Analisi non riuscita. Riprova.";
  } finally {
    state.busy = false; state.busyStatus = null; render();
  }
}

async function actionSalvaProposte(){
  const v = currentVeicolo();
  const accettate = (state.proposte||[]).filter(p=>p.accettata);
  for(const p of accettate){
    await dbPut('scadenze', {
      id: uid(), veicoloId: v.id, tipo:'tagliando', data: todayISO(),
      ricorrenza: p.intervalloMesi ? 'custom' : 'nessuna', ricorrenzaMesi: p.intervalloMesi || null,
      origine:'ai-vision', stato:'attiva', intervalloKmSuggerito: p.intervalloKm || null
    });
  }
  state.proposte = null;
  await loadVeicoloData(v.id);
  showToast(`${accettate.length} scadenze salvate`);
  render();
}

function chatContents(){
  // unisce messaggi consecutivi dello stesso ruolo (dopo un errore l'utente può scrivere di nuovo)
  const out = [];
  for(const m of state.chatHistory){
    const role = m.role==='user' ? 'user' : 'model';
    if(out.length && out[out.length-1].role===role) out[out.length-1].parts[0].text += '\n' + m.content;
    else out.push({ role, parts:[{ text:m.content }] });
  }
  return out;
}

async function runChat(){
  const v = currentVeicolo();
  state.chatError = null; state.busy = true; state.busyStatus = null; render();
  try{
    const problemiSummary = state.cache.problemi.map(p=>`- [${p.stato}] ${p.sintomi}${p.soluzione?' → risolto con: '+p.soluzione:''}`).join('\n') || 'Nessuno';
    const system = `Sei un meccanico esperto e assistente per motociclisti/automobilisti. Veicolo: ${v.marca} ${v.modello} ${v.anno} (${v.tipo}), km attuali ${v.kmAttuali}. Storico problemi:\n${problemiSummary}\nRispondi in italiano, in modo conciso e pratico.`;
    const reply = await callGemini({ system, contents: chatContents() });
    state.chatHistory.push({role:'model', content:reply});
  } catch(e){
    state.chatError = e.message || 'chiamata non riuscita';
  } finally {
    state.busy = false; state.busyStatus = null; render();
    setTimeout(()=>{ const el=document.querySelector('.chat-scroll'); if(el) el.scrollTop = el.scrollHeight; }, 50);
  }
}

async function actionSendChat(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;
  state.chatHistory.push({role:'user', content:text});
  input.value = '';
  await runChat();
}

async function actionScansionaKm(file, veicoloId){
  state.busy = true; state.busyStatus = null; render();
  try{
    const base64 = await blobToBase64(file);
    const text = await callGemini({
      system: "Leggi il valore numerico del contachilometri nell'immagine. Rispondi SOLO con il numero intero, nient'altro.",
      contents: [{ role:"user", parts:[
        { inlineData:{ mimeType: file.type, data: base64 } },
        { text:"Qual e' il valore sul contachilometri?" }
      ]}]
    });
    const km = parseInt(text.replace(/\D/g,''));
    if(!isNaN(km)){
      const input = document.getElementById('kmInput');
      if(input) input.value = km;
      showToast("Km letti: " + km);
    } else {
      showToast("Non sono riuscito a leggere il valore");
    }
  } catch(e){
    showActionToast("Errore: " + (e.message || "lettura foto non riuscita"), "Riprova", ()=>actionScansionaKm(file, veicoloId));
  } finally {
    state.busy = false; state.busyStatus = null; render();
  }
}

async function actionScansionaScadenza(file){
  state.busy = true; state.busyStatus = null; render();
  try{
    const base64 = await blobToBase64(file);
    const text = await callGemini({
      system: "Estrai da questo documento (bollo, assicurazione, revisione...) tipo e data di scadenza. Rispondi SOLO con JSON: {\"tipo\":\"bollo|assicurazione|revisione|tagliando|altro\",\"data\":\"YYYY-MM-DD\"}",
      contents: [{ role:"user", parts:[
        { inlineData:{ mimeType: file.type, data: base64 } },
        { text:"Estrai tipo e data di scadenza." }
      ]}]
    });
    const parsed = extractJSON(text);
    const form = document.getElementById('entryForm');
    if(form){
      form.tipo.value = parsed.tipo;
      form.data.value = parsed.data;
    }
    showToast("Dati estratti dal documento");
  } catch(e){
    showActionToast("Errore: " + (e.message || "lettura documento non riuscita"), "Riprova", ()=>actionScansionaScadenza(file));
  } finally {
    state.busy = false; state.busyStatus = null; render();
  }
}

/* ---------------- REPORT PDF ---------------- */
function fmtEuroPDF(n){ return n==null ? "-" : n.toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}) + " EUR"; }

async function esportaReportPDF(veicoloId){
  const v = state.veicoli.find(x=>x.id===veicoloId);
  if(!v) return;
  state.busy = true; render();
  try{
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const MARGIN = 50, PAGE_W = 595, PAGE_H = 842;
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    function newPage(){ page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
    function ensure(space){ if(y - space < MARGIN) newPage(); }
    function flat(s){ return String(s||'').replace(/[\r\n]+/g, ' ').replace(/\s+/g,' ').trim(); }
    // Vero a capo: spezza il testo in righe che stanno nella larghezza data,
    // misurando la larghezza reale col font scelto (nessun taglio di contenuto).
    function wrap(str, font, size, maxWidth){
      const words = flat(str).split(' ').filter(Boolean);
      if(!words.length) return [''];
      const lines = []; let cur = '';
      for(const w of words){
        const test = cur ? cur + ' ' + w : w;
        if(font.widthOfTextAtSize(test, size) > maxWidth && cur){ lines.push(cur); cur = w; }
        else cur = test;
      }
      if(cur) lines.push(cur);
      return lines;
    }
    function text(t, {x=MARGIN, y:yy=y, size=10, font=fontRegular, color=rgb(0.09,0.09,0.1)}={}){
      page.drawText(flat(t), {x, y:yy, size, font, color});
    }
    function lineBreak(gap=16){ y -= gap; }
    function hr(){ page.drawLine({start:{x:MARGIN,y}, end:{x:PAGE_W-MARGIN,y}, thickness:0.5, color:rgb(0.8,0.8,0.8)}); }

    text("MyGarage", {size:11, font:fontBold, color:rgb(0.18,0.5,1)});
    lineBreak(22);
    text(`Report manutenzioni - ${v.marca} ${v.modello}`, {size:18, font:fontBold});
    lineBreak(26);
    text(`Anno ${v.anno}${v.targa?' - Targa '+v.targa:''} - Km attuali: ${Math.round(v.kmAttuali).toLocaleString('it-IT')}`, {size:10, color:rgb(0.4,0.4,0.42)});
    lineBreak(14);
    text(`Generato il ${fmtDate(todayISO())}`, {size:9, color:rgb(0.55,0.55,0.57)});
    lineBreak(20);
    hr();
    lineBreak(26);

    const manutenzioni = [...state.cache.manutenzioni].sort((a,b)=> new Date(b.data)-new Date(a.data));
    text("Manutenzioni", {size:13, font:fontBold});
    lineBreak(20);
    const cols = [ {x:MARGIN,label:'Data'}, {x:MARGIN+65,label:'Km'}, {x:MARGIN+125,label:'Categoria',w:80}, {x:MARGIN+210,label:'Descrizione',w:(PAGE_W-MARGIN-60)-(MARGIN+210)-10}, {x:PAGE_W-MARGIN-60,label:'Costo'} ];
    function tableHeader(){
      ensure(24);
      cols.forEach(c => text(c.label, {x:c.x, size:9, font:fontBold, color:rgb(0.4,0.4,0.42)}));
      lineBreak(6); hr(); lineBreak(16);
    }
    tableHeader();
    let costoTotaleManut = 0;
    if(manutenzioni.length===0){
      text("Nessuna manutenzione registrata.", {size:10, color:rgb(0.5,0.5,0.52)});
      lineBreak(16);
    }
    let rowsSinceHeader = 0;
    for(const m of manutenzioni){
      const catLines = wrap(categoriaLabel(m.categoria, m.categoriaCustom), fontRegular, 9, cols[2].w);
      const descLines = wrap(m.descrizione||'-', fontRegular, 9, cols[3].w);
      const nLines = Math.max(catLines.length, descLines.length, 1);
      const rowHeight = nLines*12 + 6;
      if(y - rowHeight < MARGIN){ newPage(); tableHeader(); rowsSinceHeader = 0; }
      costoTotaleManut += (m.costo||0);
      const topY = y;
      text(fmtDate(m.data), {x:cols[0].x, y:topY, size:9});
      text(fmtKm(m.km).replace(' km',''), {x:cols[1].x, y:topY, size:9});
      catLines.forEach((line,i)=> text(line, {x:cols[2].x, y:topY-i*12, size:9}));
      descLines.forEach((line,i)=> text(line, {x:cols[3].x, y:topY-i*12, size:9}));
      text(m.costo?fmtEuroPDF(m.costo):'-', {x:cols[4].x, y:topY, size:9});
      y = topY - rowHeight;
      rowsSinceHeader++;
    }
    lineBreak(6); hr(); lineBreak(20);
    text(`Spesa totale manutenzioni: ${fmtEuroPDF(costoTotaleManut)}`, {size:11, font:fontBold});
    lineBreak(30);

    const problemi = [...state.cache.problemi].sort((a,b)=> new Date(b.data)-new Date(a.data));
    ensure(40);
    text("Storico problemi", {size:13, font:fontBold});
    lineBreak(20);
    const fullWidth = PAGE_W - 2*MARGIN;
    if(problemi.length===0){
      text("Nessun problema registrato.", {size:10, color:rgb(0.5,0.5,0.52)});
    } else {
      for(const p of problemi){
        ensure(14);
        text(`${fmtDate(p.data)} - ${p.stato==='risolto'?'Risolto':'Aperto'}`, {size:9, font:fontBold});
        lineBreak(13);
        for(const line of wrap(p.sintomi, fontRegular, 9, fullWidth)){
          ensure(12); text(line, {size:9}); lineBreak(12);
        }
        if(p.soluzione){
          ensure(12);
          text("Soluzione:", {size:9, font:fontBold, color:rgb(0.4,0.4,0.42)});
          lineBreak(12);
          for(const line of wrap(p.soluzione, fontRegular, 9, fullWidth-10)){
            ensure(12); text(line, {x:MARGIN+10, size:9, color:rgb(0.4,0.4,0.42)}); lineBreak(12);
          }
        }
        lineBreak(8);
      }
    }

    const pdfBytes = await doc.save();
    const blob = new Blob([pdfBytes], {type:'application/pdf'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `MyGarage-${v.marca}-${v.modello}-${todayISO()}.pdf`.replace(/\s+/g,'_');
    a.click();
    URL.revokeObjectURL(url);
    showSuccessToast("Report PDF generato");
  } catch(e){
    showToast("Errore generazione PDF: " + (e.message||"riprova"));
  } finally {
    state.busy = false; render();
  }
}

async function esportaRifornimentiPDF(veicoloId){
  const v = state.veicoli.find(x=>x.id===veicoloId);
  if(!v) return;
  const rifs = (await dbGetAll('rifornimenti')).filter(r=>r.veicoloId===veicoloId);
  if(!rifs.length){ showToast("Nessun rifornimento da esportare"); return; }
  state.busy = true; render();
  try{
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const MARGIN = 50, PAGE_W = 595, PAGE_H = 842, ROW_H = 18;
    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    const flat = s => String(s==null?'':s).replace(/\s+/g,' ').trim();
    const draw = (t, x, yy, {size=10, font=fontRegular, color=rgb(0.09,0.09,0.1)}={}) => page.drawText(flat(t), {x, y:yy, size, font, color});
    const drawRight = (t, xRight, yy, opts={}) => {
      const font = opts.font||fontRegular, size = opts.size||10;
      draw(t, xRight - font.widthOfTextAtSize(flat(t), size), yy, opts);
    };
    const fmtN = (n,d=2) => n.toLocaleString('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d});

    // statistiche (stessa formula usata in app: i litri del primo rifornimento sono esclusi)
    const asc = [...rifs].sort((a,b)=> a.km-b.km);
    const kmTot = asc[asc.length-1].km - asc[0].km;
    const litriConsumati = asc.slice(1).reduce((t,r)=>t+(r.litri||0),0);
    const consumo = kmTot>0 && litriConsumati>0 ? kmTot/litriConsumati : null;
    const totLitri = rifs.reduce((t,r)=>t+(r.litri||0),0);
    const totCosto = rifs.reduce((t,r)=>t+(r.costo||0),0);
    const prezzoMedio = totLitri>0 ? totCosto/totLitri : null;
    const kmPrev = new Map(); asc.forEach((r,i)=> kmPrev.set(r.id, i>0 ? r.km - asc[i-1].km : null));

    draw("MyGarage", MARGIN, y, {size:11, font:fontBold, color:rgb(0.18,0.5,1)}); y -= 22;
    draw(`Rifornimenti - ${v.marca} ${v.modello}`, MARGIN, y, {size:18, font:fontBold}); y -= 22;
    draw(`${v.targa?'Targa '+v.targa+' - ':''}Generato il ${fmtDate(todayISO())}`, MARGIN, y, {size:9, color:rgb(0.55,0.55,0.57)}); y -= 24;
    const summary = [
      ['Rifornimenti', String(rifs.length)],
      ['Litri totali', fmtN(totLitri)],
      ['Spesa totale', fmtEuroPDF(totCosto)],
      ['Prezzo medio', prezzoMedio ? fmtN(prezzoMedio,3)+' EUR/L' : '-'],
      ['Consumo medio', consumo ? fmtN(consumo,1)+' km/L' : '-'],
    ];
    const boxW = (PAGE_W - 2*MARGIN) / summary.length;
    summary.forEach(([lbl,val],i)=>{
      draw(lbl, MARGIN + i*boxW, y, {size:8.5, color:rgb(0.45,0.45,0.48)});
      draw(val, MARGIN + i*boxW, y-14, {size:11, font:fontBold});
    });
    y -= 36;

    // colonne: allineate a destra sul bordo indicato (tranne la data)
    const R = PAGE_W - MARGIN;
    const cols = [
      {label:'Data', x:MARGIN, right:false},
      {label:'Km', x:MARGIN+135},
      {label:'Litri', x:MARGIN+205},
      {label:'Costo', x:MARGIN+290},
      {label:'EUR/L', x:MARGIN+365},
      {label:'Km percorsi', x:R},
    ];
    function header(){
      cols.forEach(c => c.right===false ? draw(c.label, c.x, y, {size:9, font:fontBold, color:rgb(0.4,0.4,0.42)}) : drawRight(c.label, c.x, y, {size:9, font:fontBold, color:rgb(0.4,0.4,0.42)}));
      y -= 6;
      page.drawLine({start:{x:MARGIN,y}, end:{x:R,y}, thickness:0.5, color:rgb(0.8,0.8,0.8)});
      y -= ROW_H;
    }
    header();
    const rows = [...rifs].sort((a,b)=> new Date(b.data)-new Date(a.data) || b.km-a.km);
    rows.forEach((r,i)=>{
      if(y - ROW_H < MARGIN){ page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; header(); }
      if(i%2===1) page.drawRectangle({x:MARGIN-4, y:y-5, width:R-MARGIN+8, height:ROW_H, color:rgb(0.96,0.96,0.97)});
      const dk = kmPrev.get(r.id);
      draw(fmtDate(r.data), cols[0].x, y, {size:9.5});
      drawRight(fmtN(Math.round(r.km),0), cols[1].x, y, {size:9.5});
      drawRight(fmtN(r.litri||0), cols[2].x, y, {size:9.5});
      drawRight(fmtEuroPDF(r.costo||0), cols[3].x, y, {size:9.5});
      drawRight(r.litri>0 ? fmtN(r.costo/r.litri,3) : '-', cols[4].x, y, {size:9.5});
      drawRight(dk==null ? '-' : fmtN(Math.round(dk),0), cols[5].x, y, {size:9.5});
      y -= ROW_H;
    });

    const pdfBytes = await doc.save();
    const blob = new Blob([pdfBytes], {type:'application/pdf'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `MyGarage-Rifornimenti-${v.marca}-${v.modello}-${todayISO()}.pdf`.replace(/\s+/g,'_');
    a.click();
    URL.revokeObjectURL(url);
    showSuccessToast("PDF rifornimenti generato");
  } catch(e){
    showToast("Errore generazione PDF: " + (e.message||"riprova"));
  } finally {
    state.busy = false; render();
  }
}

/* ---------------- BACKUP ---------------- */
async function clearAllData(){
  const db = await getDB();
  const names = ['veicoli','manutenzioni','scadenze','problemi','rifornimenti','manuali','allegati'];
  await Promise.all(names.map(n => new Promise((res,rej)=>{
    const s = db.transaction(n,'readwrite').objectStore(n);
    const r = s.clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);
  })));
}

async function serializeBlobs(arr, field){
  return Promise.all(arr.map(async x => {
    if(x[field]) return {...x, [field]: { __blob:true, mime:x[field].type, data: await blobToBase64(x[field]) }};
    return x;
  }));
}

async function esportaJSON(){
  const includiAllegati = state.settings.includiAllegatiBackup;
  const [veicoliAll, manutenzioniAll, scadenzeAll, problemiAll, rifornimentiAll] = await Promise.all(
    ['veicoli','manutenzioni','scadenze','problemi','rifornimenti'].map(dbGetAll)
  );
  const veicoli = veicoliAll.filter(v => !state.backupExcluded.has(v.id));
  if(!veicoli.length){ showToast("Seleziona almeno un veicolo da includere"); return; }
  const includedIds = new Set(veicoli.map(v => v.id));
  const manutenzioni = manutenzioniAll.filter(m => includedIds.has(m.veicoloId));
  const scadenze = scadenzeAll.filter(s => includedIds.has(s.veicoloId));
  const problemi = problemiAll.filter(p => includedIds.has(p.veicoloId));
  const rifornimenti = rifornimentiAll.filter(r => includedIds.has(r.veicoloId));
  let manualiSer = [], allegatiSer = [];
  if(includiAllegati){
    const [manualiAll, allegatiAll] = await Promise.all([dbGetAll('manuali'), dbGetAll('allegati')]);
    const manuali = manualiAll.filter(m => includedIds.has(m.veicoloId));
    const allegatiIdsNeeded = new Set(manutenzioni.flatMap(m => m.allegati||[]));
    const allegati = allegatiAll.filter(a => allegatiIdsNeeded.has(a.id));
    manualiSer = await serializeBlobs(manuali, 'file');
    allegatiSer = await serializeBlobs(allegati, 'blob');
  }
  const dump = { version:1, exportedAt: new Date().toISOString(), allegatiInclusi: includiAllegati, veicoli, manutenzioni, scadenze, problemi, rifornimenti, manuali: manualiSer, allegati: allegatiSer };
  const blob = new Blob([JSON.stringify(dump)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `motolog-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  await saveSetting('ultimoBackup', new Date().toISOString());
  showToast("Backup esportato");
}

async function importaJSON(file){
  try{
    const text = await file.text();
    const dump = JSON.parse(text);
    function deserializeBlobs(arr, field){
      return arr.map(x => {
        if(x[field] && x[field].__blob) return {...x, [field]: base64ToBlob(x[field].data, x[field].mime)};
        return x;
      });
    }
    const manuali = deserializeBlobs(dump.manuali||[], 'file');
    const allegati = deserializeBlobs(dump.allegati||[], 'blob');
    for(const v of dump.veicoli||[]) await dbPut('veicoli', v);
    for(const m of dump.manutenzioni||[]) await dbPut('manutenzioni', m);
    for(const s of dump.scadenze||[]) await dbPut('scadenze', s);
    for(const p of dump.problemi||[]) await dbPut('problemi', p);
    for(const r of dump.rifornimenti||[]) await dbPut('rifornimenti', r);
    for(const m of manuali) await dbPut('manuali', m);
    for(const a of allegati) await dbPut('allegati', a);
    await loadVeicoli();
    await loadVeicoloData(state.selectedVeicoloId);
    showToast("Backup importato");
    render();
  } catch(e){
    showToast("File di backup non valido");
  }
}

/* ---------------- EVENT HANDLING (delegation) ---------------- */
const app = document.getElementById('app');

/* ---------------- SWIPE TRA TAB ---------------- */
const TAB_ORDER = ['dashboard','log','veicoli','ai','impostazioni'];
let touchStartX = 0, touchStartY = 0, touchActive = false;

app.addEventListener('touchstart', (e) => {
  touchActive = false;
  if(state.modal || state.lightbox) return;
  if(state.tab === 'veicoli-detail') return;
  if(e.target.closest('.veh-switcher, .chip-row')) return; // non rubare lo scroll orizzontale locale
  if(e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchActive = true;
}, {passive:true});

app.addEventListener('touchend', (e) => {
  if(!touchActive) return;
  touchActive = false;
  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  if(Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return; // gesto troppo corto o troppo verticale
  if(state.tab === 'calendario'){ shiftCalendarMonth(dx < 0 ? 1 : -1); return; }
  const idx = TAB_ORDER.indexOf(state.tab);
  if(idx === -1) return;
  if(dx < 0 && idx < TAB_ORDER.length - 1){ state.tab = TAB_ORDER[idx + 1]; render(); }
  else if(dx > 0 && idx > 0){ state.tab = TAB_ORDER[idx - 1]; render(); }
}, {passive:true});

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const type = el.dataset.type;

  if(action==='closeModalBg' && e.target === el){ state.modal=null; render(); return; }
  if(action==='closeModal'){
    state.editAttachments.forEach(a=>{ try{ URL.revokeObjectURL(a.url); }catch(err){} });
    state.editAttachments = [];
    state.modal=null; state.proposte=null; render(); return;
  }
  if(action==='viewAttachment'){
    const key = el.dataset.id;
    const a = state.editAttachments.find(x => (x.id||x.tempId) === key);
    if(a && a.tipo==='foto'){ state.lightbox = a; render(); }
    return;
  }
  if(action==='removeAttachment'){
    const key = el.dataset.id;
    state.editAttachments = state.editAttachments.filter(a => (a.id||a.tempId) !== key);
    const preview = document.getElementById('attachPreview');
    if(preview) preview.innerHTML = attachThumbsHTML();
    return;
  }
  if(action==='closeLightboxBg' && e.target===el){ state.lightbox=null; render(); return; }
  if(action==='closeLightbox'){ state.lightbox=null; render(); return; }
  if(action==='dismissManualeError'){ state.manualeError=null; render(); return; }
  if(action==='setTab'){ state.tab=id; render(); return; }
  if(action==='setLogFilter'){ state.logFilter=id; render(); return; }
  if(action==='openCalendario'){ state.calendarMonth = todayISO().slice(0,7); state.calendarSelectedDate = todayISO(); state.tab='calendario'; render(); return; }
  if(action==='calPrevMonth' || action==='calNextMonth'){
    shiftCalendarMonth(action==='calPrevMonth' ? -1 : 1);
    return;
  }
  if(action==='calSelectDay'){ state.calendarSelectedDate = state.calendarSelectedDate===el.dataset.date ? null : el.dataset.date; render(); return; }
  if(action==='setAiSubtab'){ state.aiSubtab=id; render(); return; }
  if(action==='dismissBanner'){ state.bannerDismissed[id+todayISO()]=true; render(); return; }
  if(action==='toastAction'){ const fn = state.toastAction; state.toast=null; state.toastAction=null; render(); if(fn) await fn(); return; }
  if(action==='dismissBackupBanner'){ state.bannerDismissed['bkp_'+todayISO()]=true; render(); return; }
  if(action==='dismissScadenzaBanner'){ state.bannerDismissed['scad_'+id+'_'+todayISO()]=true; render(); return; }
  if(action==='selectTipo'){
    const hidden = document.getElementById('tipoHiddenInput');
    if(hidden) hidden.value = el.dataset.value;
    const row = el.closest('.sub-tabs');
    if(row) row.querySelectorAll('.sub-tab').forEach(b=>b.classList.remove('active'));
    el.classList.add('active');
    return;
  }

  if(action==='openStatistiche'){ state.stats = { tab: el.dataset.tab || 'spesa', periodo: state.stats?.periodo ?? 12, pick: null }; state.modal={view:'stats'}; render(); return; }
  if(action==='statsTab' && state.stats){ state.stats.tab = id; state.stats.pick = null; statsRefresh(); return; }
  if(action==='statsPeriodo' && state.stats){ state.stats.periodo = Number(el.dataset.value); state.stats.pick = null; statsRefresh(); return; }
  if(action==='statPick' && state.stats){ const i = Number(id); state.stats.pick = state.stats.pick===i ? null : i; statsRefresh(); return; }
  if(action==='openTypeChooser'){ state.modal={view:'typeChooser'}; render(); return; }
  if(action==='openForm'){
    if(type==='manutenzioni') await loadEditAttachments(null);
    state.modal={view:type}; render(); return;
  }
  if(action==='openPneumatici'){ state.modal={view:'pneumatici', payload:{id}}; render(); return; }
  if(action==='openVeicoloForm'){ state.modal={view:'veicoloForm', payload:{id}}; render(); return; }
  if(action==='openVeicoloDetail'){ state.selectedVeicoloId=id; state.tab='veicoli-detail'; await loadVeicoloData(id); render(); return; }
  if(action==='openEdit'){
    if(type==='manutenzioni') await loadEditAttachments(state.cache.manutenzioni.find(x=>x.id===id));
    state.modal={view:type, payload:{id}}; render(); return;
  }
  if(action==='openKmUpdate'){ state.modal={view:'kmUpdate', payload:{id}}; render(); return; }

  if(action==='toggleProposta'){ state.proposte[id].accettata = !state.proposte[id].accettata; render(); return; }
  if(action==='salvaProposte'){ await actionSalvaProposte(); return; }
  if(action==='analizzaManuale'){ await actionAnalizzaManuale(); return; }
  if(action==='sendChat'){ await actionSendChat(); return; }
  if(action==='retryChat'){ await runChat(); return; }

  if(action==='setPreferito'){
    const target = state.veicoli.find(x=>x.id===id);
    const newValue = !target.preferito;
    for(const veic of state.veicoli){
      const shouldBe = newValue && veic.id===id;
      if(!!veic.preferito !== shouldBe){
        veic.preferito = shouldBe;
        await dbPut('veicoli', veic);
      }
    }
    await loadVeicoli();
    showToast(newValue ? "Impostato come veicolo principale" : "Rimosso come veicolo principale");
    render();
    return;
  }
  if(action==='deleteVeicolo'){
    if(confirm("Eliminare questo veicolo e tutti i suoi dati?")){
      await dbDelete('veicoli', id);
      state.selectedVeicoloId = null; state.tab='veicoli';
      await loadVeicoli(); await loadVeicoloData(state.selectedVeicoloId);
      render();
    }
    return;
  }
  if(action==='deleteEntry'){
    const rec = (await dbGetAll(type)).find(x=>x.id===id);
    await dbDelete(type, id);
    await loadVeicoloData(state.selectedVeicoloId);
    state.modal=null; render();
    if(rec) showActionToast("Elemento eliminato", "Annulla", async ()=>{
      await dbPut(type, rec);
      await loadVeicoloData(state.selectedVeicoloId);
      render();
      showSuccessToast("Elemento ripristinato");
    });
    return;
  }
  if(action==='exportReportPDF'){
    await esportaReportPDF(id);
    return;
  }
  if(action==='exportRifornimentiPDF'){
    await esportaRifornimentiPDF(id);
    return;
  }
  if(action==='calendarioKmAggiunto'){
    const v = state.veicoli.find(x=>x.id===id);
    if(!v) return;
    v.calendarKm = { giorni: state.settings.kmReminderDays };
    await dbPut('veicoli', v);
    const box = document.getElementById('calKmStato');
    if(box) box.innerHTML = calKmStatoHTML(v);
    el.lastChild.textContent = ' Aggiungi di nuovo promemoria km ricorrente su Calendar';
    return;
  }
  if(action==='calendarioAggiunto'){
    const s = state.cache.scadenze.find(x=>x.id===id);
    if(!s) return;
    s.calendarAggiunto = { data: s.data, ricorrenza: s.ricorrenza||'nessuna' };
    await dbPut('scadenze', s);
    const box = document.getElementById('calStato');
    if(box) box.innerHTML = calStatoHTML(s);
    el.lastChild.textContent = ' Aggiungi di nuovo a Google Calendar' + (s.ricorrenza && s.ricorrenza!=='nessuna' ? ' (ricorrente)' : '');
    return;
  }
  if(action==='completaScadenza'){
    const s = state.cache.scadenze.find(x=>x.id===id);
    if(!s) return;
    s.stato = 'completata';
    await dbPut('scadenze', s);
    let rinnovata = false;
    if(s.ricorrenza && s.ricorrenza!=='nessuna'){
      const mesi = s.ricorrenza==='annuale' ? 12 : s.ricorrenza==='biennale' ? 24 : (s.ricorrenzaMesi||12);
      await dbPut('scadenze', {
        id: uid(), veicoloId: s.veicoloId, tipo: s.tipo, data: addMonths(s.data, mesi),
        ricorrenza: s.ricorrenza, ricorrenzaMesi: s.ricorrenzaMesi||null,
        origine: 'rinnovo-auto', stato: 'attiva',
        calendarAggiunto: s.calendarAggiunto ? { data: addMonths(s.data, mesi), ricorrenza: s.ricorrenza } : null
      });
      rinnovata = true;
    }
    state.modal = null;
    await loadVeicoloData(state.selectedVeicoloId);
    showSuccessToast(rinnovata ? "Completata e rinnovata" : "Scadenza completata");
    render();
    return;
  }
  if(action==='deleteManuale'){
    const rec = state.cache.manuale && state.cache.manuale.id===id ? state.cache.manuale : null;
    await dbDelete('manuali', id);
    await loadVeicoloData(state.selectedVeicoloId);
    render();
    if(rec) showActionToast("Manuale eliminato", "Annulla", async ()=>{
      await dbPut('manuali', rec);
      await loadVeicoloData(state.selectedVeicoloId);
      render();
      showSuccessToast("Manuale ripristinato");
    });
    return;
  }

  if(action==='setThemeMode'){
    await saveSetting('themeMode', el.dataset.value);
    applyTheme();
    render();
    return;
  }
  if(action==='setThemeAccent'){
    await saveSetting('themeAccent', el.dataset.value);
    applyTheme();
    render();
    return;
  }
  if(action==='rimuoviGeminiKey'){
    if(confirm("Rimuovere la chiave Gemini salvata? Le funzioni AI smetteranno di funzionare finché non ne aggiungi una nuova.")){
      await saveSetting('geminiApiKey', '');
      render();
    }
    return;
  }
  if(action==='toggleIncludiAllegati'){
    await saveSetting('includiAllegatiBackup', !state.settings.includiAllegatiBackup);
    render();
    return;
  }
  if(action==='toggleBackupVeicolo'){
    if(state.backupExcluded.has(id)) state.backupExcluded.delete(id); else state.backupExcluded.add(id);
    render();
    return;
  }
  if(action==='cancellaTuttiDati'){
    if(confirm("Cancellare TUTTI i dati dell'app (veicoli, manutenzioni, scadenze, problemi, rifornimenti, manuali, allegati)? Considera di esportare prima un backup.")){
      if(confirm("Confermi? L'operazione non è reversibile.")){
        await clearAllData();
        state.selectedVeicoloId = null; state.chatHistory=[]; state.chatError=null; state.proposte=null; state.tab='dashboard';
        await loadVeicoli(); await loadVeicoloData(null);
        showToast("Tutti i dati sono stati cancellati");
        render();
      }
    }
    return;
  }
});

app.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  if(action==='toggleCategoriaCustom'){
    const field = document.getElementById('categoriaCustomField');
    if(field) field.style.display = el.value==='altro' ? '' : 'none';
    return;
  }
  if(action==='togglePneuUguali'){
    const post = document.getElementById('pneuPost'), lbl = document.getElementById('pneuAntLbl');
    if(post) post.style.display = el.checked ? 'none' : '';
    if(lbl) lbl.textContent = el.checked ? 'Misura (tutte e 4)' : 'Misura anteriore';
    return;
  }
  if(action==='toggleSyncKmField'){
    const field = document.getElementById('syncKmField');
    if(field) field.style.display = el.value===todayISO() ? '' : 'none';
    return;
  }
  if(action==='setKmReminderDays'){
    const val = Math.max(1, Math.min(60, parseInt(el.value)||10));
    await saveSetting('kmReminderDays', val);
    return;
  }
  if(action==='setScadenzaReminderDays'){
    const val = Math.max(1, Math.min(90, parseInt(el.value)||14));
    await saveSetting('scadenzaReminderDays', val);
    return;
  }
  if(action==='addAttachments'){
    const files = Array.from(el.files || []);
    for(const file of files){
      state.editAttachments.push({
        tempId: uid(), nome: file.name,
        tipo: file.type.startsWith('image') ? 'foto' : 'documento',
        url: URL.createObjectURL(file), file, existing:false
      });
    }
    el.value = '';
    const preview = document.getElementById('attachPreview');
    if(preview) preview.innerHTML = attachThumbsHTML();
    return;
  }
  if(action==='uploadManuale'){
    const file = el.files[0];
    if(!file) return;
    await dbPut('manuali', { id: uid(), veicoloId:id, nome:file.name, file });
    await loadVeicoloData(id);
    showToast("Manuale caricato");
    render();
    return;
  }
  if(action==='scansionaKm'){
    const file = el.files[0];
    if(file) await actionScansionaKm(file, id);
    return;
  }
  if(action==='scansionaScadenza'){
    const file = el.files[0];
    if(file) await actionScansionaScadenza(file);
    return;
  }
});

app.addEventListener('keydown', (e) => {
  if(e.target.id==='chatInput' && e.key==='Enter'){ e.preventDefault(); actionSendChat(); }
});

async function syncKmSeRichiesto(v, entryData, entryKm, syncRichiesto){
  if(!syncRichiesto || entryData !== todayISO()) return;
  if(entryKm < v.kmAttuali){
    showToast(`Km non aggiornati: ${Math.round(entryKm).toLocaleString('it-IT')} è inferiore ai km attuali del veicolo (${Math.round(v.kmAttuali).toLocaleString('it-IT')})`);
    return;
  }
  v.kmAttuali = entryKm;
  v.dataUltimoAggiornamentoKm = todayISO();
  await dbPut('veicoli', v);
  await loadVeicoli();
}

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const v = currentVeicolo();

  if(form.id==='geminiKeyForm'){
    const key = fd.get('geminiApiKey').trim();
    if(key){
      await saveSetting('geminiApiKey', key);
      showToast("Chiave salvata");
      render();
    }
    return;
  }

  if(form.id==='veicoloForm'){
    const btn = form.querySelector('[data-action="saveVeicolo"]');
    const existingId = btn.dataset.id;
    const prev = existingId ? state.veicoli.find(x=>x.id===existingId) : null;
    const obj = {
      ...(prev||{}),
      id: existingId || uid(),
      tipo: fd.get('tipo'), marca: fd.get('marca'), modello: fd.get('modello'),
      anno: parseInt(fd.get('anno')), targa: fd.get('targa'),
      kmAttuali: parseFloat(fd.get('kmAttuali')),
      dataUltimoAggiornamentoKm: todayISO(),
    };
    await dbPut('veicoli', obj);
    state.modal=null;
    await loadVeicoli();
    state.selectedVeicoloId = obj.id;
    await loadVeicoloData(obj.id);
    showSuccessToast("Veicolo salvato");
    render();
    return;
  }

  if(form.id==='pneuForm'){
    const btn = form.querySelector('[data-action="savePneumatici"]');
    const veic = state.veicoli.find(x=>x.id===btn.dataset.id);
    if(!veic) return;
    const t = (k) => (fd.get(k)||'').toString().trim();
    const uguali = veic.tipo==='auto' && fd.get('uguali')!==null;
    const ant = { misura: t('antMisura').toUpperCase(), marcaModello: t('antMarca') };
    const post = uguali ? { ...ant } : { misura: t('postMisura').toUpperCase(), marcaModello: t('postMarca') };
    if(!ant.misura && !post.misura) delete veic.pneumatici;
    else veic.pneumatici = { uguali, anteriore: ant, posteriore: post };
    await dbPut('veicoli', veic);
    state.modal=null;
    await loadVeicoli();
    await loadVeicoloData(veic.id);
    showSuccessToast("Pneumatici salvati");
    render();
    return;
  }

  if(form.id==='kmForm'){
    const btn = form.querySelector('[data-action="saveKm"]');
    const vid = btn.dataset.id;
    const veic = state.veicoli.find(x=>x.id===vid);
    veic.kmAttuali = parseFloat(fd.get('km'));
    veic.dataUltimoAggiornamentoKm = todayISO();
    await dbPut('veicoli', veic);
    state.modal=null;
    await loadVeicoli();
    await loadVeicoloData(state.selectedVeicoloId);
    showSuccessToast("Km aggiornati");
    render();
    return;
  }

  if(form.id==='entryForm'){
    const modalView = state.modal.view;
    const existingId = state.modal.payload?.id;

    if(modalView==='manutenzioni'){
      const allegati = [];
      for(const a of state.editAttachments){
        if(a.existing){
          allegati.push(a.id);
        } else {
          const attId = uid();
          await dbPut('allegati', { id:attId, tipo:a.tipo, blob:a.file, nome:a.nome });
          allegati.push(attId);
        }
      }
      if(existingId){
        const prevAllegati = state.cache.manutenzioni.find(mm=>mm.id===existingId)?.allegati || [];
        const removedIds = prevAllegati.filter(pid => !allegati.includes(pid));
        for(const rid of removedIds) await dbDelete('allegati', rid);
      }
      const obj = {
        id: existingId || uid(), veicoloId: v.id,
        data: fd.get('data'), km: parseFloat(fd.get('km')),
        categoria: fd.get('categoria'),
        categoriaCustom: fd.get('categoria')==='altro' ? (fd.get('categoriaCustom')||'').trim() || 'Altro' : null,
        descrizione: fd.get('descrizione'),
        costo: fd.get('costo') ? parseFloat(fd.get('costo')) : null,
        prossimaScadenzaKm: fd.get('prossimaScadenzaKm') ? parseFloat(fd.get('prossimaScadenzaKm')) : null,
        allegati,
      };
      await dbPut('manutenzioni', obj);
      state.editAttachments.forEach(a=>{ try{ URL.revokeObjectURL(a.url); }catch(err){} });
      state.editAttachments = [];
      await syncKmSeRichiesto(v, obj.data, obj.km, !!fd.get('syncKm'));
      showSuccessToast("Manutenzione salvata");
    } else if(modalView==='scadenze'){
      const existing = existingId ? state.cache.scadenze.find(s=>s.id===existingId) : null;
      const obj = {
        id: existingId || uid(), veicoloId: v.id,
        tipo: fd.get('tipo'), data: fd.get('data'), ricorrenza: fd.get('ricorrenza'),
        ricorrenzaMesi: existing?.ricorrenzaMesi ?? null,
        costo: fd.get('costo') ? parseFloat(fd.get('costo')) : null,
        origine: existing?.origine || 'manuale',
        stato: existing?.stato || 'attiva',
        calendarAggiunto: existing?.calendarAggiunto || null,
      };
      await dbPut('scadenze', obj);
      showSuccessToast("Scadenza salvata");
    } else if(modalView==='problemi'){
      const obj = {
        id: existingId || uid(), veicoloId: v.id,
        data: fd.get('data'), sintomi: fd.get('sintomi'), causa: fd.get('causa'),
        soluzione: fd.get('soluzione'), stato: fd.get('stato'),
      };
      await dbPut('problemi', obj);
      showSuccessToast("Problema salvato");
    } else if(modalView==='rifornimenti'){
      const obj = {
        id: existingId || uid(), veicoloId: v.id,
        data: fd.get('data'), km: parseFloat(fd.get('km')),
        litri: parseFloat(fd.get('litri')), costo: parseFloat(fd.get('costo')),
      };
      await dbPut('rifornimenti', obj);
      await syncKmSeRichiesto(v, obj.data, obj.km, !!fd.get('syncKm'));
      showSuccessToast("Rifornimento salvato");
    }
    state.modal=null;
    await loadVeicoloData(v.id);
    render();
    return;
  }
});

/* ---------------- RENDER PRINCIPALE ---------------- */
function modalContent(){
  if(!state.modal) return '';
  const { view, payload } = state.modal;
  if(view==='typeChooser') return typeChooserModal();
  if(view==='veicoloForm') return veicoloFormModal(payload);
  if(view==='pneumatici') return pneumaticiModal(payload);
  if(view==='manutenzioni') return manutenzioneFormModal(payload);
  if(view==='scadenze') return scadenzaFormModal(payload);
  if(view==='problemi') return problemaFormModal(payload);
  if(view==='rifornimenti') return rifornimentoFormModal(payload);
  if(view==='kmUpdate') return kmUpdateModal(payload.id);
  if(view==='stats') return statisticheModal();
  return '';
}

function headerHTML(){
  if(state.tab==='veicoli-detail'){
    const v = currentVeicolo();
    return `<div class="topbar">
      <button class="icon-btn" data-action="setTab" data-id="veicoli" aria-label="Torna ai veicoli">${ICONS.back}</button>
      <h1>${v?escapeHTML(v.marca)+' '+escapeHTML(v.modello):''}</h1>
      <div style="width:44px;"></div>
    </div>`;
  }
  if(state.tab==='calendario'){
    return `<div class="topbar">
      <button class="icon-btn" data-action="setTab" data-id="dashboard" aria-label="Torna alla dashboard">${ICONS.back}</button>
      <h1>Calendario</h1>
      <div style="width:44px;"></div>
    </div>`;
  }
  const titles = {dashboard:'MyGarage', veicoli:'I tuoi veicoli', log:'Diario', ai:'Assistente AI', impostazioni:'Impostazioni'};
  return `<div class="topbar">
    <h1>${titles[state.tab]||'MyGarage'}</h1>
    ${state.tab==='dashboard' ? `<button class="icon-btn" style="background:var(--accent-dim);border-color:transparent;color:var(--accent);" data-action="openCalendario" aria-label="Apri calendario eventi">${ICONS.calendar}</button>` : ''}
  </div>`;
}

function vehicleSwitcherHTML(){
  if(state.tab==='veicoli-detail' || state.tab==='ai' && false) return '';
  if(!['dashboard','log','ai','calendario'].includes(state.tab) || state.veicoli.length<1) return '';
  if(state.veicoli.length===0) return '';
  return `<div class="veh-switcher">
    ${state.veicoli.map(v=>`<button class="veh-chip ${v.id===state.selectedVeicoloId?'active':''}" data-action="selectVeicolo" data-id="${v.id}">${v.tipo==='moto'?'🏍':'🚗'} ${escapeHTML(v.marca)} ${escapeHTML(v.modello)}</button>`).join('')}
  </div>`;
}

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action="selectVeicolo"]');
  if(el){ state.selectedVeicoloId = el.dataset.id; await loadVeicoloData(el.dataset.id); render(); }
  const exp = e.target.closest('[data-action="exportBackup"]');
  if(exp){ await esportaJSON(); }
});
// Rifornimento: litri, €/L e costo si aggiornano a vicenda (€/L non viene salvato)
app.addEventListener('input', (e) => {
  const el = e.target.closest ? e.target.closest('[data-rif]') : null;
  if(!el) return;
  const form = document.getElementById('entryForm');
  const L = form && form.elements.litri, P = form && form.elements.prezzoL, C = form && form.elements.costo;
  if(!L || !P || !C) return;
  const num = x => { const n = parseFloat(x.value); return isFinite(n) ? n : NaN; };
  const field = el.dataset.rif;
  if(field==='costo'){
    C.dataset.manual = '1';
    const l = num(L), c = num(C);
    if(l>0 && c>=0) P.value = (c/l).toFixed(3);
  } else if(field==='prezzo'){
    C.dataset.manual = '';
    const l = num(L), p = num(P);
    if(l>=0 && p>=0) C.value = (l*p).toFixed(2);
  } else if(field==='litri'){
    const l = num(L);
    if(C.dataset.manual==='1'){
      const c = num(C);
      if(l>0 && c>=0) P.value = (c/l).toFixed(3);
    } else {
      const p = num(P);
      if(l>=0 && p>=0) C.value = (l*p).toFixed(2);
    }
  }
});
app.addEventListener('change', async (e) => {
  if(e.target.id==='importInput' && e.target.files[0]){ await importaJSON(e.target.files[0]); }
});

let lastRenderedTab = null;

function render(){
  let body = '';
  if(state.tab==='dashboard') body = viewDashboard();
  else if(state.tab==='veicoli') body = viewVeicoli();
  else if(state.tab==='veicoli-detail') body = viewVeicoloDetail(currentVeicolo());
  else if(state.tab==='log') body = viewLog();
  else if(state.tab==='calendario') body = viewCalendario();
  else if(state.tab==='ai') body = viewAI();
  else if(state.tab==='impostazioni') body = viewImpostazioni();

  let animClass = '';
  if(lastRenderedTab !== null && state.tab !== lastRenderedTab){
    const oldIdx = TAB_ORDER.indexOf(lastRenderedTab);
    const newIdx = TAB_ORDER.indexOf(state.tab);
    if(oldIdx !== -1 && newIdx !== -1){
      animClass = newIdx > oldIdx ? 'content-enter-fwd' : 'content-enter-back';
    }
  }
  lastRenderedTab = state.tab;

  app.innerHTML = `
    ${headerHTML()}
    ${vehicleSwitcherHTML()}
    <div class="${animClass}">${body}</div>
    ${tabBarHTML()}
    ${fabHTML()}
    ${state.modal ? modalContent() : ''}
    ${state.toast ? `<div class="toast" role="status">${state.toast.success ? `<span class="check-badge">${ICONS.check}</span>` : ''}${escapeHTML(state.toast.text)}${state.toast.actionLabel ? `<button class="toast-act" data-action="toastAction">${escapeHTML(state.toast.actionLabel)}</button>` : ''}</div>` : ''}
    ${state.lightbox ? `<div class="modal-overlay" style="align-items:center;justify-content:center;" data-action="closeLightboxBg">
      <img src="${state.lightbox.url}" alt="${escapeHTML(state.lightbox.nome||'')}" style="max-width:92%;max-height:82vh;border-radius:16px;object-fit:contain;">
      <button class="icon-btn" style="position:absolute;top:24px;right:18px;background:rgba(5,9,18,.72);color:var(--text);border-color:var(--border);" data-action="closeLightbox" aria-label="Chiudi immagine">${ICONS.close}</button>
    </div>` : ''}
  `;

  if(state.tab==='ai' && state.aiSubtab==='chat'){
    const scroll = document.querySelector('.chat-scroll');
    if(scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}

/* ---------------- SERVICE WORKER ---------------- */
function setupServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((e)=>{ console.warn('Service worker non registrato:', e); });
}

/* ---------------- INIT ---------------- */
async function requestPersistence(){
  try{
    if(!navigator.storage || !navigator.storage.persist) return;
    let ok = await navigator.storage.persisted();
    if(!ok && state.veicoli.length) ok = await navigator.storage.persist();
    state.storagePersisted = !!ok;
  } catch(e){ /* non supportato: nessuna azione */ }
}

(async function init(){
  try{
    setupServiceWorker();
    await loadSettings();
    applyTheme();
    await loadVeicoli();
    await loadVeicoloData(state.selectedVeicoloId);
    render();
    // non bloccante: in alcuni browser la richiesta mostra un permesso all'utente
    requestPersistence().then(()=>{ if(state.tab==='impostazioni' && !state.modal) render(); });
  } catch(e){
    console.error('Errore avvio MyGarage:', e);
    app.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text);">
      <h2 style="margin-bottom:10px;">Errore di avvio</h2>
      <p class="muted" style="font-size:14px;">${escapeHTML(e.message || String(e))}</p>
      <p class="muted" style="font-size:13px;margin-top:16px;">I dati salvati non sono stati toccati. Prova a ricaricare la pagina.</p>
    </div>`;
  }
})();
