// Agent Konekteo — API de conversation. La clé DeepSeek reste ici, côté serveur.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.DEEPSEEK_API_KEY || "";
const API = process.env.DEEPSEEK_API || "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const ADMIN = process.env.SESSION_ADMIN_TOKEN || "";
const sessions = new Map();

// Dossiers et rapports sur un volume persistant quand il existe (sinon /tmp).
function choisirDossier() {
  for (const d of ["/app/data", "/tmp"]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {}
  }
  return "/tmp";
}
const DATA_DIR = choisirDossier();
const DATA_FILE = `${DATA_DIR}/sessions.json`;

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

const SYSTEM = `Tu es l'assistant IA de Konekteo, une petite structure de développement web, d'automatisation et d'assistance informatique à distance. Tu accompagnes un client du premier message à la fin de l'intervention.

IDENTITÉ (obligatoire)
- Tu es une IA. Si on te demande qui parle : « Je suis l'assistant IA de Konekteo. L'intervention technique est réalisée par Nomena, technicien humain, joignable à contact@konekteo.com (réponse sous 2 h ouvrées). »
- Tu ne te fais jamais passer pour Nomena. Tu ne dis jamais « je lance », « je m'en occupe », « je transmets » : c'est le technicien qui agit, toi tu expliques.
- Si le client demande un humain, tu donnes le contact et le délai, sans le dissuader.

VÉRITÉ DU DOSSIER (source unique)
- « ÉTAT RÉEL DU DOSSIER » est la seule vérité. Tu ne déduis rien, tu n'inventes ni cause, ni état, ni délai, ni prix, ni promesse.
- Si une donnée manque (paiement, remboursement, délai, identité du technicien), tu réponds « je n'ai pas cette information » et tu proposes de la faire remonter à Nomena.
- Mots interdits tant qu'ils ne sont pas écrits dans le dossier : « tout compris », « sans surprise », « garanti », « dès aujourd'hui », « tout de suite », « rien n'est copié », « aucun risque ».
- Un chiffre non présent dans le dossier n'existe pas.

ARGENT
- Le devis accepté est définitif : tu ne réémets, ne recalcules et ne remplaces JAMAIS un devis. Toute demande d'ajout passe par un avenant présenté (ancien total, écart, nouveau total, impact délai) et attend un accord explicite.
- À « combien j'ai payé / il reste quoi ? » : montant payé, reste dû, date, où trouver le reçu — uniquement depuis le dossier. En mode démonstration, dis clairement qu'aucun débit réel n'a eu lieu.
- À « j'arrête / je suis remboursé ? » : si une session est en cours, indique que l'accès est coupé immédiatement ; donne la condition écrite de remboursement ; si elle n'est pas dans le dossier, dis que tu la fais confirmer par Nomena et donne le délai. Jamais d'esquive.

PÉRIMÈTRE ET ACCÈS
- L'accès au poste exige un mandat : périmètre, durée, captures, droit d'arrêt. Sans mandat, aucun identifiant n'est demandé ni utilisé.
- Mot de passe RustDesk : jamais répété, jamais affiché en clair ; dis qu'il sert uniquement à ouvrir la session, qu'il est temporaire et qu'il expire.
- Données : captures d'écran conservées pour prouver le travail, durée indiquée dans le dossier ; dossiers personnels non consultés ; suppression sur demande.
- Si le client demande « c'est obligatoire ? » (accessibilité, RGPD), réponds factuellement, sans menace ni silence, et précise que tu n'es pas juriste.

TON
- Français, vouvoiement, phrases courtes. Pas de « rassurez-vous », « pas de panique », « perfectible ».
- Vulgarise : chaque terme technique est traduit en une phrase concrète.
- Réponds d'abord à la question posée. Une seule action proposée, et seulement si elle existe dans l'interface.
- Si le client est agacé : réponse directe, aucune question de relance.
- Ne redemande jamais une information déjà donnée. Ne relance pas la conversation.

DEVIS
- Aux étapes 1/4 et 2/4, dès que le besoin est assez clair (un ou deux échanges), c'est TOI qui émets le devis : stage "quote" et category remplie. Les montants sont calculés par le serveur à partir de la catégorie — tu n'inventes aucun prix, tu choisis la catégorie.
- Ne refuse jamais de chiffrer sous prétexte qu'« aucun devis n'existe » : c'est justement ton rôle de le créer.
- Si un devis existe déjà dans le dossier, tu ne le réémets jamais : stage "ask".

SUGGESTIONS
- Joins toujours "suggestions" : 2 à 3 réponses courtes (moins de 45 caractères) que CE client aurait envie de cliquer ensuite, dans ses mots, collées à SON problème et à ce que tu viens de dire.
- Interdit : « Où on en est », « Combien ça coûte », « Parler à un humain », « En savoir plus » — ces formules génériques ne servent à rien.
- Exemples : après « faire scanner mon PC » → « Mon PC est très lent », « J'ai peut-être un virus », « Combien pour un scan ? ».
- Après une réponse sur un site lent → « Combien pour l'optimiser ? », « Vous mesurez quoi ? », « Mon site est sur WordPress ».

RÉPONSE
Réponds toujours en JSON strict :
{"reply": "ta réponse", "stage": "ask" | "quote", "category": "site" | "auto" | "perf" | "support" | "fallback" | null, "suggestions": ["...", "...", "..."]}
Quand "stage" vaut "quote", "reply" est une phrase de transition courte et "category" doit être remplie. Si un devis existe déjà dans le dossier, "stage" reste "ask".`;

const SYSTEM_TEXT = `${SYSTEM}

IMPORTANT : réponds en TEXTE BRUT, jamais en JSON. Exactement trois lignes :
REPLY: ta réponse au client, une à trois phrases
STAGE: ask ou quote
CATEGORY: site, auto, perf, support ou fallback (fallback si tu ne sais pas)`;

const reports = new Map();
const REPORTS_FILE = `${DATA_DIR}/reports.json`;

function loadReports() {
  try {
    const raw = fs.readFileSync(REPORTS_FILE, "utf8");
    for (const r of JSON.parse(raw)) reports.set(r.sessionId, r);
    console.log(`rapports restaurés: ${reports.size}`);
  } catch {}
}

function saveReports() {
  try {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify([...reports.values()].slice(-40)));
  } catch (e) {
    console.error("rapports:", e.message);
  }
}
loadReports();

const ADDONS = [
  { re: /(modifier|changer|corriger|mettre [aà] jour|editer|[eé]diter)\s+(mes|les|le|la)?\s*(textes?|contenus?|pages?)/i, label: "Édition et mise à jour des textes", price: 240 },
  { re: /refonte (de )?(la )?page d.accueil/i, label: "Refonte de la page d'accueil", price: 350 },
  { re: /r[eé]daction|contenu|[aà]-propos|page contact/i, label: "Rédaction de contenus", price: 180 },
  { re: /logo|identit[eé] visuelle|chartre/i, label: "Identité visuelle", price: 290 },
  { re: /r[eé]servation|r[eé]server|prendre (des )?rendez-vous|agenda/i, label: "Module de réservation en ligne", price: 390 },
  { re: /e-?commerce|boutique en ligne|vendre en ligne|paiement en ligne|panier|page boutique/i, label: "Boutique en ligne avec paiement", price: 590 },
  { re: /r[eé]dig|r[eé]daction|textes? (de|des) (la|ma) page|contenu r[eé]dig/i, label: "Rédaction des textes", price: 180 },
];

function detecterAvenant(message, quote) {
  const m = String(message || "");
  for (const a of ADDONS) {
    if (!a.re.test(m)) continue;
    const dejaLa = quote && (quote.lines || []).some((l) => l.label === a.label);
    if (dejaLa) continue;
    return { label: a.label, price: a.price };
  }
  return null;
}

const SUGGESTIONS_REPLI = {
  support: ["Mon PC est très lent", "J'ai peut-être un virus", "Combien pour un scan ?"],
  site: ["Combien pour refaire mon site ?", "Mon site est sur WordPress", "Je ne peux plus modifier mes textes"],
  perf: ["Combien pour l'optimiser ?", "Vous mesurez quoi exactement ?", "Mon site met 5 s à s'ouvrir"],
  auto: ["Je relance mes devis à la main", "Combien de temps ça me fait gagner ?", "Ça marche avec Excel ?"],
  fallback: ["Mon site est lent", "Je perds du temps sur des tâches répétitives", "Je ne suis pas visible sur les IA"],
};

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

function nettoyerReply(txt) {
  return String(txt || "")
    .replace(/^\s*(REPLY|R[EÉ]PONSE)\s*:\s*/i, "")
    .replace(/\n?\s*(SUGGESTIONS?|CATEGORY|STAGE|REPLY)\s*:\s*\[/gi, "")
    .replace(/\n?\s*(SUGGESTIONS?|CATEGORY|STAGE)\s*:.*$/gim, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .trim();
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

async function callModelText(history, ctxText = "") {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [{ role: "system", content: SYSTEM_TEXT + (ctxText ? "\n\n" + ctxText : "") }, ...history],
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

function contexteSysteme(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];
  if (ctx.step) parts.push(`Étape du parcours : ${ctx.step}`);
  if (ctx.sessionId) parts.push(`Dossier : ${ctx.sessionId}`);
  if (ctx.status) parts.push(`Statut de la session : ${ctx.status}`);
  if (ctx.quote) {
    const lignes = (ctx.quote.lines || []).map((l) => `${l.label} (${l.price === 0 ? "offert" : l.price + " €"})`).join(" ; ");
    parts.push(
      `Devis accepté : ${ctx.quote.label}, total ${ctx.quote.total} €${ctx.quote.delay ? `, délai ${ctx.quote.delay}` : ""} — lignes : ${lignes}`
    );
  }
  if (Array.isArray(ctx.tasks) && ctx.tasks.length) {
    parts.push("Tâches : " + ctx.tasks.map((t) => `${t.label} [${t.status}]`).join(" ; "));
  }
  if (Array.isArray(ctx.events) && ctx.events.length) {
    parts.push("Dernières actions : " + ctx.events.slice(-6).map((e) => e.label).join(" | "));
  }
  if (ctx.payment) {
    const pay = ctx.payment;
    parts.push(
      `Paiement : ${pay.paid ? `payé ${pay.amount} € le ${pay.date}` : "non payé"}${pay.demo ? " (MODE DÉMONSTRATION : aucun débit réel, aucune carte traitée)" : ""}. Reste à payer : ${pay.due || 0} €.`
    );
  }
  if (ctx.mandate) {
    parts.push(
      `Mandat : ${ctx.mandate.signed ? `signé le ${ctx.mandate.date}, périmètre ${ctx.mandate.scope}, durée max ${ctx.mandate.duration}, captures conservées ${ctx.mandate.retention}` : "NON signé"}.`
    );
  }
  if (ctx.technician) {
    parts.push(`Technicien humain : ${ctx.technician.name}, joignable ${ctx.technician.contact}, délai de réponse ${ctx.technician.eta}.`);
  }
  if (ctx.policy) {
    parts.push(`Politiques écrites : arrêt/remboursement = ${ctx.policy.refund}; données = ${ctx.policy.data}; CGV = ${ctx.policy.terms}.`);
  }
  if (ctx.report) {
    const c = (ctx.report.findings || []).filter((f) => !f.ok).map((f) => `${f.label} = ${f.value}`).join(" ; ");
    parts.push(`Rapport d'audit : score ${ctx.report.scores ? ctx.report.scores.total : "?"} /100. Points faibles : ${c || "aucun"}`);
  }
  if (!parts.length) return "";
  return "ÉTAT RÉEL DU DOSSIER (source de vérité, ne l'invente pas) : " + parts.join(". ") + ".";
}

async function callModel(history, jsonMode = true, ctxText = "") {
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

/* Réponses déterministes pour les questions les plus fréquentes du client :
   on ne laisse pas le modèle inventer un état ou un chiffre. */
function reponsePMDirecte(message, ctx, history) {
  const m = String(message || "").toLowerCase();
  const c = ctx || {};
  const etape = c.step || "1/4 — Compréhension";
  const statut = c.status || null;
  const taches = Array.isArray(c.tasks) ? c.tasks : [];
  const faites = taches.filter((t) => t.status === "done");
  const pay = c.payment || null;
  const pol = c.policy || null;

  // 0. demande de prix sans devis existant : on chiffre, sans question de plus
  const intentionPrix =
    /\b(prix|tarif|combien|co[uû]t|budget|combien ça coûte|ça coûte)\b/.test(m) &&
    !/relanc|suivre mes devis|mes devis en attente|relancer mes devis/.test(m);
  if (!c.quote && intentionPrix) {
    const cat = inferCategory(history || []);
    if (cat !== "fallback") {
      const p = PRICING[cat];
      const total = (p.lines || []).reduce((sum, l) => sum + (l.price || 0), 0);
      return {
        reply: `Voilà une base de devis pour ${p.label.toLowerCase()} : ${total} € ${p.delay ? `(délai ${p.delay})` : ""}. Elle couvre les lignes affichées ; ce qui n'y figure pas (réservation, boutique, rédaction…) sera chiffré en avenant avant toute action.`,
        stage: "quote",
        category: cat,
      };
    }
    if (history && history.filter((h) => h.role === "user").length >= 2) {
      const p = PRICING.support;
      const total = (p.lines || []).reduce((sum, l) => sum + (l.price || 0), 0);
      return {
        reply: `Faute de précision sur le site, je pars sur une assistance à distance : ${total} €. Dites-moi si c'est autre chose.`,
        stage: "quote",
        category: "support",
      };
    }
  }

  // 1. identité : qui parle, qui agit
  if (/ia ou un humain|qui me parle|qui va toucher|robot|une ia|c'est qui/.test(m)) {
    const tech = c.technician
      ? `${c.technician.name}, joignable à ${c.technician.contact} (réponse ${c.technician.eta})`
      : "Nomena, technicien humain (contact@konekteo.com, réponse sous 2 h ouvrées)";
    return {
      reply: `Je suis l'assistant IA de Konekteo : je vous explique et je suis le dossier. L'intervention sur votre poste est faite par ${tech}. Voulez-vous que je vous mette en relation maintenant ?`,
      stage: "ask",
      category: null,
    };
  }

  // 2. argent déjà payé / remboursement / arrêt
  if (/rembours|j'arr[eê]te|j arrete|je veux arr[eê]ter|r[eé]cup[eè]re|annuler/.test(m)) {
    const refund = pol ? pol.refund : "condition à confirmer par Nomena sous 2 h ouvrées";
    if (!pay || !pay.paid) {
      return {
        reply: `Je n'ai aucun paiement enregistré dans votre dossier : il n'y a donc rien à rembourser à ce stade, et aucune somme n'a été prélevée. Condition d'arrêt : ${refund}. Voulez-vous que je transmette la demande à Nomena ?`,
        stage: "ask",
        category: null,
      };
    }
    const actif = ["connected", "connecting"].includes(c.status);
    return {
      reply: `Paiement enregistré : ${pay.amount} € le ${pay.date}${pay.demo ? " (démonstration : aucun débit réel)" : ""}. Condition d'arrêt : ${refund}.${actif ? " Dites-moi « arrêtez » : je transmets la coupure au technicien, qui coupe l'accès." : " Aucune session n'est en cours, donc il n'y a pas d'accès à couper."}`,
      stage: "ask",
      category: null,
    };
  }
  if (/pay[eé]|reste quoi|reste à payer|reste a payer|reçu|recu/.test(m) && !/combien/.test(m)) {
    return {
      reply: pay
        ? `Le dossier indique : ${pay.paid ? `${pay.amount} € payés le ${pay.date}` : "paiement non confirmé"}${pay.demo ? " — mode démonstration, aucun débit réel" : ""}. Reste à payer : ${pay.due || 0} €.${pay.receipt ? " Reçu : " + pay.receipt : " Pour le reçu, Nomena vous le transmet sur demande."}`
        : "Je n'ai pas le détail du paiement dans le dossier ; je le fais confirmer par Nomena sous 2 h ouvrées.",
      stage: "ask",
      category: null,
    };
  }

  // 3. données, mot de passe, captures
  if (/mot de passe|(vous|tu)\s+(copiez|gardez|conservez|voyez|lisez)|confidentialit|rgpd|donn[eé]es personnelles|mes dossiers (clients|personnels)|captures? d.écran/.test(m)) {
    const ret = c.mandate ? c.mandate.retention : "30 jours";
    return {
      reply: `Le mot de passe RustDesk sert uniquement à ouvrir la session : il est temporaire, expire après usage, et je ne l'affiche ni ne le répète. Le mandat encadre l'accès (périmètre, durée). Des captures d'écran sont conservées ${ret} comme preuve du travail, puis supprimées sur demande. Vos dossiers personnels ne sont pas consultés.`,
      stage: "ask",
      category: null,
    };
  }

  // 4. garanties : on ne promet pas de résultat non mesuré
  if (/garanti|garantissez|plus rapide de combien|appara[iî]trai|chatgpt|r[eé]sultat/.test(m)) {
    return {
      reply: `Je ne peux pas garantir un résultat : le devis porte sur des travaux mesurés, pas sur un classement ou une citation dans ChatGPT. Ce que je peux montrer, c'est l'état actuel (${c.report && c.report.scores ? "score " + c.report.scores.total + "/100" : "mesures du rapport"}) et l'écart après optimisation. Voulez-vous que je détaille les points mesurés ?`,
      stage: "ask",
      category: null,
    };
  }

  if (/d[eé]lai|combien de temps|quand (est-ce que )?(ce sera|c'est) pr[eê]t|date de livraison/.test(m)) {
    if (c.quote && c.quote.delay) {
      return {
        reply: `Le devis ${c.quoteAccepted ? "accepté" : "proposé"} prévoit : ${c.quote.delay}. Ce délai court à partir du moment où j'ai tout ce qu'il faut (accès ou contenus).`,
        stage: "ask",
        category: null,
      };
    }
    return null;
  }

  // 5. périmètre : la demande n'est pas dans le devis → avenant
  if (/pas dans le devis|hors devis|ajouter|en plus|changer mes textes|refonte|ca change combien|ça change combien/.test(m)) {
    const total = c.quote ? c.quote.total : null;
    return {
      reply: `Non : cette demande n'est pas couverte par le devis actuel${total ? ` de ${total} €` : ""}. Je prépare un avenant écrit : ancien total, ligne ajoutée, écart, nouveau total et impact sur le délai — Nomena vous le confirme sous 2 h ouvrées. Aucune action ne démarre avant votre accord explicite.`,
      stage: "ask",
      category: null,
    };
  }

  // 6. état du dossier
  if (/o[uù]\s*(on\s*)?en est|statut|avancement|[cç]a avance/.test(m)) {
    let txt = `On est à l'étape ${etape}.`;
    if (statut === "connected") txt += " La connexion à votre poste est active, le technicien travaille.";
    else if (statut === "connecting") txt += " La connexion à votre poste est en cours.";
    else if (statut === "closed") txt += " L'intervention est terminée.";
    else if (statut === "failed" || statut === "error") txt += " La connexion a échoué, on peut réessayer ensemble.";
    else if (statut === "simulated") txt += " C'est une session de démonstration, aucune connexion réelle.";
    if (taches.length) {
      const restantes = taches.filter((t) => t.status !== "done").map((t) => t.label);
      txt += ` Tâches faites : ${faites.length}/${taches.length}.`;
      if (restantes.length) txt += ` Reste : ${restantes.join(", ")}.`;
    }
    txt += " Voulez-vous que je vous explique une ligne en particulier ?";
    return { reply: txt, stage: "ask", category: null };
  }

  // 7. rapport et score
  if (/score|rapport|llms|json-?ld|alt|audit/.test(m) && c.report) {
    const r = c.report;
    const score = r.scores ? r.scores.total : null;
    const faibles = (r.findings || []).filter((f) => !f.ok).map((f) => `${f.label} (${f.value})`);
    let txt = score != null ? `Le score de votre site est ${score} sur 100.` : "Le rapport est disponible.";
    if (faibles.length) txt += ` Points à corriger : ${faibles.slice(0, 3).join(", ")}.`;
    else txt += " Aucun point bloquant détecté sur les critères mesurés.";
    txt += " Je peux vous détailler chaque point en langage simple.";
    return { reply: txt, stage: "ask", category: null };
  }

  // 8. prix du devis (en dernier : « combien » est ambigu)
  if (/combien|prix|tarif|devis|co[uû]t/.test(m) && c.quote) {
    const qualif = c.quoteAccepted ? "accepté" : "proposé";
    return {
      reply: `Le devis ${qualif} est de ${c.quote.total} € (${c.quote.label}), ligne par ligne dans votre dossier. Vous voulez que je détaille les lignes ou que j'explique une ligne précise ?`,
      stage: "ask",
      category: null,
    };
  }
  return null;
}

async function askDeepSeek(history, ctxText = "", ctx = null) {
  const plans = [true, true, "text", "text"];
  for (let i = 0; i < plans.length; i++) {
    try {
      const text = plans[i] === "text" ? await callModelText(history, ctxText) : await callModel(history, plans[i], ctxText);
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
    return json(res, 200, { ok: true, model: MODEL, key: Boolean(KEY), build: "v13-personas" });
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
        const simulatedReq = p.simulated === true || p.simulated === "true";
        if (!simulatedReq && (!/^\d{9,12}$/.test(id) || pwd.length < 4)) {
          return json(res, 400, { error: "identifiant ou mot de passe invalide" });
        }
        const simulated = simulatedReq;
        const sid = "S" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
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
          quote: (() => {
            if (!p.quote || typeof p.quote !== "object") return null;
            const lines = Array.isArray(p.quote.lines)
              ? p.quote.lines
                  .filter((l) => l && typeof l === "object")
                  .map((l) => ({ label: String(l.label || "").slice(0, 160), price: Math.max(0, Number(l.price) || 0) }))
                  .slice(0, 20)
              : [];
            return {
              key: ["site", "auto", "perf", "support"].includes(p.quote.key) ? p.quote.key : "fallback",
              label: String(p.quote.label || "").slice(0, 120),
              delay: String(p.quote.delay || "").slice(0, 60),
              lines,
              total: lines.reduce((sum, l) => sum + l.price, 0),
            };
          })(),
          rustdesk: simulated ? { id: "SIMULATION", password: "" } : { id, password: pwd },
          simulated,
          status: "pending",
        };
        record.site = String(p.site || "").slice(0, 300);
        record.mandate = p.mandate
          ? {
              signed: true,
              date: new Date().toISOString(),
              scope: String(p.mandate.scope || "").slice(0, 300),
              duration: String(p.mandate.duration || "90 minutes"),
              retention: String(p.mandate.retention || "30 jours"),
            }
          : null;
        record.payment = p.payment
          ? {
              paid: true,
              amount: Number(p.payment.amount) || 0,
              date: new Date().toISOString(),
              demo: p.payment.demo !== false,
              due: 0,
              receipt: null,
            }
          : null;
        record.technician = {
          name: "Nomena ANDRIANTAHIRY",
          contact: "contact@konekteo.com",
          eta: "2 heures ouvrées",
        };
        record.policy = {
          refund: "remboursement intégral si l'intervention n'a pas commencé, au prorata ensuite",
          data: "captures conservées 30 jours puis supprimées sur demande",
          terms: "CGV sur konekteo.com/cgv",
        };
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
        const id =
          String(p.sessionId || "")
            .toUpperCase()
            .replace(/[^A-Z0-9-]/g, "")
            .slice(0, 30) || "R" + Date.now().toString(36).toUpperCase();
        const findings = Array.isArray(p.findings)
          ? p.findings
              .filter((f) => f && typeof f === "object")
              .map((f) => ({
                label: String(f.label || "").slice(0, 160),
                value: String(f.value || "").slice(0, 160),
                ok: f.ok === true,
              }))
              .slice(0, 40)
          : [];
        const scores =
          p.scores && typeof p.scores === "object"
            ? {
                perf: Number(p.scores.perf) || 0,
                a11y: Number(p.scores.a11y) || 0,
                data: Number(p.scores.data) || 0,
                total: Number(p.scores.total) || 0,
              }
            : null;
        reports.set(id, {
          ...p,
          sessionId: id,
          url: String(p.url || "").slice(0, 300),
          findings,
          scores,
          metrics: p.metrics && typeof p.metrics === "object" ? p.metrics : {},
          receivedAt: new Date().toISOString(),
        });
        saveReports();
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

  if (req.method === "GET" && req.url === "/diag.ps1") {
    const script = `$ErrorActionPreference = "SilentlyContinue"
$o = Join-Path $env:USERPROFILE "konekteo-diagnostic.txt"
"Konekteo - diagnostic du poste" | Out-File $o -Encoding UTF8
"Date : $(Get-Date -Format 'dd/MM/yyyy HH:mm')" | Out-File $o -Append -Encoding UTF8
"" | Out-File $o -Append -Encoding UTF8
$os = Get-CimInstance Win32_OperatingSystem
"Systeme         : $($os.Caption) $($os.Version)" | Out-File $o -Append -Encoding UTF8
$ram = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$ramL = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
"Memoire         : $ram Go dont $ramL Go libres" | Out-File $o -Append -Encoding UTF8
$d = Get-PSDrive C
"Disque C:       : $([math]::Round($d.Free / 1GB, 1)) Go libres sur $([math]::Round(($d.Used + $d.Free) / 1GB, 1)) Go" | Out-File $o -Append -Encoding UTF8
$mp = Get-MpComputerStatus
"Antivirus       : actif=$($mp.AntivirusEnabled) temps reel=$($mp.RealTimeProtectionEnabled) signatures=$($mp.AntivirusSignatureVersion)" | Out-File $o -Append -Encoding UTF8
$temp = (Get-ChildItem $env:TEMP -Recurse -Force | Measure-Object Length -Sum).Sum
"Fichiers temp   : $([math]::Round($temp / 1MB, 1)) Mo" | Out-File $o -Append -Encoding UTF8
$startup = (Get-CimInstance Win32_StartupCommand | Select-Object -First 8)
"Demarrage auto  : $($startup.Count) elements" | Out-File $o -Append -Encoding UTF8
"" | Out-File $o -Append -Encoding UTF8
"Nettoyage des fichiers temporaires de plus de 2 jours..." | Out-File $o -Append -Encoding UTF8
$avant = $temp
Get-ChildItem $env:TEMP -Recurse -Force | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$apres = (Get-ChildItem $env:TEMP -Recurse -Force | Measure-Object Length -Sum).Sum
$gain = [math]::Round(($avant - $apres) / 1MB, 1)
"Espace libere    : $gain Mo" | Out-File $o -Append -Encoding UTF8
Start-Process notepad.exe $o
`;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    return res.end(script);
  }

  const mReport = req.url.match(/^\/report\/([A-Z0-9-]+)$/);
  if (req.method === "GET" && mReport) {
    let r = null;
    try {
      r = reports.get(mReport[1]);
    } catch (e) {
      r = null;
    }
    if (!r) return json(res, 404, { error: "rapport inconnu" });
    const findings = Array.isArray(r.findings) ? r.findings.filter((x) => x && typeof x === "object") : [];
    const sc = r.scores && typeof r.scores === "object" ? r.scores : null;
    const f = findings
      .map((x) => `<li class="${x.ok ? "ok" : "ko"}"><b>${escapeHtml(x.label)}</b><span>${escapeHtml(x.value)}</span></li>`)
      .join("");
    const s = sc
      ? `<p class="scores">Score global : <b>${escapeHtml(Number(sc.total) || 0)}</b> / 100 — performance ${escapeHtml(
          Number(sc.perf) || 0
        )}, accessibilité ${escapeHtml(Number(sc.a11y) || 0)}, données structurées ${escapeHtml(Number(sc.data) || 0)}</p>`
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
<p class="sub">Score = performance 40 % + accessibilité 30 % + données structurées 30 %. La présence de llms.txt est contrôlée mais n'entre pas dans ce score.</p>
<footer>Mesures automatisées : temps de réponse, poids de page, balises, images sans texte alternatif, données structurées, llms.txt. Aide documentaire, pas un avis juridique.</footer>
</main></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const mEv = req.url.match(/^\/session\/([A-Z0-9-]+)\/event$/);
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

  const mStop = req.url.match(/^\/session\/([A-Z0-9-]+)\/stop$/);
  if (req.method === "POST" && mStop) {
    const sess = sessions.get(mStop[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    sess.status = "cancelled";
    sess.updatedAt = new Date().toISOString();
    sess.events = sess.events || [];
    sess.events.push({
      at: sess.updatedAt,
      type: "stop",
      label: "Arrêt demandé par le client — accès coupé",
      status: "done",
    });
    sessions.set(sess.sessionId, sess);
    saveSessions();
    return json(res, 200, { ok: true, status: "cancelled" });
  }

  const mAdd = req.url.match(/^\/session\/([A-Z0-9-]+)\/addendum$/);
  if (req.method === "POST" && mAdd) {
    const sess = sessions.get(mAdd[1]);
    if (!sess) return json(res, 404, { error: "session inconnue" });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        const label = String(p.label || "").slice(0, 120);
        const price = Math.max(0, Math.min(5000, Number(p.price) || 0));
        if (!label || !price) return json(res, 400, { error: "avenant invalide" });
        sess.quote = sess.quote || { label: "", total: 0, lines: [] };
        sess.quote.lines = [...(sess.quote.lines || []), { label, price }];
        sess.quote.total = sess.quote.lines.reduce((sum, l) => sum + (l.price || 0), 0);
        sess.quote.updatedAt = new Date().toISOString();
        sess.events = sess.events || [];
        sess.events.push({
          at: new Date().toISOString(),
          type: "addendum",
          label: `Avenant accepté : ${label} (+${price} €) — nouveau total ${sess.quote.total} €`,
          status: "done",
        });
        sessions.set(sess.sessionId, sess);
        saveSessions();
        return json(res, 200, { ok: true, total: sess.quote.total });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
  }

  const mFb = req.url.match(/^\/session\/([A-Z0-9-]+)\/feedback$/);
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

  const mStatus = req.url.match(/^\/session\/([A-Z0-9-]+)\/status$/);
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
        const nouveau = String(p.status || sess.status).slice(0, 40);
        if (sess.status === "cancelled" && nouveau !== "cancelled") {
          return json(res, 200, { ok: true, note: "session déjà arrêtée par le client" });
        }
        sess.status = nouveau;
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

  const mOne = req.url.match(/^\/session\/([A-Z0-9-]+)$/);
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
      mandate: sess.mandate || null,
      payment: sess.payment || null,
      technician: sess.technician || null,
      policy: sess.policy || null,
      report: sess.report || null,
      tasks: sess.tasks || [],
      events: sess.events || [],
      feedback: (sess.feedback || []).map((f) => ({ at: f.at, text: f.text, status: f.status })),
    });
  }

  const chemin = req.url.split("?")[0];
  if (req.method === "GET" && chemin === "/sessions") {
    const token = req.headers["x-admin-token"] || "";
    if (!ADMIN || token !== ADMIN) return json(res, 401, { error: "token requis" });
    const liste = [...sessions.values()].reverse().map((sess) => ({
      ...sess,
      rustdesk: sess.rustdesk ? { id: sess.rustdesk.id, password: "••••••" } : null,
    }));
    return json(res, 200, { count: liste.length, sessions: liste });
  }

  if (req.method !== "POST" || req.url !== "/chat") return json(res, 404, { error: "not found" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const bucket = hits.get(ip) || { t: now, n: 0 };
  if (now - bucket.t > 60_000) { bucket.t = now; bucket.n = 0; }
  bucket.n += 1;
  hits.set(ip, bucket);
  if (bucket.n > 20) {
    res.setHeader("Retry-After", "60");
    return json(res, 429, { error: "trop de requêtes, réessayez dans une minute" });
  }

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 20_000) req.destroy();
  });
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const ctx = Object.assign({}, payload.context || {});
      if (ctx.sessionId && sessions.has(ctx.sessionId)) {
        const vrai = sessions.get(ctx.sessionId);
        ctx.quote = vrai.quote || null;
        ctx.payment = vrai.payment || null;
        ctx.mandate = vrai.mandate || null;
        ctx.technician = vrai.technician || null;
        ctx.policy = vrai.policy || null;
        ctx.site = vrai.site || "";
        ctx.tasks = vrai.tasks || null;
        ctx.events = vrai.events || null;
        ctx.report = vrai.report || null;
        ctx.status = vrai.status;
      } else {
        // session inconnue ou pas encore créée : on ne croit aucun état déclaratif
        ctx.payment = null;
        ctx.mandate = null;
        ctx.technician = null;
        ctx.policy = null;
        ctx.tasks = null;
        ctx.events = null;
        ctx.report = null;
      }
      // le devis déclaré est recalculé depuis ses lignes, jamais depuis son total
      if (ctx.quote && typeof ctx.quote === "object") {
        const lignes = Array.isArray(ctx.quote.lines)
          ? ctx.quote.lines
              .filter((l) => l && typeof l === "object")
              .map((l) => ({ label: String(l.label || "").slice(0, 120), price: Math.max(0, Number(l.price) || 0) }))
              .slice(0, 20)
          : [];
        ctx.quote = lignes.length
          ? {
              key: ["site", "auto", "perf", "support"].includes(ctx.quote.key) ? ctx.quote.key : "fallback",
              label: String(ctx.quote.label || "").slice(0, 120),
              delay: String(ctx.quote.delay || "").slice(0, 60),
              lines: lignes,
              total: lignes.reduce((sum, l) => sum + l.price, 0),
            }
          : null;
      }
      if (!ctx.technician) {
        ctx.technician = { name: "Nomena ANDRIANTAHIRY", contact: "contact@konekteo.com", eta: "2 heures ouvrées" };
      }
      const ctxText = contexteSysteme(ctx);
      const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];
      const clean = history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
      if (!clean.length) return json(res, 400, { error: "historique vide" });

      const lastUser = [...clean].reverse().find((m) => m.role === "user");
      const direct = lastUser ? reponsePMDirecte(lastUser.content, ctx, clean) : null;
      let out = direct || (await askDeepSeek(clean, ctxText, ctx));
      let suggestions = Array.isArray(out.suggestions)
        ? out.suggestions.filter((x) => typeof x === "string" && x.trim().length > 2 && x.length < 60).slice(0, 3)
        : [];
      if (!suggestions.length) {
        const cat = PRICING[out.category] ? out.category : inferCategory(clean);
        const dernier = lastUser ? lastUser.content.toLowerCase() : "";
        const fache = /con|nul|putain|merde|abruti|idiot|arnaque|voleur/.test(dernier);
        suggestions = fache
          ? ["Parler à un humain", "Arrêter et être remboursé", "Expliquez-moi ce qui se passe"]
          : SUGGESTIONS_REPLI[cat] || SUGGESTIONS_REPLI.fallback;
      }
      const addon = lastUser ? detecterAvenant(lastUser.content, ctx.quote) : null;
      if (addon && out) out = { ...out, addon };
      const dejaDevis = Boolean(ctx.quote);
      const stage = out.stage === "quote" && !dejaDevis ? "quote" : "ask";
      const category = PRICING[out.category] ? out.category : "fallback";

      if (stage === "quote") {
        const p = PRICING[category];
        const lines = p.lines;
        const total = lines.reduce((s, l) => s + l.price, 0);
        return json(res, 200, {
          reply: nettoyerReply(out.reply || "Voilà ce que je propose.").slice(0, 500),
          stage,
          quote: { key: category, label: p.label, delay: p.delay, lines, total },
          addon: out.addon || null,
          suggestions,
        });
      }
      return json(res, 200, { reply: nettoyerReply(out.reply || "").slice(0, 500), stage, addon: out.addon || null, suggestions });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: "requête invalide" });
      console.error("chat error:", e.message);
      return json(res, 502, { error: "l'agent est momentanément indisponible" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`agent-api écoute sur ${PORT} (model ${MODEL}, clé ${KEY ? "ok" : "MANQUANTE"})`));
