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
async function getMyCharacter(userId) {
  return dbError(db.from("game_characters").select("*").eq("owner_user_id", userId).single());
}
async function isPresent(worldId, userId) {
  const character = await getMyCharacter(userId);
  return character && character.current_world_id === worldId ? character : null;
}
async function getSharedKnowledge(worldId, limit = 25) {
  return dbError(db.from("game_shared_knowledge")
    .select("source_character_name, kind, content, created_at")
    .eq("source_world_id", worldId)
    .order("created_at", { ascending: false }).limit(limit));
}
async function publishSharedKnowledge({ worldId, character, userId, content, kind = "lesson" }) {
  const text = String(content || "").trim().slice(0, 1200);
  if (text.length < 2) return;
  await dbError(db.from("game_shared_knowledge").insert({
    source_world_id: worldId, source_character_id: character?.id || null,
    source_character_name: character?.name || "Habitante",
    source_user_id: userId || null, kind, content: text
  }));
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
        { role: "system", content: "Você é o motor de personagens de uma simulação de habitat. Preserve continuidade, personalidade e conhecimento. Responda somente JSON válido, sem markdown. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio." },
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
      systemInstruction: { parts: [{ text: "Você é o motor de personagens de uma simulação de habitat. Preserve continuidade, personalidade e conhecimento. Responda somente JSON válido, sem markdown. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio." }] },
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

// Camada única de IA com circuit breaker: provedores com erro de cota/chave
// ficam temporariamente em pausa para evitar chamadas inúteis e acelerar o fallback.
const aiProviderCooldowns = new Map();
const aiProviderStats = new Map();

function providerCooldownMs(error) {
  const status = Number(error && error.status);
  const message = String(error && error.message || "").toLowerCase();
  if (status === 429 || /quota|rate.?limit|resource_exhausted|too many requests/.test(message)) return 5 * 60 * 1000;
  if (status === 401 || status === 403 || /invalid api key|unauthorized|permission denied/.test(message)) return 15 * 60 * 1000;
  if (status === 404 || /model.*not found|not found.*model|unsupported model/.test(message)) return 30 * 60 * 1000;
  return 20 * 1000;
}

function getAIStatus() {
  const now = Date.now();
  return {
    status: availableAIProviders().length ? "configured" : "missing_key",
    preferred: availableAIProviders().find(p => (aiProviderCooldowns.get(p) || 0) <= now) || null,
    providers: AI_PROVIDER_ORDER.map(provider => ({
      name: provider,
      configured: availableAIProviders().includes(provider),
      coolingDown: (aiProviderCooldowns.get(provider) || 0) > now,
      retryInSeconds: Math.max(0, Math.ceil(((aiProviderCooldowns.get(provider) || 0) - now) / 1000)),
      successes: (aiProviderStats.get(provider) || {}).successes || 0,
      failures: (aiProviderStats.get(provider) || {}).failures || 0
    }))
  };
}

async function gemini(prompt) {
  const providers = availableAIProviders();
  if (!providers.length) {
    throw new Error("Nenhuma IA configurada. Adicione GROQ_API_KEY, GEMINI_API_KEY ou OPENAI_API_KEY no Render.");
  }
  const failures = [];
  const now = Date.now();
  const ready = providers.filter(provider => (aiProviderCooldowns.get(provider) || 0) <= now);
  if (!ready.length) {
    const nextRetry = Math.min(...providers.map(provider => aiProviderCooldowns.get(provider) || now));
    const seconds = Math.max(1, Math.ceil((nextRetry - now) / 1000));
    throw new Error("Todos os provedores configurados estão temporariamente em pausa. Nova tentativa em aproximadamente " + seconds + "s.");
  }
  for (const provider of ready) {
    try {
      let result;
      if (provider === "groq") {
        result = await callOpenAICompatible({
          provider: "Groq", key: GROQ_API_KEY, model: GROQ_MODEL, prompt,
          baseUrl: "https://api.groq.com/openai/v1", timeoutMs: 12000
        });
      } else if (provider === "openai") {
        result = await callOpenAICompatible({
          provider: "OpenAI", key: OPENAI_API_KEY, model: OPENAI_MODEL, prompt,
          baseUrl: "https://api.openai.com/v1", timeoutMs: 15000
        });
      } else {
        result = await callGemini(prompt);
      }
      aiProviderCooldowns.delete(provider);
      const stats = aiProviderStats.get(provider) || { successes: 0, failures: 0 };
      stats.successes += 1;
      aiProviderStats.set(provider, stats);
      console.log("IA respondeu usando:", provider);
      return result;
    } catch (error) {
      const cooldown = providerCooldownMs(error);
      aiProviderCooldowns.set(provider, Date.now() + cooldown);
      const stats = aiProviderStats.get(provider) || { successes: 0, failures: 0 };
      stats.failures += 1;
      aiProviderStats.set(provider, stats);
      const detail = String(error.message || error).slice(0, 280);
      failures.push(provider + ": " + detail);
      console.warn("Provedor em pausa por " + Math.ceil(cooldown / 1000) + "s:", provider, detail);
    }
  }
  throw new Error("Nenhum provedor de IA respondeu. " + failures.join(" | "));
}

app.get("/", (_req, res) => res.json({
  name: "Nosso Mundo API", status: "online", ai: getAIStatus()
}));
app.get("/healthz", (_req, res) => res.json({
  ok: true, service: "nosso-mundo-server", ai: getAIStatus(),
  timestamp: new Date().toISOString()
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
      energy: 100, social: 50, position: { x: 600, y: 400 },
      knowledge: [], memories: [], goals: [], mood: "curioso"
    }).select("*").single());
    const invite_code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const home = await dbError(db.from("game_worlds").insert({
      name: "Habitat de " + username, invite_code, created_by: user.id
    }).select("id, name, invite_code").single());
    await dbError(db.from("game_world_members").insert({ world_id: home.id, user_id: user.id }));
    await dbError(db.from("game_characters").update({
      home_world_id: home.id, current_world_id: home.id
    }).eq("id", character.id));
    await dbError(db.from("game_world_state").upsert({
      world_id: home.id, environment: { biome: "bosque acolhedor", season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" }
    }, { onConflict: "world_id" }));
    character.home_world_id = home.id; character.current_world_id = home.id;
    res.status(201).json({ token: makeToken(user), user: { id: user.id, username }, character, world: home });
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
    const character = await getMyCharacter(req.user.sub);
    if (!character.home_world_id) {
      const world = await dbError(db.from("game_worlds").insert({ name, invite_code, created_by: req.user.sub }).select("id, name, invite_code").single());
      await dbError(db.from("game_world_members").upsert({ world_id: world.id, user_id: req.user.sub }, { onConflict: "world_id,user_id" }));
      await dbError(db.from("game_characters").update({ home_world_id: world.id, current_world_id: world.id }).eq("id", character.id));
      return res.status(201).json({ world });
    }
    const world = await dbError(db.from("game_worlds").insert({ name, invite_code, created_by: req.user.sub }).select("id, name, invite_code").single());
    await dbError(db.from("game_world_members").upsert({ world_id: world.id, user_id: req.user.sub }, { onConflict: "world_id,user_id" }));
    await dbError(db.from("game_characters").update({ current_world_id: world.id }).eq("id", character.id));
    await dbError(db.from("game_habitat_visits").insert({ character_id: character.id, world_id: world.id }));
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
    const character = await getMyCharacter(req.user.sub);
    if (character.current_world_id && character.current_world_id !== character.home_world_id) {
      await dbError(db.from("game_habitat_visits").update({ exited_at: new Date().toISOString() })
        .eq("character_id", character.id).eq("world_id", character.current_world_id).is("exited_at", null));
    }
    await dbError(db.from("game_world_members").upsert({ world_id: world.id, user_id: req.user.sub }, { onConflict: "world_id,user_id", ignoreDuplicates: true }));
    if (character.current_world_id !== world.id) {
      await dbError(db.from("game_habitat_visits").insert({ character_id: character.id, world_id: world.id }));
      await dbError(db.from("game_characters").update({ current_world_id: world.id, position: { x: 600, y: 400 } }).eq("id", character.id));
    }
    res.json({ world, home_world_id: character.home_world_id, current_world_id: world.id });
  } catch (error) {
    console.error("join world:", error.message);
    res.status(500).json({ error: "Não foi possível entrar nesse mundo." });
  }
});

app.get("/api/worlds/:id", auth, async (req, res) => {
  try {
    const own = await isPresent(req.params.id, req.user.sub);
    if (!own) return res.status(403).json({ error: "Você não está neste habitat. Use o código para visitá-lo." });
    const [world, characters, events] = await Promise.all([
      dbError(db.from("game_worlds").select("id, name, invite_code").eq("id", req.params.id).single()),
      dbError(db.from("game_characters").select("id, owner_user_id, name, animal, personality, energy, social, position, knowledge, memories, goals, mood, updated_at, home_world_id, current_world_id").eq("current_world_id", req.params.id)),
      dbError(db.from("game_events").select("id, actor_user_id, description, created_at").eq("world_id", req.params.id).order("created_at", { ascending: false }).limit(40))
    ]);
    const ids = characters.map(c => c.id).sort();
    for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++) {
      const a=ids[i], b=ids[j];
      const { data: found, error: findError } = await db.from("game_character_encounters").select("id").eq("world_id",req.params.id).eq("character_a_id",a).eq("character_b_id",b).maybeSingle();
      if (findError) throw findError;
      if (found) await dbError(db.from("game_character_encounters").update({last_met_at:new Date().toISOString()}).eq("id",found.id));
      else await dbError(db.from("game_character_encounters").insert({world_id:req.params.id,character_a_id:a,character_b_id:b}));
    }
    const { data: habitat } = await db.from("game_world_state").select("*").eq("world_id", req.params.id).maybeSingle();
    const home = await dbError(db.from("game_worlds").select("id,name,invite_code").eq("id",own.home_world_id).maybeSingle());
    res.json({ world, home, characters, events, habitat: habitat || { environment: { season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" } } });
  } catch (error) {
    console.error("load world:", error.message);
    res.status(500).json({ error: "Não foi possível carregar o mundo." });
  }
});

app.post("/api/worlds/return-home", auth, async (req,res) => {
  try {
    const character = await getMyCharacter(req.user.sub);
    if (!character.home_world_id) return res.status(400).json({error:"Você ainda não tem um habitat de origem."});
    if (character.current_world_id && character.current_world_id !== character.home_world_id) {
      await dbError(db.from("game_habitat_visits").update({exited_at:new Date().toISOString()})
        .eq("character_id",character.id).eq("world_id",character.current_world_id).is("exited_at",null));
    }
    await dbError(db.from("game_characters").update({current_world_id:character.home_world_id,position:{x:600,y:400}}).eq("id",character.id));
    res.json({world_id:character.home_world_id});
  } catch(error) { console.error("return home:",error.message); res.status(500).json({error:"Não foi possível voltar para casa."}); }
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
    if (!await isPresent(worldId, req.user.sub)) return res.status(403).json({ error: "Você precisa estar neste habitat para fazer isso." });
    const lesson = String(req.body.lesson || "").trim().slice(0, 1200);
    if (lesson.length < 2) return res.status(400).json({ error: "Escreva o que deseja ensinar." });
    const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).single());
    const prompt = `Um humano está ensinando algo ao personagem. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio. Personagem: ${JSON.stringify({name:character.name, animal:character.animal, personality:character.personality, knowledge:character.knowledge || [], memories:character.memories || []})}. Ensinamento: ${JSON.stringify(lesson)}. Retorne JSON com campos: understood (string explicando o que entendeu com linguagem simples e natural), knowledge (array com 1 a 3 aprendizados curtos que realmente podem ser usados depois), memory (string curta registrando a experiência). Não invente fatos além do ensinamento.`;
    const result = await gemini(prompt);
    const knowledge = [...(character.knowledge || []), ...(Array.isArray(result.knowledge) ? result.knowledge.slice(0,3) : [lesson])].slice(-60);
    const memories = [...(character.memories || []), { text: String(result.memory || `Aprendeu: ${lesson}`).slice(0,300), at: new Date().toISOString() }].slice(-40);
    await dbError(db.from("game_characters").update({ knowledge, memories, updated_at: new Date().toISOString() }).eq("id", character.id));
    await publishSharedKnowledge({ worldId, character, userId: req.user.sub, content: lesson, kind: "lesson" });
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
    if (!await isPresent(worldId, req.user.sub)) return res.status(403).json({ error: "Você precisa estar neste habitat para fazer isso." });
    const message = String(req.body.message || "").trim().slice(0, 1200);
    if (message.length < 1) return res.status(400).json({ error: "Escreva uma mensagem." });
    const character = await dbError(db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).single());
    const history = (character.memories || []).slice(-12).map(m => typeof m === "string" ? m : m.text || "").filter(Boolean);
    const shared = await getSharedKnowledge(worldId, 25);
    const prompt = "Interprete este habitante como um indivíduo com identidade, história, necessidades, emoções e curiosidade próprias. Fale naturalmente em primeira pessoa, como quem vive neste habitat. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio. NÃO diga espontaneamente que é IA, personagem virtual, simulação ou que não é uma pessoa real; isso quebra a conversa. Não alegue consciência ou capacidades sobrenaturais. Use suas próprias lembranças e conhecimentos; diferencie o que viveu, o que lhe ensinaram e o que ouviu de outros habitantes. Conhecimentos coletivos são relatos recebidos, não experiências pessoais: você pode dizer quem ensinou e manter dúvida razoável. Não invente vivências. Se não souber, diga que não sabe e pergunte. Personagem: " + JSON.stringify({name:character.name, animal:character.animal, personality:character.personality, mood:character.mood, knowledge:character.knowledge || [], memories:history, shared_experiences:shared}) + ". Mensagem: " + JSON.stringify(message) + ". Retorne JSON válido com: reply (resposta em português, até 900 caracteres), memory (lembrança pessoal curta desta conversa, até 250 caracteres), knowledge (array de zero a dois aprendizados pessoais novos e úteis; não repita itens existentes).";
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
    if (!await isPresent(worldId, req.user.sub)) return res.status(403).json({ error: "Você precisa estar neste habitat para fazer isso." });
    const last = recentTicks.get(worldId) || 0;
    if (Date.now() - last < 20000) return res.status(429).json({ error: "Espere alguns segundos antes da próxima evolução." });
    recentTicks.set(worldId, Date.now());

    const chars = await dbError(db.from("game_characters").select("*").eq("current_world_id", worldId));
    if (!chars.length) return res.status(400).json({ error: "Este habitat ainda não tem personagens." });
    const { data: state } = await db.from("game_world_state").select("*").eq("world_id", worldId).maybeSingle();
    const environment = state?.environment || { season: "primavera", weather: "ensolarado", time: "manhã", resources: "abundantes" };
    const shared = await getSharedKnowledge(worldId, 25);
    const prompt = `Simule um pequeno intervalo de vida em um habitat natural compartilhado. Os habitantes podem compartilhar conhecimentos coletivos como relatos de outros lugares, sem fingir que viveram essas experiências. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio. Memória coletiva recente: ${JSON.stringify(shared)}. Personagens: ${JSON.stringify(chars.map(c => ({id:c.id,name:c.name,animal:c.animal,personality:c.personality,mood:c.mood,energy:c.energy,social:c.social,knowledge:c.knowledge||[],memories:(c.memories||[]).slice(-8),goals:c.goals||[]})))}. Ambiente: ${JSON.stringify(environment)}. Faça os animais agirem por iniciativa própria, conversarem entre si quando houver mais de um, cooperarem, explorarem, descansarem e usarem conhecimentos já aprendidos quando fizer sentido. Evite violência gratuita, crueldade e mudanças bruscas. Preserve fatos e relações anteriores. Retorne JSON: { "events":[{"description":"narração curta em português","character_ids":["id"]}], "characters":[{"id":"id","mood":"emoção curta","energy":0-100,"social":0-100,"memory":"lembrança curta nova ou vazia","goal":"objetivo atual curto ou vazio"}], "environment":{"season":"...","weather":"...","time":"...","resources":"..."} }. Use somente IDs fornecidos. No máximo 4 eventos e 1 atualização por personagem.`;
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
      if (update.memory && String(update.memory).trim()) {
        await publishSharedKnowledge({ worldId, character: old, userId: old.owner_user_id, content: String(update.memory).slice(0, 1200), kind: "experience" });
      }
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
        const prompt = "Um humano está ensinando algo ao personagem. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio. Personagem: " +
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
        await publishSharedKnowledge({ worldId: item.world_id, character, userId: item.user_id, content: item.input_text, kind: "lesson" });
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
    if (!await isPresent(worldId, req.user.sub)) return res.status(403).json({ error: "Você precisa estar neste habitat para fazer isso." });
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
    if (!await isPresent(req.params.id, req.user.sub)) return res.status(403).json({ error: "Você precisa estar neste habitat para fazer isso." });
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
    const prompt = `Você controla o personagem virtual Zé em seu habitat. Faça UMA pequena decisão autônoma coerente com sua personalidade, necessidades, objetivos, ambiente e memórias. REGRA DE CONHECIMENTO DO NOSSO MUNDO: o modelo pode possuir conhecimento geral próprio, mas NÃO deve usá-lo para responder como se o habitante soubesse. Para fatos sobre pessoas, lugares, história, ciência, esportes ou qualquer assunto externo ao habitat, use exclusivamente: (1) conhecimento individual listado no personagem, (2) memórias individuais que contenham explicitamente o fato, (3) ensinamentos/relatos presentes na memória coletiva fornecida, ou (4) informação que o interlocutor acabou de fornecer nesta mensagem. Se não houver apoio explícito nessas fontes, o habitante deve admitir que não sabe, demonstrar curiosidade e perguntar; nunca completar lacunas com conhecimento pré-treinado, pesquisa implícita, palpites ou invenções. Diferencie claramente "eu aprendi", "me contaram agora" e "eu vivi". Não transforme uma resposta recém-gerada em conhecimento prévio. Ele é um urso curioso, observador, brincalhão e independente. Deve explorar com prudência, procurar água/alimento, descansar quando cansado e respeitar o ecossistema. Não invente outros habitantes. Não alegue que encontrou/consumiu recursos ou mudou algo que não esteja descrito na ação. Conhecimentos atuais: ${JSON.stringify(character.knowledge || [])}. Memórias recentes: ${JSON.stringify((character.memories || []).slice(-10))}. Objetivos: ${JSON.stringify(character.goals || [])}. Estado: ${JSON.stringify({ mood: character.mood, energy: character.energy, social: character.social, position: character.position, environment })}. Retorne somente JSON: {"action":"ação pequena e concreta, até 220 caracteres","event":"narração curta em terceira pessoa, até 300 caracteres","mood":"humor curto","energy_delta":número de -12 a 8,"social_delta":número de -3 a 4,"memory":"lembrança curta, até 220 caracteres","knowledge":["zero ou um aprendizado novo realmente sustentado pela experiência"],"goal":"objetivo atual curto ou string vazia"}. Não crie conhecimento factual sem evidência; se nada aprendeu, use array vazio.`;
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
    if (result.memory && String(result.memory).trim()) {
      await publishSharedKnowledge({ worldId: ZEE_WORLD_ID, character, userId: null, content: String(result.memory).slice(0, 1200), kind: "experience" });
    }
    for (const learned of incomingKnowledge) {
      await publishSharedKnowledge({ worldId: ZEE_WORLD_ID, character, userId: null, content: learned, kind: "discovery" });
    }
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
