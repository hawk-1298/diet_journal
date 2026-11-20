// Funzione "dynamic-api" (prima "send-push"): invia le notifiche del Diario.
// - ogni minuto la chiama il database (pg_cron) con l'intestazione x-cron-secret: invia i promemoria in scadenza;
// - i promemoria con tag "ai-report" chiamano Claude con il secret ANTHROPIC_API_KEY:
//     report della domenica (salvato nella Dashboard) e, dalla 1.14, il coach del mattino ({"kind":"daily"}, non salvato come report);
//   "prot-check" controlla le proteine del giorno.
// - l'app la chiama con il login dell'utente: {"action":"test"} invia una notifica di prova,
//   {"action":"timer","seconds":90} avvisa alla fine del recupero, {"action":"cancel"} annulla il timer.
// Le chiavi (SERVICE_KEY, VAPID_*, ANTHROPIC_API_KEY, CRON_SECRET) stanno nei Secrets di Supabase, mai in questo file.
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// chiave segreta del progetto: la metti tu nei "Secrets" come SERVICE_KEY (sb_secret_…); in mancanza si prova quella che Supabase mette da solo
function firstKey(): string {
  const own = Deno.env.get("SERVICE_KEY"); if (own) return own;
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (legacy) return legacy;
  try { const m = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return String(m.default || Object.values(m)[0] || ""); } catch { return ""; }
}
const KEY = firstKey();
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || SB_URL, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const enc = encodeURIComponent;

// le chiavi nuove (sb_secret_…) vanno solo in "apikey"; quelle vecchie (JWT) anche in "Authorization"
const hdr = (extra: Record<string, string> = {}) => ({
  apikey: KEY, ...(KEY.startsWith("sb_") ? {} : { Authorization: `Bearer ${KEY}` }), "Content-Type": "application/json", ...extra,
});
const rest = (path: string, init: RequestInit & { prefer?: string } = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: hdr(init.prefer ? { Prefer: init.prefer } : {}) });

async function sendToUser(userId: string, payload: Record<string, unknown>): Promise<number> {
  const r = await rest(`push_subs?user_id=eq.${enc(userId)}&select=endpoint,p256dh,auth`);
  if (!r.ok) throw new Error("subs " + r.status);
  const subs: { endpoint: string; p256dh: string; auth: string }[] = await r.json();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await rest(`push_subs?endpoint=eq.${enc(s.endpoint)}`, { method: "DELETE" }); // iscrizione scaduta
      else console.error("push error", code, (e as Error).message);
    }
  }
  return sent;
}

async function runDue() {
  const now = Date.now(), nowIso = new Date(now).toISOString();
  // scarta i promemoria rimasti indietro da più di 2 ore (es. se il servizio era fermo)
  await rest(`push_jobs?sent_at=is.null&fire_at=lt.${enc(new Date(now - 2 * 3600e3).toISOString())}`, { method: "PATCH", body: JSON.stringify({ sent_at: nowIso }), prefer: "return=minimal" });
  // "prenota" quelli in scadenza: l'UPDATE è atomico, quindi due esecuzioni non inviano lo stesso promemoria
  const r = await rest(`push_jobs?sent_at=is.null&fire_at=lte.${enc(nowIso)}&select=user_id,job_key,title,body,tag,url`, { method: "PATCH", body: JSON.stringify({ sent_at: nowIso }), prefer: "return=representation" });
  if (!r.ok) throw new Error("claim " + r.status);
  const jobs: { user_id: string; job_key: string; title: string; body: string; tag?: string; url?: string }[] = await r.json();
  let sent = 0;
  for (const j of jobs) {
    if (j.tag === "ai-report") { background(aiReport(j)); continue; }   // lento (chiama Claude): continua in secondo piano
    if (j.tag === "prot-check") { sent += await protCheck(j); continue; }
    sent += await sendToUser(j.user_id, { title: j.title, body: j.body, tag: j.tag, url: j.url });
  }
  // pulizia dei vecchi
  await rest(`push_jobs?sent_at=lt.${enc(new Date(now - 7 * 86400e3).toISOString())}`, { method: "DELETE" });
  return { due: jobs.length, sent };
}


type Job = { user_id: string; job_key: string; title: string; body: string; tag?: string; url?: string };
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ANTHROPIC_URL = Deno.env.get("ANTHROPIC_URL") || "https://api.anthropic.com/v1/messages";
const REPORT_MODEL = Deno.env.get("REPORT_MODEL") || "claude-sonnet-5-5";
const plain = (t: string) => t.replace(/\*\*/g, "").replace(/\n{2,}/g, "\n").trim();

// Messaggi scritti da Claude: l'app ha preparato nel promemoria il testo di riserva ("fb") e la richiesta ("prompt").
// - report della domenica: si salva nei dati dell'utente (lo ritrovi nella Dashboard) e arriva come notifica;
// - coach del mattino ("kind":"daily"): solo notifica, con il titolo scelto dall'app (l'app lo conserva nella scheda Coach).
// Se manca la chiave o la chiamata fallisce, parte comunque il testo di riserva.
async function aiReport(j: Job) {
  let o: { fb?: string; prompt?: string; end?: string; kind?: string } = {};
  try { o = JSON.parse(j.body); } catch { o = { fb: j.body }; }
  const daily = o.kind === "daily";
  let text = "";
  if (ANTHROPIC_KEY && o.prompt) {
    try {
      const r = await fetch(ANTHROPIC_URL, { method: "POST", signal: AbortSignal.timeout(90000),
        headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: REPORT_MODEL, max_tokens: daily ? 400 : 1200, messages: [{ role: "user", content: o.prompt }] }) });
      if (r.ok) { const d = await r.json(); text = (d.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim(); }
      else console.error("anthropic", r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error("anthropic", (e as Error).message); }
  }
  if (daily) {
    const body = text ? plain(text).split("\n").slice(0, 2).join(" ").slice(0, 220) : (o.fb || "");
    if (body) await sendToUser(j.user_id, { title: j.title || "☀️ Il coach del mattino", body, tag: j.tag, url: j.url });
    return;
  }
  let body = o.fb || "";
  if (text) {
    // dalla 1.15 il report inizia con "Voto: X/10 – …": in notifica va quella riga, il resto si legge nella Dashboard
    const lines = plain(text).split("\n").map((l) => l.trim()).filter(Boolean);
    body = /^voto/i.test(lines[0] || "") ? `${lines[0].slice(0, 200)}\nTocca per la revisione completa.` : lines.slice(0, 2).join("\n").slice(0, 260);
    // salva il report tra i dati dell'app, così lo ritrovi nella Dashboard
    try {
      const g = await rest(`app_data?user_id=eq.${enc(j.user_id)}&k=eq.reports&select=v`);
      const cur = g.ok ? ((await g.json())[0]?.v || {}) : {};
      cur[o.end || new Date().toISOString().slice(0, 10)] = { text, at: Date.now() };
      const ks = Object.keys(cur).sort(); while (ks.length > 12) delete cur[ks.shift()!];
      await rest("app_data?on_conflict=user_id,k", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify({ user_id: j.user_id, k: "reports", v: cur, updated_at: new Date().toISOString() }) });
    } catch (e) { console.error("save report", (e as Error).message); }
  }
  await sendToUser(j.user_id, { title: text ? "📊 Il report della tua settimana è pronto" : j.title, body: body || "Il riepilogo della settimana è pronto.", tag: j.tag, url: j.url });
}

// sceglie una variante diversa ogni giorno (stabile nello stesso giorno)
const pick = (arr: string[], seed: string) => { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return arr[h % arr.length]; };

// Proteine della sera: controlla a che punto sei (totali salvati dall'app) e avvisa solo se ne mancano parecchie.
async function protCheck(j: Job): Promise<number> {
  let o: { d?: string; goal?: number } = {}; try { o = JSON.parse(j.body); } catch { /* ignora */ }
  const goal = Number(o.goal) || 0; if (!goal || !o.d) return 0;
  const g = await rest(`app_data?user_id=eq.${enc(j.user_id)}&k=eq.tot&select=v`);
  const tot = g.ok ? ((await g.json())[0]?.v || {}) : {};
  const p = Number(tot[o.d]?.p) || 0;
  if (p >= goal * 0.9) return 0;
  const miss = Math.round(goal - p), P = Math.round(p), G = Math.round(goal);
  const body = p > 0
    ? pick([
        `Sei a ${P} g su ${G}: ne mancano ${miss}. Uno yogurt greco o una whey e chiudi in bellezza 💪`,
        `Mancano ${miss} g di proteine all'obiettivo. Ultimo sprint: albumi, fiocchi di latte o una whey 🥛`,
        `${P} g su ${G} finora. I muscoli aspettano gli ultimi ${miss} g: uno spuntino proteico e ci sei!`,
      ], o.d)
    : pick([
        `Il diario di oggi non ha ancora proteine (obiettivo ${G} g). Hai già mangiato? Segnalo ora 👀`,
        `Zero proteine registrate oggi. Se hai mangiato, aggiungilo al diario: la serie ti ringrazia 🔥`,
      ], o.d);
  return await sendToUser(j.user_id, { title: j.title || "🥩 Proteine di oggi", body, tag: j.tag, url: j.url || "?go=diario" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// lascia finire un lavoro anche dopo la risposta (su Supabase: EdgeRuntime.waitUntil); altrove basta non aspettarlo
function background(p: Promise<unknown>) {
  p.catch((e) => console.error("background", e));
  try { (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(p); } catch { /* ignora */ }
}

// Timer di recupero: salva un promemoria "timer" che scade tra N secondi e, se N è breve, aspetta e lo invia puntuale.
// Se la funzione viene fermata prima, ci pensa comunque il controllo di ogni minuto (al massimo con un minuto di ritardo).
async function startTimer(userId: string, seconds: number) {
  const secs = Math.max(3, Math.min(Math.round(seconds) || 90, 3600));
  const fireMs = Date.now() + secs * 1000, fireAt = new Date(fireMs).toISOString();
  const r = await rest("push_jobs?on_conflict=user_id,job_key", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ user_id: userId, job_key: "timer", fire_at: fireAt, title: "⏱️ Recupero finito", body: "Si riparte: tocca per la prossima serie 💪", tag: "rest-" + fireMs, url: "?go=wk", sent_at: null }),
  });
  if (!r.ok) throw new Error("timer " + r.status);
  if (secs <= 140) {
    background((async () => {
      await sleep(Math.max(0, fireMs - Date.now()));
      // se nel frattempo il timer è stato annullato o spostato, la riga non risulta in scadenza e non parte nulla
      const c = await rest(`push_jobs?user_id=eq.${enc(userId)}&job_key=eq.timer&sent_at=is.null&fire_at=lte.${enc(new Date(Date.now() + 1000).toISOString())}&select=title,body,tag,url`, {
        method: "PATCH", body: JSON.stringify({ sent_at: new Date().toISOString() }), prefer: "return=representation" });
      if (!c.ok) return;
      const rows: { title: string; body: string; tag?: string; url?: string }[] = await c.json();
      for (const j of rows) await sendToUser(userId, { title: j.title, body: j.body, tag: j.tag, url: j.url });
    })());
  }
  return { fire_at: fireAt };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const secret = req.headers.get("x-cron-secret");
    if (secret) {
      if (!CRON_SECRET || secret !== CRON_SECRET) return json({ error: "unauthorized" }, 401);
      return json(await runDue());
    }
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "unauthorized" }, 401);
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return json({ error: "unauthorized" }, 401);
    const user = await u.json();
    const body = await req.json().catch(() => ({}));
    if (body.action === "timer") return json({ ok: true, ...(await startTimer(user.id, Number(body.seconds))) }, 202);
    if (body.action === "cancel") {
      await rest(`push_jobs?user_id=eq.${enc(user.id)}&job_key=eq.timer&sent_at=is.null`, { method: "DELETE" });
      return json({ ok: true });
    }
    if (body.action !== "test") return json({ error: "azione sconosciuta" }, 400);
    const sent = await sendToUser(user.id, { title: "🎉 Notifiche attive", body: "Notifica di prova: funziona! Da qui arriveranno promemoria, serie e consigli del coach.", tag: "test", url: "./" });
    return json({ sent });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
