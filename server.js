const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
  console.error("Configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e JWT_SECRET nas Environment Variables.");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const animals = ["urso", "pinguim", "capivara", "panda"];
const cleanUsername = (value) => String(value || "").trim();
const validUsername = (value) => /^[A-Za-z0-9_]{3,20}$/.test(value);
const makeToken = (user) => jwt.sign(
  { sub: user.id, username: user.username },
  JWT_SECRET,
  { expiresIn: "30d" }
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

app.get("/", (_req, res) => {
  res.json({ name: "Nosso Mundo API", status: "online" });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    const animal = String(req.body.animal || "");

    if (!validUsername(username)) {
      return res.status(400).json({ error: "O usuário deve ter de 3 a 20 caracteres: letras, números ou _." });
    }
    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: "A senha deve ter entre 8 e 72 caracteres." });
    }
    if (!animals.includes(animal)) {
      return res.status(400).json({ error: "Escolha um animal válido." });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const user = await dbError(
      db.from("game_users")
        .insert({ username, password_hash })
        .select("id, username")
        .single()
    );
    const character = await dbError(
      db.from("game_characters")
        .insert({
          owner_user_id: user.id,
          name: username,
          animal,
          personality: "Curioso, sociável e independente.",
          energy: 100,
          social: 50,
          position: { x: 120, y: 120 }
        })
        .select("id, name, animal")
        .single()
    );
    res.status(201).json({
      token: makeToken(user),
      user: { id: user.id, username: user.username },
      character
    });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Esse nome de usuário já está em uso." });
    console.error("register:", error.message);
    res.status(500).json({ error: "Não foi possível criar a conta. Confira a configuração do banco." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.password || "");
    const user = await dbError(
      db.from("game_users").select("id, username, password_hash").eq("username", username).maybeSingle()
    );
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Usuário ou senha incorretos." });
    }
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error("login:", error.message);
    res.status(500).json({ error: "Falha ao entrar. Tente novamente." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const character = await dbError(
      db.from("game_characters").select("*").eq("owner_user_id", req.user.sub).maybeSingle()
    );
    res.json({ user: { id: req.user.sub, username: req.user.username }, character });
  } catch (error) {
    console.error("me:", error.message);
    res.status(500).json({ error: "Não foi possível carregar seu perfil." });
  }
});

app.post("/api/worlds", auth, async (req, res) => {
  try {
    const name = cleanUsername(req.body.name || "Mundo compartilhado").slice(0, 40);
    const invite_code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const world = await dbError(
      db.from("game_worlds").insert({ name, invite_code, created_by: req.user.sub })
        .select("id, name, invite_code").single()
    );
    await dbError(
      db.from("game_world_members").insert({ world_id: world.id, user_id: req.user.sub })
    );
    res.status(201).json({ world });
  } catch (error) {
    console.error("create world:", error.message);
    res.status(500).json({ error: "Não foi possível criar o mundo." });
  }
});

app.post("/api/worlds/join", auth, async (req, res) => {
  try {
    const code = String(req.body.invite_code || "").trim().toUpperCase();
    const world = await dbError(
      db.from("game_worlds").select("id, name, invite_code").eq("invite_code", code).maybeSingle()
    );
    if (!world) return res.status(404).json({ error: "Código de convite não encontrado." });
    await dbError(
      db.from("game_world_members").upsert(
        { world_id: world.id, user_id: req.user.sub },
        { onConflict: "world_id,user_id", ignoreDuplicates: true }
      )
    );
    res.json({ world });
  } catch (error) {
    console.error("join world:", error.message);
    res.status(500).json({ error: "Não foi possível entrar nesse mundo." });
  }
});

app.get("/api/worlds/:id", auth, async (req, res) => {
  try {
    const membership = await dbError(
      db.from("game_world_members").select("world_id")
        .eq("world_id", req.params.id).eq("user_id", req.user.sub).maybeSingle()
    );
    if (!membership) return res.status(403).json({ error: "Você não faz parte deste mundo." });

    const [world, members, characters, events] = await Promise.all([
      dbError(db.from("game_worlds").select("id, name, invite_code").eq("id", req.params.id).single()),
      dbError(db.from("game_world_members").select("user_id").eq("world_id", req.params.id)),
      dbError(db.from("game_characters").select("id, owner_user_id, name, animal, personality, energy, social, position, updated_at")
        .in("owner_user_id", (await dbError(db.from("game_world_members").select("user_id").eq("world_id", req.params.id))).map(x => x.user_id))),
      dbError(db.from("game_events").select("id, actor_user_id, description, created_at")
        .eq("world_id", req.params.id).order("created_at", { ascending: false }).limit(50))
    ]);
    res.json({ world, members, characters, events });
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
    if (req.body.position && Number.isFinite(req.body.position.x) && Number.isFinite(req.body.position.y)) {
      patch.position = { x: Math.max(0, Math.min(2000, req.body.position.x)), y: Math.max(0, Math.min(2000, req.body.position.y)) };
    }
    patch.updated_at = new Date().toISOString();
    const character = await dbError(
      db.from("game_characters").update(patch).eq("owner_user_id", req.user.sub)
        .select("id, name, animal, personality, position, energy, social").single()
    );
    res.json({ character });
  } catch (error) {
    console.error("update character:", error.message);
    res.status(500).json({ error: "Não foi possível atualizar o personagem." });
  }
});

app.post("/api/worlds/:id/events", auth, async (req, res) => {
  try {
    const membership = await dbError(
      db.from("game_world_members").select("world_id")
        .eq("world_id", req.params.id).eq("user_id", req.user.sub).maybeSingle()
    );
    if (!membership) return res.status(403).json({ error: "Você não faz parte deste mundo." });
    const description = String(req.body.description || "").trim().slice(0, 500);
    if (!description) return res.status(400).json({ error: "Escreva uma descrição." });
    const event = await dbError(
      db.from("game_events").insert({
        world_id: req.params.id, actor_user_id: req.user.sub, description
      }).select("*").single()
    );
    res.status(201).json({ event });
  } catch (error) {
    console.error("event:", error.message);
    res.status(500).json({ error: "Não foi possível salvar o acontecimento." });
  }
});

app.listen(PORT, () => console.log(`Nosso Mundo API rodando na porta ${PORT}`));
