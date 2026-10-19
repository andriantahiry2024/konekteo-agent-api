// Agent Konekteo — API de conversation. La clé DeepSeek reste ici, côté serveur.
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.DEEPSEEK_API_KEY || "";
const API = process.env.DEEPSEEK_API || "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const ADMIN = process.env.SESSION_ADMIN_TOKEN || "";
const sessions = new Map();
const DATA_FILE = "/tmp/sessions.json";

function loadSessions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    for (const s of JSON.parse(raw)) sessions.set(s.sessionId, s);
    console.log(`sessions restaurées: ${sessions.size}`);
  } catch {}
}

function saveSessions() {
  try {
    const list = [...sessions.values()].slice(-60);
    fs.writeFileSync(DATA_FILE, JSON.stringify(list));
  } catch (e) {
    console.error("persistance:", e.message);
  }
}
loadSessions();

const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  "https://andriantahiry2024.github.io,http://localhost:5180,http://127.0.0.1:5180"
).split(",");

// Table de prix : le seul endroit où un montant existe. Le modèle ne fait que choisir une catégorie.
const PRICING = {
  site: {
    label: "Site web",
    delay: "7 jours ouvrés",
    lines: [
      { label: "Refonte du site (5 pages, thème sur mesure)", price: 890 },
      { label: "Migration du contenu et des images", price: 190 },
      { label: "Audit accessibilité et vitesse", price: 0, offered: true },
    ],
  },
  auto: {
    label: "Automatisation",
    delay: "5 jours ouvrés",
    lines: [
      { label: "Automatisation de la tâche (1 flux)", price: 690 },
      { label: "Connexion à vos outils existants", price: 190 },
      { label: "Documentation et passation", price: 0, offered: true },
    ],
  },
  perf: {
    label: "Performance",
    delay: "4 jours ouvrés",
    lines: [
      { label: "Audit de performance (mesures et captures)", price: 0, offered: true },
      { label: "Optimisation du chargement", price: 390 },
      { label: "Suivi des scores pendant 30 jours", price: 190 },
    ],
  },
  support: {
    label: "Assistance PC à distance",
    delay: "48 h",
    lines: [
      { label: "Diagnostic complet à distance (session RustDesk)", price: 90 },
      { label: "Nettoyage, mises à jour et sécurisation", price: 190 },
      { label: "Suivi 7 jours après l'intervention", price: 0, offered: true },
    ],
  },
  fallback: {
    label: "À cadrer",
    delay: "10 jours ouvrés",
    lines: [
      { label: "Cadrage et maquette", price: 490 },
      { label: "Réalisation", price: 690 },
      { label: "Audit final", price: 0, offered: true },
    ],
  },
};

const SYSTEM = `Tu es l'agent de Konekteo, un freelance malgache. Tu discutes avec un client pour comprendre son besoin et préparer un devis.

Ce que Konekteo fait réellement, et que tu peux donc proposer :
- sites web : création, refonte WordPress, performance, accessibilité, visibilité dans les IA ;
- automatisations : relances, factures, intégrations entre outils ;
- assistance informatique À DISTANCE : diagnostic PC, nettoyage, mises à jour, sécurisation, installation de logiciels, récupération de fichiers. Cela se fait par une session RustDesk que le client installe lui-même.

Règles absolues :
- Tu ne refuses jamais une demande qui entre dans ces domaines. Un scan antivirus, un PC lent, un nettoyage : c'est de l'assistance à distance, pas un refus.
- Tu ne redemandes jamais une information déjà donnée et tu ne redémarres jamais la conversation. Tiens compte de tout l'historique.
- Pose UNE seule question à la fois, courte (maximum 2 phrases).
- Après 2 ou 3 échanges, ou dès que le client demande un prix, un devis ou dit qu'il est pressé, tu passes à stage "quote".
- Tu ne donnes JAMAIS de prix toi-même : le montant est calculé ailleurs.

Catégories possibles : "site" (site web), "auto" (automatisation), "perf" (lenteur, vitesse, accessibilité, visibilité IA), "support" (assistance PC à distance, antivirus, nettoyage), "fallback" (le reste).

Cas particuliers :
- Si le client parle de son ordinateur, d'un virus, d'un nettoyage, d'un PC lent : c'est "support". Ne demande JAMAIS l'adresse d'un site web dans ce cas.
- Si le client est agacé, insultant ou pressé : arrête les questions, passe directement à stage "quote".
- Ne repose jamais une question déjà posée dans l'historique.
- Si le client se répète, c'est que tu n'as pas compris : reformule ta comprehension en une phrase, puis propose le devis.

Réponds TOUJOURS en JSON avec exactement ces clés :
{"reply": "ta réponse ou ta question", "stage": "ask" | "quote", "category": "site" | "auto" | "perf" | "support" | "fallback" | null}

Quand stage vaut "quote", "reply" est une phrase de transition courte (ex. "Très clair. Voilà ce que je propose.") et "category" doit être remplie.`;

const SYSTEM_TEXT = `${SYSTEM}

IMPORTANT : réponds en TEXTE BRUT, jamais en JSON. Exactement trois lignes :
REPLY: ta réponse au client, une à trois phrases
STAGE: ask ou quote
CATEGORY: site, auto, perf, support ou fallback (fallback si tu ne sais pas)`;

const reports = new Map();

const hits = new Map();

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function cors(res, origin) {
  const ok = ALLOWED.includes(origin) || ALLOWED.includes("*") || LOCAL_ORIGIN.test(origin);
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", ok ? origin : ALLOWED[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.replace(/```json/gi, "```").split("```").filter(Boolean);
  for (const part of fenced) {
    try {
      return JSON.parse(part.trim());
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

async function callModelText(history) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [{ role: "system", content: SYSTEM_TEXT }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

function parseTextReply(text) {
  const raw = String(text || "");
  if (raw.trim().length < 10) return null;
  const grab = (label) => {
    const m = raw.match(new RegExp(label + "\\s*:\\s*(.+)", "i"));
    return m ? m[1].trim() : "";
  };
  const reply = grab("REPLY") || raw.replace(/STAGE\s*:.*/gi, "").replace(/CATEGORY\s*:.*/gi, "").trim();
  const stage = /quote/i.test(grab("STAGE")) ? "quote" : "ask";
  const catRaw = grab("CATEGORY").toLowerCase();
  const category = ["site", "auto", "perf", "support", "fallback"].find((c) => catRaw.includes(c)) || null;
  if (!reply || reply.length < 5) return null;
  return { reply, stage, category };
}

async function callModel(history, jsonMode = true) {
  const body = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 800,
    messages: [{ role: "system", content: SYSTEM }, ...history],
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* Repli déterministe : le modèle renvoie parfois du vide. On ne laisse jamais
   le client devant « je n'ai pas bien saisi » deux fois de suite. */
const KEYWORDS = {
  support: /pc|ordinateur|windows|virus|antivirus|nettoyage|dépannage|depannage|rame|écran bleu|ecran bleu|disque|ssd|mémoire|memoire|mise à jour|mise a jour/i,
  site: /site|wordpress|vitrine|refonte|maquette|landing|page web/i,
  auto: /automat|script|relance|facture|excel|crm|whatsapp|télégram|telegram|intégration|integration/i,
  perf: /lent|vitesse|performance|chargement|rapide|audit/i,
};

function inferCategory(history) {
  const text = history.filter((m) => m.role === "user").map((m) => m.content).join(" ");
  for (const [cat, re] of Object.entries(KEYWORDS)) {
    if (re.test(text)) return cat;
  }
  return "fallback";
}

const QUESTIONS = {
  support: "C'est sous Windows, et le problème a commencé quand ?",
  site: "Qu'est-ce qui ne va pas aujourd'hui : le design, la vitesse, ou la mise à jour du contenu ?",
  auto: "Quelle tâche vous prend le plus de temps chaque semaine ?",
  perf: "C'est surtout gênant sur mobile ou sur ordinateur ?",
  fallback: "Décrivez-moi le résultat attendu, en une phrase.",
};

function quoteFor(category) {
  const p = PRICING[category] || PRICING.fallback;
  const lines = p.lines;
  const total = lines.reduce((s, l) => s + l.price, 0);
  return { key: category, label: p.label, delay: p.delay, lines, total };
}

function deterministicReply(history) {
  const category = inferCategory(history);
  const users = history.filter((m) => m.role === "user");
  const last = (users[users.length - 1]?.content || "").toLowerCase();
  const wantsPrice = /prix|devis|combien|tarif|coût|cout|urgent|rapidement|aujourd'hui|maintenant/.test(last);
  const annoyed = /con|nul|putain|merde|abruti|idiot|stupide/.test(last);
  if (wantsPrice || annoyed || users.length >= 3) {
    return { reply: "Très clair. Voilà ce que je propose.", stage: "quote", category, quote: quoteFor(category) };
  }
  return { reply: QUESTIONS[category], stage: "ask", category };
}

async function askDeepSeek(history) {
  const plans = [true, true, "text", "text"];
  for (let i = 0; i < plans.length; i++) {
    try {
      const text = plans[i] === "text" ? await callModelText(history) : await callModel(history, plans[i]);
      const parsed = plans[i] === "text" ? parseTextReply(text) : parseLoose(text);
      if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) return parsed;
      console.error(
        `réponse modèle illisible (essai ${i + 1}, json=${plans[i]}), longueur=${String(text || "").length}:`,
        JSON.stringify(String(text || "").slice(0, 120))
      );
    } catch (e) {
      console.error(`appel modèle en échec (essai ${i + 1}):`, e.message);
    }
  }
  console.error("repli déterministe utilisé");
  return deterministicReply(history);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  cors(res, origin);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return json(res, 200, { ok: true, model: MODEL, key: Boolean(KEY) });
  }
  // --- l'agent reçoit ici tout ce que le client transmet après le paiement ---
  if (req.method === "POST" && req.url === "/session") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 20_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        const id = String(p.rustdesk?.id || "").replace(/\s/g, "");
        const pwd = String(p.rustdesk?.pwd || "");
        const simulatedReq = p.simulated === true;
        if (!simulatedReq && (!/^\d{9,12}$/.test(id) || pwd.length < 4)) {
          return json(res, 400, { error: "identifiant ou mot de passe invalide" });
        }
        const simulated = p.simulated === true;
        const sid = "S" + Date.now().toString(36).toUpperCase();
        const record = {
          sessionId: sid,
          receivedAt: new Date().toISOString(),
          client: {
            email: String(p.email || "").slice(0, 120),
            name: String(p.name || "").slice(0, 60),
            ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
            userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
            lang: String(req.headers["accept-language"] || "").slice(0, 80),
          },
          quote: p.quote || null,
          site: record.site,
          rustdesk: simulated ? { id: "SIMULATION", password: "" } : { id, password: pwd },
          simulated,
          status: "pending",
        };
        record.site = String(p.site || "").slice(0, 300);
        record.status = simulated ? "simulated" : "pending";
        record.events = [
          {
            at: record.receivedAt,
            type: "received",
            label: simulated
              ? "Dossier reçu — mode simulation, aucune connexion ne sera ouverte"
              : "Dossier reçu : devis accepté, identifiants RustDesk transmis",
            status: "done",
          },
        ];
        record.feedback = [];
        record.tasks = ((record.quote && record.quote.lines) || []).map((l, i) => ({
          index: i,
          label: l.label,
          status: "pending",
        }));
        sessions.set(sid, record);
        saveSessions();
        console.log("SESSION REÇUE", JSON.stringify({ sid, id, email: record.client.email }));
        return json(res, 200, { ok: true, sessionId: sid, receivedAt: record.receivedAt });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  // --- rapport d'audit produit par l'agent ---
  if (req.method === "POST" && req.url === "/report") {
    const token = req.headers["x-admin-token"] || "";
    if (!ADMIN || token !== ADMIN) return json(res, 401, { error: "token requis" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        const id = String(p.sessionId || "").toUpperCase().slice(0, 30) || "R" + Date.now().toString(36).toUpperCase();
        reports.set(id, { ...p, receivedAt: new Date().toISOString() });
        const sess = sessions.get(id);
        if (sess) {
          sess.report = { url: p.url, metrics: p.metrics, scores: p.scores || null, findings: p.findings || [] };
          sess.events = sess.events || [];
          sess.events.push({
            at: new Date().toISOString(),
            type: "report",
            label: `Rapport d'audit généré (${(p.findings || []).length} constats)`,
            status: "done",
          });
          sessions.set(id, sess);
          saveSessions();
        }
        return json(res, 200, { ok: true, reportUrl: `/report/${id}` });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  const mReport = req.url.match(/^\/report\/([A-Z0-9]+)$/);
  if (req.method === "GET" && mReport) {
    const r = reports.get(mReport[1]);
    if (!r) return json(res, 404, { error: "rapport inconnu" });
    const f = (r.findings || [])
      .map((x) => `<li class="${x.ok ? "ok" : "ko"}"><b>${escapeHtml(x.label)}</b><span>${escapeHtml(x.value)}</span></li>`)
      .join("");
    const s = r.scores
      ? `<p class="scores">Score global : <b>${r.scores.total}</b> / 100 — performance ${r.scores.perf}, accessibilité ${r.scores.a11y}, données structurées ${r.scores.data}</p>`
      : "";
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapport Konekteo — ${escapeHtml(r.url || "")}</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0b0c;color:#f1efea;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:40px 20px}
main{max-width:820px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:#8d8880;margin:0 0 28px;font-size:13px}
.scores{background:#151514;border:1px solid #ffffff17;border-radius:12px;padding:14px 16px;margin:0 0 20px}
ul{list-style:none;padding:0;margin:0}
li{display:flex;justify-content:space-between;gap:16px;padding:11px 14px;border:1px solid #ffffff12;border-radius:10px;margin-bottom:8px;background:#111110}
li span{color:#c7c3bb;text-align:right}
li.ok b{color:#a2b399}
li.ko b{color:#e08a6f}
footer{margin-top:26px;color:#8d8880;font-size:12px}
</style></head><body><main>
<h1>Rapport d'audit — ${escapeHtml(r.url || "")}</h1>
<p class="sub">Produit par l'agent Konekteo · session ${escapeHtml(r.sessionId || "")} · ${new Date(r.receivedAt).toLocaleString("fr-FR")}</p>
${s}
<ul>${f}</ul>
<footer>Mesures automatisées : temps de réponse, poids de page, balises, images sans texte alternatif, données structurées, llms.txt. Aide documentaire, pas un avis juridique.</footer>
</main></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const mEv = req.url.match(/^\/session\/([A-Z0-9]+)\/event$/);
  if (req.method === "POST" && mEv) {
    const token = req.headers["x-admin-token"] || "";
    if (!ADMIN || token !== ADMIN) return json(res, 401, { error: "token requis" });
    const sess = sessions.get(mEv[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        sess.events = sess.events || [];
        sess.events.push({
          at: new Date().toISOString(),
          type: String(p.type || "action").slice(0, 30),
          label: String(p.label || "").slice(0, 200),
          status: ["done", "running", "error"].includes(p.status) ? p.status : "done",
          detail: String(p.detail || "").slice(0, 300),
        });
        if (p.type === "feedback_ack") {
          sess.feedback = (sess.feedback || []).map((f) =>
            f.status === "pending" ? { ...f, status: "acknowledged" } : f
          );
        }
        if (p.type === "task" && Number.isInteger(p.index) && sess.tasks && sess.tasks[p.index]) {
          sess.tasks[p.index].status = p.status || "done";
        }
        sess.updatedAt = new Date().toISOString();
        sessions.set(sess.sessionId, sess);
        saveSessions();
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  const mFb = req.url.match(/^\/session\/([A-Z0-9]+)\/feedback$/);
  if (req.method === "POST" && mFb) {
    const sess = sessions.get(mFb[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        const text = String(p.text || "").trim().slice(0, 600);
        if (text.length < 3) return json(res, 400, { error: "message trop court" });
        sess.feedback = sess.feedback || [];
        sess.feedback.push({ at: new Date().toISOString(), text, status: "pending" });
        sess.updatedAt = new Date().toISOString();
        sessions.set(sess.sessionId, sess);
        saveSessions();
        return json(res, 200, { ok: true, count: sess.feedback.length });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  const mStatus = req.url.match(/^\/session\/([A-Z0-9]+)\/status$/);
  if (req.method === "POST" && mStatus) {
    const token = req.headers["x-admin-token"] || "";
    if (!ADMIN || token !== ADMIN) return json(res, 401, { error: "token requis" });
    const sess = sessions.get(mStatus[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        sess.status = String(p.status || sess.status).slice(0, 40);
        sess.note = String(p.note || "").slice(0, 300);
        sess.updatedAt = new Date().toISOString();
        if (p.capture) sess.capture = String(p.capture).slice(0, 300);
        sessions.set(sess.sessionId, sess);
        saveSessions();
        console.log("STATUT", sess.sessionId, sess.status);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  const mOne = req.url.match(/^\/session\/([A-Z0-9]+)$/);
  if (req.method === "GET" && mOne) {
    const sess = sessions.get(mOne[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    return json(res, 200, {
      sessionId: sess.sessionId,
      status: sess.status,
      note: sess.note || "",
      receivedAt: sess.receivedAt,
      updatedAt: sess.updatedAt || null,
      quote: sess.quote ? { label: sess.quote.label, total: sess.quote.total } : null,
      site: sess.site || "",
      report: sess.report || null,
      tasks: sess.tasks || [],
      events: sess.events || [],
      feedback: (sess.feedback || []).map((f) => ({ at: f.at, text: f.text, status: f.status })),
    });
  }

  if (req.method === "GET" && req.url.startsWith("/sessions")) {
    const token = req.headers["x-admin-token"] || new URL(req.url, "http://x").searchParams.get("token") || "";
    if (!ADMIN || token !== ADMIN) return json(res, 401, { error: "token requis" });
    return json(res, 200, { count: sessions.size, sessions: [...sessions.values()].reverse() });
  }

  if (req.method !== "POST" || req.url !== "/chat") return json(res, 404, { error: "not found" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const bucket = hits.get(ip) || { t: now, n: 0 };
  if (now - bucket.t > 60_000) { bucket.t = now; bucket.n = 0; }
  bucket.n += 1;
  hits.set(ip, bucket);
  if (bucket.n > 20) return json(res, 429, { error: "trop de requêtes, réessayez dans une minute" });

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 20_000) req.destroy();
  });
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];
      const clean = history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
      if (!clean.length) return json(res, 400, { error: "historique vide" });

      const out = await askDeepSeek(clean);
      const stage = out.stage === "quote" ? "quote" : "ask";
      const category = PRICING[out.category] ? out.category : "fallback";

      if (stage === "quote") {
        const p = PRICING[category];
        const lines = p.lines;
        const total = lines.reduce((s, l) => s + l.price, 0);
        return json(res, 200, {
          reply: String(out.reply || "Voilà ce que je propose.").slice(0, 500),
          stage,
          quote: { key: category, label: p.label, delay: p.delay, lines, total },
        });
      }
      return json(res, 200, { reply: String(out.reply || "").slice(0, 500), stage });
    } catch (e) {
      console.error("chat error:", e.message);
      return json(res, 502, { error: "l'agent est momentanément indisponible" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`agent-api écoute sur ${PORT} (model ${MODEL}, clé ${KEY ? "ok" : "MANQUANTE"})`));
