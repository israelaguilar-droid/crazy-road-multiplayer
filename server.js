// server.js
// Crazy Road Multiplayer - usuarios con contraseña, ranking persistente, tiers de corona y juego online

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

// ---------------- Carpeta public ----------------

const PUBLIC_DIR = path.join(__dirname, "public");
console.log("Sirviendo estáticos desde:", PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/test", (req, res) => {
  res.send("Hola desde CrazyRoadMultiplayer /test");
});

// ---------------- Mundo ----------------

const BLOCK_HEIGHT = 80;
const WORLD_HEIGHT = BLOCK_HEIGHT * 40;
const CHECKPOINT_Y = WORLD_HEIGHT - BLOCK_HEIGHT * 35;

const MAX_LEVEL = 10;
const WIN_POINTS = 10;

function isRoadBlockIndex(i) {
  if (i < 2) return false;
  const rel = i - 2;
  const group = Math.floor(rel / 4);
  const pos = rel % 4;
  if (pos === 0) return false;
  const randomLike = (group * 37 + 11) % 100;
  if (pos === 1 || pos === 2) return true;
  if (pos === 3) return randomLike >= 60;
  return false;
}

// ---------------- Usuarios ----------------

const USERS_FILE = path.join(__dirname, "users.json");
let users = {}; // { username: { passwordHash, displayName, createdAt } }

function loadUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        users = parsed;
        console.log("Usuarios cargados desde disco:", USERS_FILE);
      }
    } else {
      console.log("Archivo de usuarios no encontrado, se creará al guardar:", USERS_FILE);
    }
  } catch (err) {
    console.error("Error cargando usuarios:", err);
    users = {};
  }
}

function saveUsersToDisk() {
  try {
    const json = JSON.stringify(users, null, 2);
    fs.writeFileSync(USERS_FILE, json, "utf8");
  } catch (err) {
    console.error("Error guardando usuarios:", err);
  }
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function normalizeUsername(username) {
  return (username || "").toLowerCase().trim();
}

loadUsersFromDisk();

// ---------------- Ranking persistente ----------------

const BEST_TIMES_FILE = path.join(__dirname, "best-times.json");
let bestTimes = {}; // { userId: { userId, name, bestTimeMs, bestTimeAt, wins } }

function loadBestTimesFromDisk() {
  try {
    if (fs.existsSync(BEST_TIMES_FILE)) {
      const raw = fs.readFileSync(BEST_TIMES_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        bestTimes = parsed;
        console.log("Ranking cargado desde disco:", BEST_TIMES_FILE);
      }
    } else {
      console.log("Archivo de ranking no encontrado, se creará al guardar:", BEST_TIMES_FILE);
    }
  } catch (err) {
    console.error("Error cargando ranking desde disco:", err);
    bestTimes = {};
  }
}

function saveBestTimesToDisk() {
  try {
    const json = JSON.stringify(bestTimes, null, 2);
    fs.writeFileSync(BEST_TIMES_FILE, json, "utf8");
  } catch (err) {
    console.error("Error guardando ranking en disco:", err);
  }
}

loadBestTimesFromDisk();

function getBestTimesList() {
  return Object.values(bestTimes)
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      bestTimeMs: r.bestTimeMs,
      wins: r.wins,
      bestTimeAt: r.bestTimeAt
    }))
    .sort((a, b) => a.bestTimeMs - b.bestTimeMs)
    .slice(0, 10);
}

// userId -> tierCorona (0 = sin corona, 1 = morado, 2 = dorado, 3 = plata, 4 = bronce)
function getSkinTiers() {
  const list = getBestTimesList();
  const map = {};
  list.forEach((entry, index) => {
    const pos = index + 1; // 1,2,3,4...
    if (!entry.userId) return;
    if (pos >= 1 && pos <= 4) {
      map[entry.userId] = pos; // 1..4
    }
  });
  return map;
}

function registerWinTime(player) {
  const now = Date.now();
  const joinTime = player.joinTime || now;
  const runTimeMs = now - joinTime;

  const userId = player.userId || player.id;
  const key = userId;
  const existing = bestTimes[key];

  if (!existing || runTimeMs < existing.bestTimeMs) {
    bestTimes[key] = {
      userId,
      name: player.name || userId,
      bestTimeMs: runTimeMs,
      bestTimeAt: now,
      wins: (existing ? existing.wins : 0) + 1
    };
  } else {
    existing.wins += 1;
  }

  saveBestTimesToDisk();
  const list = getBestTimesList();
  const tiers = getSkinTiers();
  io.emit("bestTimesUpdate", list);
  io.emit("skinTiersUpdate", tiers);
}

// ---------------- Estado del juego ----------------

/**
 * players[socketId] = {
 *   id: socket.id,
 *   userId,
 *   name,
 *   avatarData,
 *   worldX, worldY,
 *   score, level,
 *   joinTime
 * }
 */
const players = {};

let cars = [];
let nextCarId = 1;

let coins = [];
let nextCoinId = 1;

let connectedPlayers = 0;

let gameLevel = 1;
let winnerAnnounced = false;

// ---------------- Socket.IO ----------------

io.on("connection", (socket) => {
  console.log("Nuevo socket:", socket.id);

  socket.on("joinGame", (data, callback) => {
    const { username, password, displayName, avatarData } = data || {};

    function cbError(message) {
      if (typeof callback === "function") callback({ ok: false, error: message });
    }
    function cbOk(extra) {
      if (typeof callback === "function") callback({ ok: true, ...extra });
    }

    const normUser = normalizeUsername(username);
    const pwd = (password || "").trim();

    if (!normUser || !pwd) {
      return cbError("Debes ingresar usuario y contraseña.");
    }

    const existing = users[normUser];
    const pwdHash = hashPassword(pwd);

    if (!existing) {
      const finalDisplayName = (displayName || normUser || "Jugador")
        .trim()
        .substring(0, 16);

      users[normUser] = {
        passwordHash: pwdHash,
        displayName: finalDisplayName,
        createdAt: Date.now()
      };
      saveUsersToDisk();
      console.log(`Nuevo usuario registrado: ${normUser}`);
    } else {
      if (existing.passwordHash !== pwdHash) {
        console.log(`Intento de login fallido para usuario ${normUser}`);
        return cbError("Contraseña incorrecta para este usuario.");
      }
      // Si el usuario ya existía y el displayName viene, podríamos permitir actualizarlo
      // pero por ahora lo dejamos fijo al que ya tiene guardado.
    }

    const userRecord = users[normUser];

    const now = Date.now();
    const p = {
      id: socket.id,
      userId: normUser,
      name: userRecord.displayName,
      avatarData: avatarData || "",
      worldX: 400,
      worldY: WORLD_HEIGHT - BLOCK_HEIGHT * 1.5,
      score: 0,
      level: 0,
      joinTime: now
    };
    players[socket.id] = p;

    connectedPlayers++;
    console.log(`Jugador (user=${normUser}) entró. Conectados:`, connectedPlayers);

    socket.emit("worldConfig", {
      blockHeight: BLOCK_HEIGHT,
      worldHeight: WORLD_HEIGHT,
      checkpointY: CHECKPOINT_Y
    });

    ensureTestCoinsNearStart();

    socket.emit("currentPlayers", players);
    socket.emit("carsUpdate", cars);
    socket.emit("coinsUpdate", coins);
    socket.emit("bestTimesUpdate", getBestTimesList());
    socket.emit("skinTiersUpdate", getSkinTiers());

    socket.broadcast.emit("newPlayer", players[socket.id]);

    io.emit("chatMessage", {
      id: "system",
      name: "Sistema",
      text: `Dificultad actual: nivel ${gameLevel}`,
      time: Date.now()
    });

    io.emit("scoreBoard", getScoreBoard());

    cbOk({
      userId: normUser,
      displayName: userRecord.displayName
    });
  });

  socket.on("playerMove", (pos) => {
    const player = players[socket.id];
    if (!player) return;

    player.worldX = pos.worldX;
    player.worldY = pos.worldY;

    if (!winnerAnnounced && player.worldY <= CHECKPOINT_Y) {
      player.level += 1;
      if (player.level > MAX_LEVEL) player.level = MAX_LEVEL;

      player.score += 1;

      recalculateGameLevel();

      if (!winnerAnnounced && player.score >= WIN_POINTS) {
        winnerAnnounced = true;
        registerWinTime(player);
        announceWinner(player);
      }

      resetPlayerPosition(player);
    }

    io.emit("playerMoved", {
      id: player.id,
      worldX: player.worldX,
      worldY: player.worldY
    });

    io.emit("scoreBoard", getScoreBoard());
  });

  socket.on("chatMessage", (text) => {
    const player = players[socket.id];
    if (!player || !text || !text.trim()) return;
    io.emit("chatMessage", {
      id: socket.id,
      name: player.name,
      text: text.trim(),
      time: Date.now()
    });
  });

  socket.on("restartGame", () => {
    if (!winnerAnnounced) return;
    console.log("Reiniciando partida por solicitud de:", socket.id);
    restartGameState();

    io.emit("chatMessage", {
      id: "system",
      name: "Sistema",
      text: "La partida se ha reiniciado. Nivel 1, todos al inicio.",
      time: Date.now()
    });

    io.emit("currentPlayers", players);
    io.emit("gameRestarted", {
      message: "Nueva partida iniciada",
    });
    io.emit("scoreBoard", getScoreBoard());
  });

  socket.on("disconnect", () => {
    const hadPlayer = !!players[socket.id];
    delete players[socket.id];

    if (hadPlayer) {
      connectedPlayers = Math.max(0, connectedPlayers - 1);
      console.log("Jugador salió. Conectados:", connectedPlayers);

      if (connectedPlayers === 0) {
        fullResetAll();
      } else {
        recalculateGameLevel();
      }
    }

    io.emit("playerDisconnected", socket.id);
    io.emit("scoreBoard", getScoreBoard());
  });
});

// ---------------- Auxiliares de juego ----------------

function getScoreBoard() {
  return Object.values(players)
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: Number(p.score.toFixed(2)),
      level: p.level
    }))
    .sort((a, b) =>
      b.score - a.score ||
      b.level - a.level ||
      a.name.localeCompare(b.name)
    );
}

function resetPlayerPosition(p) {
  p.worldX = 400;
  p.worldY = WORLD_HEIGHT - BLOCK_HEIGHT * 1.5;
}

function recalculateGameLevel() {
  let maxLevel = 1;
  for (const id in players) {
    if (players[id].level > maxLevel) maxLevel = players[id].level;
  }
  maxLevel = Math.min(Math.max(maxLevel, 1), MAX_LEVEL);
  gameLevel = maxLevel;
}

function announceWinner(player) {
  console.log(`>>> WINNER: ${player.name} puntos ${player.score.toFixed(2)}`);
  io.emit("chatMessage", {
    id: "system",
    name: "Sistema",
    text: `🏆 ${player.name} llegó a ${player.score.toFixed(2)} puntos y gana la partida`,
    time: Date.now()
  });

  io.emit("gameOver", {
    winnerId: player.id,
    winnerName: player.name,
    level: player.level,
    score: Number(player.score.toFixed(2)),
    maxLevel: MAX_LEVEL,
    bestTimes: getBestTimesList()
  });
}

function fullResetAll() {
  cars = [];
  coins = [];
  nextCarId = 1;
  nextCoinId = 1;
  gameLevel = 1;
  winnerAnnounced = false;
  for (const id in players) {
    delete players[id];
  }
}

function restartGameState() {
  cars = [];
  coins = [];
  nextCarId = 1;
  nextCoinId = 1;
  gameLevel = 1;
  winnerAnnounced = false;

  const now = Date.now();

  for (const id in players) {
    const p = players[id];
    p.score = 0;
    p.level = 0;
    p.joinTime = now;
    resetPlayerPosition(p);
  }

  ensureTestCoinsNearStart();
}

// ---------------- Autos ----------------

function spawnCar() {
  const totalBlocks = Math.floor(WORLD_HEIGHT / BLOCK_HEIGHT);
  const roadIndices = [];
  for (let i = 0; i < totalBlocks; i++) {
    if (isRoadBlockIndex(i)) roadIndices.push(i);
  }
  if (!roadIndices.length) return;

  const blockIndex = roadIndices[Math.floor(Math.random() * roadIndices.length)];
  const worldY = blockIndex * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;

  const direction = Math.random() < 0.5 ? 1 : -1;

  let carType = "normal";
  if (gameLevel >= 5) {
    const r = Math.random();
    if (r < 0.4) carType = "normal";
    else if (r < 0.8) carType = "fast";
    else carType = "laneChanger";
  } else if (gameLevel >= 2) {
    carType = Math.random() < 0.7 ? "normal" : "fast";
  }

  let baseSpeed = 3 + Math.random() * 2;
  if (carType === "fast") {
    baseSpeed = 5 + Math.random() * 3;
  } else if (carType === "laneChanger") {
    baseSpeed = 4 + Math.random() * 2;
  }

  const levelFactor = 1 + ((Math.min(gameLevel, MAX_LEVEL) - 1) * 0.05);
  const speed = baseSpeed * levelFactor;
  const startX = direction === 1 ? -100 : 900;

  cars.push({
    id: nextCarId++,
    worldX: startX,
    worldY,
    speed,
    direction,
    type: carType,
    laneIndex: blockIndex,
    laneChangeTimer: 1000 + Math.random() * 2000
  });
}

function updateCars(dtMs) {
  const updated = [];
  for (const car of cars) {
    car.worldX += car.speed * car.direction;

    if (car.type === "laneChanger" && gameLevel >= 5) {
      car.laneChangeTimer -= dtMs;
      if (car.laneChangeTimer <= 0) {
        tryChangeLane(car);
        car.laneChangeTimer = 1000 + Math.random() * 2000;
      }
    }

    if (car.worldX < -150 || car.worldX > 950) continue;
    updated.push(car);
  }
  cars = updated;
}

function tryChangeLane(car) {
  const totalBlocks = Math.floor(WORLD_HEIGHT / BLOCK_HEIGHT);
  const currentIndex = Math.round(car.worldY / BLOCK_HEIGHT - 0.5);
  const candidates = [];

  if (currentIndex > 0 && isRoadBlockIndex(currentIndex - 1)) {
    candidates.push(currentIndex - 1);
  }
  if (currentIndex < totalBlocks - 1 && isRoadBlockIndex(currentIndex + 1)) {
    candidates.push(currentIndex + 1);
  }
  if (!candidates.length) return;

  const newIndex = candidates[Math.floor(Math.random() * candidates.length)];
  car.laneIndex = newIndex;
  car.worldY = newIndex * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;
}

// Colisiones con autos

function checkCarCollisions() {
  const CAR_HALF_W = 40;
  const CAR_HALF_H = 25;
  const PLAYER_HALF = 24;

  for (const id in players) {
    const p = players[id];
    for (const car of cars) {
      if (Math.abs(p.worldY - car.worldY) > BLOCK_HEIGHT) continue;
      const dx = Math.abs(p.worldX - car.worldX);
      const dy = Math.abs(p.worldY - car.worldY);
      if (dx < CAR_HALF_W + PLAYER_HALF && dy < CAR_HALF_H + PLAYER_HALF) {
        resetPlayerPosition(p);

        io.to(id).emit("playerHit", {
          id: p.id,
          worldX: p.worldX,
          worldY: p.worldY
        });

        io.emit("playerMoved", {
          id: p.id,
          worldX: p.worldX,
          worldY: p.worldY
        });
      }
    }
  }
}

// ---------------- Monedas ----------------

function spawnGrassCoin(worldX, worldY) {
  coins.push({
    id: nextCoinId++,
    worldX,
    worldY,
    value: 0.5,
    type: "grass"
  });
}

function spawnRoadCoin(worldX, worldY) {
  coins.push({
    id: nextCoinId++,
    worldX,
    worldY,
    value: 1,
    type: "road"
  });
}

function spawnRandomGrassCoin() {
  const totalBlocks = Math.floor(WORLD_HEIGHT / BLOCK_HEIGHT);
  const grassIndices = [];
  for (let i = 0; i < totalBlocks; i++) {
    if (!isRoadBlockIndex(i)) grassIndices.push(i);
  }
  if (!grassIndices.length) return;
  const index = grassIndices[Math.floor(Math.random() * grassIndices.length)];
  const worldY = index * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;
  const worldX = 80 + Math.random() * (800 - 160);
  spawnGrassCoin(worldX, worldY);
}

function spawnRandomRoadCoin() {
  const totalBlocks = Math.floor(WORLD_HEIGHT / BLOCK_HEIGHT);
  const roadIndices = [];
  for (let i = 0; i < totalBlocks; i++) {
    if (isRoadBlockIndex(i)) roadIndices.push(i);
  }
  if (!roadIndices.length) return;
  const index = roadIndices[Math.floor(Math.random() * roadIndices.length)];
  const worldY = index * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;
  const worldX = 80 + Math.random() * (800 - 160);
  spawnRoadCoin(worldX, worldY);
}

function ensureTestCoinsNearStart() {
  if (coins.some(c => c.id === 1 || c.id === 2 || c.id === 3)) return;

  const startY = WORLD_HEIGHT - BLOCK_HEIGHT * 1.5;
  const grassY = startY - BLOCK_HEIGHT * 1;
  const roadY  = startY - BLOCK_HEIGHT * 2;

  coins.push({
    id: 1,
    worldX: 320,
    worldY: grassY,
    value: 0.5,
    type: "grass"
  });
  coins.push({
    id: 2,
    worldX: 480,
    worldY: grassY,
    value: 0.5,
    type: "grass"
  });
  coins.push({
    id: 3,
    worldX: 400,
    worldY: roadY,
    value: 1,
    type: "road"
  });

  nextCoinId = 4;
}

function ensureCoins() {
  const desiredGrass = 4;
  const desiredRoad = 3;
  let grassCount = 0;
  let roadCount = 0;
  for (const c of coins) {
    if (c.type === "grass") grassCount++;
    else if (c.type === "road") roadCount++;
  }
  if (grassCount < desiredGrass) spawnRandomGrassCoin();
  if (roadCount < desiredRoad) spawnRandomRoadCoin();
}

function checkCoinCollisions() {
  const COIN_RADIUS = 18;
  const PLAYER_HALF = 24;

  const remaining = [];
  for (const coin of coins) {
    let collectedBy = null;
    for (const id in players) {
      const p = players[id];
      if (Math.abs(p.worldY - coin.worldY) > BLOCK_HEIGHT) continue;
      const dx = Math.abs(p.worldX - coin.worldX);
      const dy = Math.abs(p.worldY - coin.worldY);
      if (dx < COIN_RADIUS + PLAYER_HALF && dy < COIN_RADIUS + PLAYER_HALF) {
        collectedBy = p;
        break;
      }
    }
    if (collectedBy) {
      collectedBy.score += coin.value;

      if (!winnerAnnounced && collectedBy.score >= WIN_POINTS) {
        winnerAnnounced = true;
        registerWinTime(collectedBy);
        announceWinner(collectedBy);
      }

      io.emit("scoreBoard", getScoreBoard());
    } else {
      remaining.push(coin);
    }
  }
  coins = remaining;
}

// ---------------- Loop ----------------

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;

  if (connectedPlayers > 0) {
    const prob = Math.min(0.1 + (Math.min(gameLevel, MAX_LEVEL) - 1) * 0.02, 0.3);
    if (!winnerAnnounced && Math.random() < prob) {
      spawnCar();
    }
    updateCars(dt);
    checkCarCollisions();
  }

  io.emit("carsUpdate", cars);

  ensureCoins();
  checkCoinCollisions();
  io.emit("coinsUpdate", coins);
}, 50);

server.listen(PORT, () => {
  console.log("Servidor escuchando en http://localhost:" + PORT);
});