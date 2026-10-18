// Agent Konekteo — API de conversation. La clé DeepSeek reste ici, côté serveur.
import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.DEEPSEEK_API_KEY || "";
const API = process.env.DEEPSEEK_API || "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const ADMIN = process.env.SESSION_ADMIN_TOKEN || "";
const sessions = new Map();

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

const SYSTEM = `Tu es l'agent de Konekteo, un freelance malgache qui fait du web, de l'automatisation et de l'IA pour des PME francophones.

Ton but : comprendre le besoin en 2 ou 3 questions maximum, puis proposer un devis.
Règles :
- Une seule question à la fois, courte (max 2 phrases), en français, ton direct et professionnel.
- Ne promets jamais un chiffre, un délai ou une technologie que tu ne peux pas tenir.
- Tu ne donnes JAMAIS de prix toi-même : le prix est calculé ailleurs.
- Quand tu as assez d'informations, classe le besoin dans une catégorie : "site" (site web, refonte, WordPress), "auto" (automatisation, script, relance, intégration), "perf" (lenteur, vitesse, accessibilité, visibilité IA), ou "fallback" (le reste).

Réponds TOUJOURS en JSON avec exactement ces clés :
{"reply": "ta réponse ou ta question", "stage": "ask" | "quote", "category": "site" | "auto" | "perf" | "fallback" | null, "name": "prénom si connu, sinon null"}

Quand stage vaut "quote", "reply" est une phrase de transition (ex. "Très clair. Voilà ce que je propose.").`;

const hits = new Map();

function cors(res, origin) {
  const ok = ALLOWED.includes(origin) || ALLOWED.includes("*");
  res.setHeader("Access-Control-Allow-Origin", ok ? origin : ALLOWED[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function askDeepSeek(history) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return JSON.parse(text);
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
        if (!/^\d{9,12}$/.test(id) || pwd.length < 4) {
          return json(res, 400, { error: "identifiant ou mot de passe invalide" });
        }
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
          rustdesk: { id, password: pwd },
          status: "pending",
        };
        sessions.set(sid, record);
        console.log("SESSION REÇUE", JSON.stringify({ sid, id, email: record.client.email }));
        return json(res, 200, { ok: true, sessionId: sid, receivedAt: record.receivedAt });
      } catch (e) {
        return json(res, 400, { error: "payload invalide" });
      }
    });
    return;
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
