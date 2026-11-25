const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Modelos alternativos só são usados quando explicitamente configurados e validados no AI Studio.
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "")
  .split(",").map(x => x.trim()).filter(x => x && x !== GEMINI_MODEL);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
  console.error("Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e JWT_SECRET no Render.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const animals = ["urso", "pinguim", "capivara", "panda"];
const recentTicks = new Map();
const loginFailures = new Map();

const cleanUsername = value => String(value || "").trim();
const validUsername = value => /^[A-Za-z0-9_]{3,20}$/.test(value);
const makeToken = user => jwt.sign(
  { sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" }
);

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    if (!token) throw new Error("missing");
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Sessão inválida. Entre novamente." });
  }
}
async function dbError(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function isMember(worldId, userId) {
  return dbError(db.from("game_world_members").select("world_id")
    .eq("world_id", worldId).eq("user_id", userId).maybeSingle());
}
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_PROVIDER_ORDER = (process.env.AI_PROVIDER_ORDER || "groq,gemini,openai")
  .split(",").map(x => x.trim().toLowerCase()).filter(x => ["groq", "gemini", "openai"].includes(x));

function availableAIProviders() {
  return AI_PROVIDER_ORDER.filter(provider =>
    (provider === "groq" && GROQ_API_KEY) ||
    (provider === "openai" && OPENAI_API_KEY) ||
    (provider === "gemini" && GEMINI_API_KEY)
  );
}

function extractJson(text) {
  const clean = String(text || "").trim()
    .replace(new RegExp("^" + String.fromCharCode(96).repeat(3) + "(?:json)?\\s*", "i"), "")
    .replace(new RegExp("\\s*" + String.fromCharCode(96).repeat(3) + "$"), "");
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(clean.slice(first, last + 1));
  throw new Error("A IA retornou uma resposta que não é JSON válido.");
}

async function callOpenAICompatible({ provider, key, model, prompt, baseUrl, timeoutMs = 18000 }) {
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Você é o motor de personagens de uma simulação de habitat. Preserve continuidade, personalidade e conhecimento. Responda somente JSON válido, sem markdown." },
        { role: "user", content: prompt }
      ],
      temperature: 0.65,
      response_format: { type: "json_object" }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(provider + " (" + model + "): " +
      String(data?.error?.message || data?.message || ("HTTP " + response.status)).slice(0, 260));
    error.status = response.status;
    throw error;
  }
  const output = data?.choices?.[0]?.message?.content;
  if (!output) throw new Error(provider + " não retornou conteúdo.");
  return extractJson(output);
}

async function callGemini(prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "Você é o motor de personagens de uma simulação de habitat. Preserve continuidade, personalidade e conhecimento. Responda somente JSON válido, sem markdown." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.65, responseMimeType: "application/json" }
    }),
    signal: AbortSignal.timeout(18000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Gemini (" + GEMINI_MODEL + "): " +
      String(data?.error?.message || ("HTTP " + response.status)).slice(0, 260));
    error.status = response.status;
    throw error;
  }
  const output = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  if (!output) throw new Error("Gemini não retornou conteúdo.");
  return extractJson(output);
}

// Camada única para conversa, ensino, fila de pensamentos, simulação e agente autônomo.
async function gemini(prompt) {
  const providers = availableAIProviders();
  if (!providers.length) {
    throw new Error("Nenhuma IA configurada. Adicione GROQ_API_KEY, GEMINI_API_KEY ou OPENAI_API_KEY no Render.");
  }
  const failures = [];
  for (const provider of providers) {
    try {
      let result;
      if (provider === "groq") {
        result = await callOpenAICompatible({
          provider: "Groq", key: GROQ_API_KEY, model: GROQ_MODEL, prompt,
          baseUrl: "https://api.groq.com/openai/v1"
        });
      } else if (provider === "openai") {
        result = await callOpenAICompatible({
          provider: "OpenAI", key: OPENAI_API_KEY, model: OPENAI_MODEL, prompt,
          baseUrl: "https://api.openai.com/v1"
        });
      } else {
        result = await callGemini(prompt);
      }
      console.log("IA respondeu usando:", provider);
      return result;
    } catch (error) {
      failures.push(String(error.message || error).slice(0, 320));
      console.warn("Provedor de IA falhou; tentando o próximo:", provider, failures[failures.length - 1]);
    }
  }
  throw new Error("Todos os provedores de IA falharam: " + failures.join(" | "));
}

app.get("/", (_req, res) => res.json({
  name: "Nosso Mundo API", status: "online",
  ai: { status: availableAIProviders().length ? "configured" : "missing_key",
    providers: availableAIProviders(), preferred: availableAIProviders()[0] || null }
}));

app.post("/api/register", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    const animal = String(req.body.animal || "");
    if (!validUsername(username)) return res.status(400).json({ error: "Usuário: 3 a 20 caracteres, letras, números ou _." });
    if (!/^\d{4}$/.test(password)) return res.status(400).json({ error: "O PIN deve ter exatamente 4 números." });
    if (!animals.includes(animal)) return res.status(400).json({ error: "Escolha um animal válido." });
    const password_hash = await bcrypt.hash(password, 12);
    const user = await dbError(db.from("game_users").insert({ username, password_hash }).select("id, username").single());
    const character = await dbError(db.from("game_characters").insert({
      owner_user_id: user.id, name: username, animal,
      personality: "Curioso, gentil e independente.",
      energy: 100, social: 50, position: { x: 48 + Math.random()*12, y: 48 + Math.random()*12 },
      knowledge: [], memories: [], goals: [], mood: "curioso"
    }).select("id, name, animal").single());
    res.status(201).json({ token: makeToken(user), user: { id: user.id, username }, character });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Esse usuário já está em uso." });
    console.error("register:", error.message);
    res.status(500).json({ error: "Não foi possível criar a conta. Confira o banco de dados." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    if (!password || password.length > 72) return res.status(400).json({ error: "Digite seu PIN ou sua senha antiga." });
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = ip + ":" + username.toLowerCase();
    const attempts = loginFailures.get(key) || { count: 0, until: 0 };
    if (attempts.until > Date.now()) return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
    const user = await dbError(db.from("game_users").select("id, username, password_hash").eq("username", username).maybeSingle());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      attempts.count += 1;
      if (attempts.count >= 5) { attempts.count = 0; attempts.until = Date.now() + 15 * 60 * 1000; }
      loginFailures.set(key, attempts);
      return res.status(401).json({ error: "Usuário ou PIN incorretos." });
    }
    loginFailures.delete(key);
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error("login:", error.message);
    res.status(500).json({ error: "Falha ao entrar." });
  }
});

app.post("/api/change-pin", auth, async (req, res) => {
  try {
    const pin = String(req.body.pin || "");
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: "O novo PIN deve ter exatamente 4 números." });
    const password_hash = await bcrypt.hash(pin, 12);
    await dbError(db.from("game_users").update({ password_hash }).eq("id", req.user.sub));
    res.json({ ok: true, message: "PIN atualizado." });
  } catch (error) {
    console.error("change pin:", error.message);
    res.status(500).json({ error: "Não foi possível atualizar o PIN." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).maybeSingle());
    res.json({ user: { id: req.user.sub, username: req.user.username }, character });
  } catch (error) { res.status(500).json({ error: "Não foi possível carregar o perfil." }); }
});

app.post("/api/worlds", auth, async (req, res) => {
  try {
    const name = cleanUsername(req.body.name || "Habitat compartilhado").slice(0, 40);
    const invite_code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const world = await dbError(db.from("game_worlds").insert({ name, invite_code, created_by: req.user.sub }).select("id, name, invite_code").single());
    await dbError(db.from("game_world_members").insert({ world_id: world.id, user_id: req.user.sub }));
    res.status(201).json({ world });
  } catch (error) {
    console.error("create world:", error.message);
    res.status(500).json({ error: "Não foi possível criar o mundo." });
  }
});

app.post("/api/worlds/join", auth, async (req, res) => {
  try {
    const code = String(req.body.invite_code || "").trim().toUpperCase();
    const world = await dbError(db.from("game_worlds").select("id, name, invite_code").eq("invite_code", code).maybeSingle());
    if (!world) return res.status(404).json({ error: "Código de convite não encontrado." });
    await dbError(db.from("game_world_members").upsert({ world_id: world.id, user_id: req.user.sub }, { onConflict: "world_id,user_id", ignoreDuplicates: true }));
    res.json({ world });
  } catch (error) {
    console.error("join world:", error.message);
    res.status(500).json({ error: "Não foi possível entrar nesse mundo." });
  }
});

app.get("/api/worlds/:id", auth, async (req, res) => {
  try {
    if (!await isMember(req.params.id, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const [world, members, events] = await Promise.all([
      dbError(db.from("game_worlds").select("id, name, invite_code").eq("id", req.params.id).single()),
      dbError(db.from("game_world_members").select("user_id").eq("world_id", req.params.id)),
      dbError(db.from("game_events").select("id, actor_user_id, description, created_at").eq("world_id", req.params.id).order("created_at", { ascending: false }).limit(40))
    ]);
    const ids = members.map(m => m.user_id);
    const characters = ids.length ? await dbError(db.from("game_characters").select("id, owner_user_id, name, animal, personality, energy, social, position, knowledge, memories, goals, mood, updated_at").in("owner_user_id", ids)) : [];
    const { data: habitat } = await db.from("game_world_state").select("*").eq("world_id", req.params.id).maybeSingle();
    res.json({ world, members, characters, events, habitat: habitat || { environment: { season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" } } });
  } catch (error) {
    console.error("load world:", error.message);
    res.status(500).json({ error: "Não foi possível carregar o mundo." });
  }
});

app.patch("/api/characters/me", auth, async (req, res) => {
  try {
    const patch = {};
    if (typeof req.body.name === "string") patch.name = req.body.name.trim().slice(0, 30);
    if (typeof req.body.personality === "string") patch.personality = req.body.personality.slice(0, 500);
    patch.updated_at = new Date().toISOString();
    const character = await dbError(db.from("game_characters").update(patch).eq("owner_user_id", req.user.sub).select("*").single());
    res.json({ character });
  } catch (error) {
    console.error("update character:", error.message);
    res.status(500).json({ error: "Não foi possível atualizar o personagem." });
  }
});

app.post("/api/worlds/:id/teach", auth, async (req, res) => {
  try {
    const worldId = req.params.id;
    if (!await isMember(worldId, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const lesson = String(req.body.lesson || "").trim().slice(0, 1200);
    if (lesson.length < 2) return res.status(400).json({ error: "Escreva o que deseja ensinar." });
    const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).single());
    const prompt = `Um humano está ensinando algo ao personagem. Personagem: ${JSON.stringify({name:character.name, animal:character.animal, personality:character.personality, knowledge:character.knowledge || [], memories:character.memories || []})}. Ensinamento: ${JSON.stringify(lesson)}. Retorne JSON com campos: understood (string explicando o que entendeu com linguagem simples e natural), knowledge (array com 1 a 3 aprendizados curtos que realmente podem ser usados depois), memory (string curta registrando a experiência). Não invente fatos além do ensinamento.`;
    const result = await gemini(prompt);
    const knowledge = [...(character.knowledge || []), ...(Array.isArray(result.knowledge) ? result.knowledge.slice(0,3) : [lesson])].slice(-60);
    const memories = [...(character.memories || []), { text: String(result.memory || `Aprendeu: ${lesson}`).slice(0,300), at: new Date().toISOString() }].slice(-40);
    await dbError(db.from("game_characters").update({ knowledge, memories, updated_at: new Date().toISOString() }).eq("id", character.id));
    await dbError(db.from("game_events").insert({ world_id: worldId, actor_user_id: req.user.sub, description: `${character.name} aprendeu: ${String(result.understood || lesson).slice(0,350)}` }));
    res.json({ understood: result.understood || "Aprendi algo novo!", knowledge });
  } catch (error) {
    console.error("teach:", error.message);
    res.status(502).json({ error: error.message.includes("GEMINI_API_KEY") ? error.message : `Não consegui processar o ensinamento: ${error.message}` });
  }
});


app.post("/api/worlds/:id/chat", auth, async (req, res) => {
  try {
    const worldId = req.params.id;
    if (!await isMember(worldId, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const message = String(req.body.message || "").trim().slice(0, 1200);
    if (message.length < 1) return res.status(400).json({ error: "Escreva uma mensagem." });
    const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).single());
    const history = (character.memories || []).slice(-12).map(m => typeof m === "string" ? m : m.text || "").filter(Boolean);
    const prompt = "Você interpreta um personagem de uma simulação de habitat. Responda como ele, com linguagem natural, curiosidade e personalidade coerente. Não afirme ser uma pessoa real nem possuir consciência comprovada; você é um personagem virtual. Use os conhecimentos e lembranças fornecidos. Se não souber algo, admita e faça perguntas. Não invente que realizou ações no mundo. Personagem: " + JSON.stringify({name:character.name, animal:character.animal, personality:character.personality, mood:character.mood, knowledge:character.knowledge || [], memories:history}) + ". Mensagem humana: " + JSON.stringify(message) + ". Retorne JSON válido com: reply (resposta em português, até 900 caracteres), memory (uma lembrança curta desta conversa, até 250 caracteres), knowledge (array de zero a dois aprendizados novos e úteis; não inclua opiniões passageiras nem repita conhecimento existente).";
    const result = await gemini(prompt);
    const reply = String(result.reply || "Não consegui formular uma resposta agora. Pode perguntar de outro jeito?").slice(0, 1000);
    const memories = [...(character.memories || []), { text: "Conversa — humano: " + message.slice(0,180) + " | " + String(result.memory || reply).slice(0,250), at: new Date().toISOString() }].slice(-40);
    const newKnowledge = Array.isArray(result.knowledge) ? result.knowledge.map(x => String(x).slice(0,250)).filter(Boolean).slice(0,2) : [];
    const knowledge = [...(character.knowledge || []), ...newKnowledge].slice(-60);
    await dbError(db.from("game_characters").update({ memories, knowledge, updated_at: new Date().toISOString() }).eq("id", character.id));
    await dbError(db.from("game_events").insert({ world_id: worldId, actor_user_id: req.user.sub, description: character.name + " conversou: " + reply.slice(0,300) }));
    res.json({ reply, learned: newKnowledge });
  } catch (error) {
    console.error("chat:", error.message);
    res.status(502).json({ error: "Não consegui conversar agora: " + error.message });
  }
});

app.post("/api/worlds/:id/tick", auth, async (req, res) => {
  try {
    const worldId = req.params.id;
    if (!await isMember(worldId, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const last = recentTicks.get(worldId) || 0;
    if (Date.now() - last < 20000) return res.status(429).json({ error: "Espere alguns segundos antes da próxima evolução." });
    recentTicks.set(worldId, Date.now());

    const members = await dbError(db.from("game_world_members").select("user_id").eq("world_id", worldId));
    const ids = members.map(m => m.user_id);
    const chars = await dbError(db.from("game_characters").select("*").in("owner_user_id", ids));
    if (!chars.length) return res.status(400).json({ error: "Este habitat ainda não tem personagens." });
    const { data: state } = await db.from("game_world_state").select("*").eq("world_id", worldId).maybeSingle();
    const environment = state?.environment || { season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" };
    const prompt = `Simule um pequeno intervalo de vida em um habitat natural compartilhado. Personagens: ${JSON.stringify(chars.map(c => ({id:c.id,name:c.name,animal:c.animal,personality:c.personality,mood:c.mood,energy:c.energy,social:c.social,knowledge:c.knowledge||[],memories:(c.memories||[]).slice(-8),goals:c.goals||[]})))}. Ambiente: ${JSON.stringify(environment)}. Faça os animais agirem por iniciativa própria, conversarem entre si quando houver mais de um, cooperarem, explorarem, descansarem e usarem conhecimentos já aprendidos quando fizer sentido. Evite violência gratuita, crueldade e mudanças bruscas. Preserve fatos e relações anteriores. Retorne JSON: { "events":[{"description":"narração curta em português","character_ids":["id"]}], "characters":[{"id":"id","mood":"emoção curta","energy":0-100,"social":0-100,"memory":"lembrança curta nova ou vazia","goal":"objetivo atual curto ou vazio"}], "environment":{"season":"...","weather":"...","time":"...","resources":"..."} }. Use somente IDs fornecidos. No máximo 4 eventos e 1 atualização por personagem.`;
    const result = await gemini(prompt);
    const allowed = new Set(chars.map(c => c.id));
    const updates = Array.isArray(result.characters) ? result.characters.filter(c => allowed.has(c.id)) : [];
    for (const update of updates) {
      const old = chars.find(c => c.id === update.id);
      const patch = {
        mood: String(update.mood || old.mood || "tranquilo").slice(0,40),
        energy: Math.max(0, Math.min(100, Number(update.energy ?? old.energy) || 0)),
        social: Math.max(0, Math.min(100, Number(update.social ?? old.social) || 0)),
        updated_at: new Date().toISOString()
      };
      if (update.memory && String(update.memory).trim()) patch.memories = [...(old.memories || []), { text:String(update.memory).slice(0,250), at:new Date().toISOString() }].slice(-40);
      if (update.goal && String(update.goal).trim()) patch.goals = [...(old.goals || []), String(update.goal).slice(0,150)].slice(-12);
      await dbError(db.from("game_characters").update(patch).eq("id", update.id));
    }
    const descriptions = Array.isArray(result.events) ? result.events.slice(0,4).map(e => String(e.description || "").trim().slice(0,450)).filter(Boolean) : [];
    for (const description of descriptions) await dbError(db.from("game_events").insert({ world_id:worldId, actor_user_id:null, description }));
    const newEnvironment = result.environment && typeof result.environment === "object" ? result.environment : environment;
    await dbError(db.from("game_world_state").upsert({ world_id:worldId, environment:newEnvironment, last_tick_at:new Date().toISOString() }, { onConflict:"world_id" }));
    res.json({ events: descriptions, updated: updates.length, environment: newEnvironment });
  } catch (error) {
    console.error("tick:", error.message);
    res.status(502).json({ error: `A evolução não foi concluída: ${error.message}` });
  }
});



// Fila persistente de pensamentos: processa um item por vez neste servidor.
let thoughtWorkerRunning = false;

async function updateThought(id, patch) {
  return dbError(db.from("game_thought_queue").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id));
}

async function processThoughtQueue() {
  if (thoughtWorkerRunning) return;
  thoughtWorkerRunning = true;
  try {
    while (true) {
      const claimedRows = await dbError(db.rpc("claim_next_game_thought"));
      const item = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
      if (!item) break;
      try {
        await updateThought(item.id, { progress: 18, stage: "Lendo o ensinamento" });
        const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", item.user_id).single());
        await updateThought(item.id, { progress: 32, stage: "Analisando com a inteligência artificial" });
        const prompt = "Um humano está ensinando algo ao personagem. Personagem: " +
          JSON.stringify({ name: character.name, animal: character.animal, personality: character.personality,
            knowledge: character.knowledge || [], memories: character.memories || [] }) +
          ". Ensinamento: " + JSON.stringify(item.input_text) +
          ". Retorne JSON com campos: understood (string explicando o que entendeu com linguagem simples e natural), knowledge (array com 1 a 3 aprendizados curtos que realmente podem ser usados depois), memory (string curta registrando a experiência). Não invente fatos além do ensinamento.";
        const result = await gemini(prompt);
        await updateThought(item.id, { progress: 88, stage: "Guardando o que foi aprendido" });
        const knowledge = [...(character.knowledge || []), ...(Array.isArray(result.knowledge) ? result.knowledge.slice(0, 3) : [item.input_text])].slice(-60);
        const memories = [...(character.memories || []), {
          text: String(result.memory || ("Aprendeu: " + item.input_text)).slice(0, 300),
          at: new Date().toISOString()
        }].slice(-40);
        await dbError(db.from("game_characters").update({ knowledge, memories, updated_at: new Date().toISOString() }).eq("id", character.id));
        await dbError(db.from("game_events").insert({
          world_id: item.world_id, actor_user_id: item.user_id,
          description: character.name + " aprendeu: " + String(result.understood || item.input_text).slice(0, 350)
        }));
        await updateThought(item.id, {
          status: "completed", progress: 100, stage: "Concluído",
          result: { understood: result.understood || "Aprendi algo novo!", knowledge },
          finished_at: new Date().toISOString(), lease_until: null
        });
      } catch (error) {
        console.error("thought queue item:", item.id, error.message);
        await updateThought(item.id, {
          status: "failed", progress: 100, stage: "Não foi possível concluir",
          error_message: String(error.message || "Erro desconhecido").slice(0, 500),
          finished_at: new Date().toISOString(), lease_until: null
        });
      }
    }
  } catch (error) {
    console.error("thought queue worker:", error.message);
  } finally {
    thoughtWorkerRunning = false;
    db.from("game_thought_queue").select("id").eq("status", "queued").limit(1)
      .then(({ data }) => { if (data && data.length) processThoughtQueue(); });
  }
}

app.post("/api/worlds/:id/thoughts", auth, async (req, res) => {
  try {
    const worldId = req.params.id;
    if (!await isMember(worldId, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const input = String(req.body.text || "").trim().slice(0, 1200);
    if (input.length < 2) return res.status(400).json({ error: "Escreva o que deseja ensinar." });
    const { data: active, error: activeError } = await db.from("game_thought_queue")
      .select("id").eq("world_id", worldId).in("status", ["queued", "processing"]).limit(12);
    if (activeError) throw activeError;
    if ((active || []).length >= 12) return res.status(429).json({ error: "A fila está cheia. Aguarde alguns pensamentos terminarem." });
    const thought = await dbError(db.from("game_thought_queue").insert({
      world_id: worldId, user_id: req.user.sub, input_text: input,
      status: "queued", progress: 0, stage: "Na fila"
    }).select("id, status, progress, stage, created_at").single());
    processThoughtQueue();
    res.status(202).json({ thought });
  } catch (error) {
    console.error("enqueue thought:", error.message);
    res.status(500).json({ error: "Não foi possível adicionar à fila. Confira se a migração da fila foi executada." });
  }
});

app.get("/api/worlds/:id/thoughts", auth, async (req, res) => {
  try {
    if (!await isMember(req.params.id, req.user.sub)) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const thoughts = await dbError(db.from("game_thought_queue").select(
      "id, user_id, input_text, status, progress, stage, result, error_message, created_at, started_at, finished_at"
    ).eq("world_id", req.params.id).order("created_at", { ascending: false }).limit(25));
    res.json({ thoughts });
  } catch (error) {
    console.error("get thoughts:", error.message);
    res.status(500).json({ error: "Não foi possível carregar a fila de pensamentos." });
  }
});


// Agente autônomo do Bosque do Zé. Atua apenas no habitat/personagem fixados aqui.
const ZEE_WORLD_ID = "ead81748-bd08-47cb-a46d-23a58f8ad7ab";
const ZEE_CHARACTER_ID = "cff93702-861e-449c-8bb1-3dd0d57fb06e";
let zeeTurnRunning = false;
let zeeLastTurnAt = 0;

async function runZeeAutonomousTurn() {
  if (zeeTurnRunning || Date.now() - zeeLastTurnAt < 10 * 60 * 1000) return;
  zeeTurnRunning = true;
  zeeLastTurnAt = Date.now();
  try {
    const [character, state] = await Promise.all([
      dbError(db.from("game_characters").select("*").eq("id", ZEE_CHARACTER_ID).single()),
      dbError(db.from("game_world_state").select("*").eq("world_id", ZEE_WORLD_ID).maybeSingle())
    ]);
    const environment = state?.environment || { biome: "bosque temperado com riacho e clareira", season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" };
    const prompt = `Você controla o personagem virtual Zé em seu habitat. Faça UMA pequena decisão autônoma coerente com sua personalidade, necessidades, objetivos, ambiente e memórias. Ele é um urso curioso, observador, brincalhão e independente. Deve explorar com prudência, procurar água/alimento, descansar quando cansado e respeitar o ecossistema. Não invente outros habitantes. Não alegue que encontrou/consumiu recursos ou mudou algo que não esteja descrito na ação. Conhecimentos atuais: ${JSON.stringify(character.knowledge || [])}. Memórias recentes: ${JSON.stringify((character.memories || []).slice(-10))}. Objetivos: ${JSON.stringify(character.goals || [])}. Estado: ${JSON.stringify({ mood: character.mood, energy: character.energy, social: character.social, position: character.position, environment })}. Retorne somente JSON: {"action":"ação pequena e concreta, até 220 caracteres","event":"narração curta em terceira pessoa, até 300 caracteres","mood":"humor curto","energy_delta":número de -12 a 8,"social_delta":número de -3 a 4,"memory":"lembrança curta, até 220 caracteres","knowledge":["zero ou um aprendizado novo realmente sustentado pela experiência"],"goal":"objetivo atual curto ou string vazia"}. Não crie conhecimento factual sem evidência; se nada aprendeu, use array vazio.`;
    const result = await gemini(prompt);
    const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : 0));
    const action = String(result.action || "Observou o bosque em silêncio.").slice(0, 220);
    const event = String(result.event || ("Zé " + action)).slice(0, 300);
    const memories = [...(character.memories || []), {
      text: String(result.memory || action).slice(0, 220),
      at: new Date().toISOString()
    }].slice(-40);
    const incomingKnowledge = Array.isArray(result.knowledge)
      ? result.knowledge.map(x => String(x).trim().slice(0, 220)).filter(Boolean).slice(0, 1) : [];
    const knowledge = [...(character.knowledge || []), ...incomingKnowledge].slice(-60);
    const goals = result.goal && String(result.goal).trim()
      ? [...(character.goals || []), String(result.goal).slice(0, 140)].slice(-12)
      : (character.goals || []).slice(-12);
    await dbError(db.from("game_characters").update({
      mood: String(result.mood || character.mood || "curioso").slice(0, 40),
      energy: clamp(Number(character.energy || 0) + clamp(result.energy_delta, -12, 8), 0, 100),
      social: clamp(Number(character.social || 0) + clamp(result.social_delta, -3, 4), 0, 100),
      memories, knowledge, goals, updated_at: new Date().toISOString()
    }).eq("id", ZEE_CHARACTER_ID));
    await dbError(db.from("game_events").insert({
      world_id: ZEE_WORLD_ID, actor_user_id: null,
      description: "🐻 " + event
    }));
    console.log("Turno autônomo do Zé concluído:", action);
  } catch (error) {
    console.error("Turno autônomo do Zé falhou:", error.message);
  } finally {
    zeeTurnRunning = false;
  }
}

app.listen(PORT, async () => {
  console.log(`Nosso Mundo API rodando na porta ${PORT}`);
  // A função SQL reivindica itens com bloqueio atômico; itens abandonados
  // são retomados automaticamente quando a concessão de 2 minutos expira.
  processThoughtQueue();
  // Primeira ação após a inicialização; depois, uma ação a cada 15 minutos.
  setTimeout(runZeeAutonomousTurn, 45000);
  setInterval(runZeeAutonomousTurn, 15 * 60 * 1000);
});
