import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD || "host123";
const PACK_PATH = process.env.PUZZLE_PACK
  ? path.resolve(process.env.PUZZLE_PACK)
  : path.join(__dirname, "public", "puzzles", "lichess-pack.json");
const CACHE_PATH = process.env.SESSION_CACHE
  ? path.resolve(process.env.SESSION_CACHE)
  : path.join(__dirname, "data", "session-cache.json");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public", "realtime"), { index: false }));
app.use("/puzzles", express.static(path.join(__dirname, "public", "puzzles")));
app.get("/vendor/chess.js", (_req, res) => res.sendFile(path.join(__dirname, "node_modules", "chess.js", "dist", "esm", "chess.js")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "realtime", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "realtime", "admin.html")));
app.get("/tv", (_req, res) => res.sendFile(path.join(__dirname, "public", "realtime", "tv.html")));
app.get("/api/export.csv", (req, res) => {
  const room = getRoom(String(req.query.room || "").toUpperCase());
  if (!room) return res.status(404).type("text/plain").send("Room not found");
  const rows = rankedPlayers(room).map((player, index) => {
    const accuracy = player.attempts ? Math.round((player.correctCount / player.attempts) * 100) : 0;
    return `${index + 1},"${player.name.replaceAll('"', '""')}",${player.score},${accuracy}%,${player.averageTime || ""}`;
  });
  res.type("text/csv").send(["rank,name,score,accuracy,average_solve_time", ...rows].join("\n"));
});

const pieceSymbols = {
  K: "\u2654",
  Q: "\u2655",
  R: "\u2656",
  B: "\u2657",
  N: "\u2658",
  P: "\u2659",
  k: "\u265A",
  q: "\u265B",
  r: "\u265C",
  b: "\u265D",
  n: "\u265E",
  p: "\u265F",
};

const rooms = new Map();
const socketRooms = new Map();
const socketRoles = new Map();
let puzzleRows = [];
let saveHandle = null;

function roomChannel(code) {
  return `room:${code}`;
}

function hostChannel(code) {
  return `host:${code}`;
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
}

function createRoom() {
  const code = makeCode();
  const room = {
    code,
    hostToken: randomUUID(),
    hostConnected: true,
    hostSocketId: null,
    status: "lobby",
    hasStarted: false,
    players: new Map(),
    settings: {
      ratingMin: 800,
      ratingMax: 2400,
      minPopularity: 60,
      theme: "mix",
      timer: 45,
      maxPoints: 100,
      cutoff: 10,
      curve: "linear",
    },
    usedPuzzleIds: new Set(),
    currentPuzzle: null,
    roundStartedAt: null,
    roundEndsAt: null,
    timeLeft: 0,
    tickHandle: null,
    spectatorEmitHandle: null,
    events: ["Room created"],
  };
  rooms.set(code, room);
  scheduleSave();
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

function addEvent(room, message) {
  room.events = [message, ...room.events].slice(0, 10);
  scheduleSave();
}

function everyPlayerAnswered(room) {
  for (const player of room.players.values()) {
    if (!player.answered) return false;
  }
  return true;
}

function boardFromFen(fen) {
  return new Chess(fen).board().flatMap((row) =>
    row.map((piece) => piece ? {
      code: piece.color === "w" ? piece.type.toUpperCase() : piece.type,
      symbol: pieceSymbols[piece.color === "w" ? piece.type.toUpperCase() : piece.type],
    } : null),
  );
}

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`.toLowerCase();
}

function puzzleFromRow(row) {
  try {
    const game = new Chess(row.fen);
    const uciMoves = String(row.moves || "").trim().split(/\s+/).filter(Boolean);
    const sanMoves = [];
    for (const uci of uciMoves) {
      const move = game.move(uciToMove(uci));
      if (!move) return null;
      sanMoves.push(move.san);
    }
    const displayGame = new Chess(row.fen);
    if (uciMoves[0]) displayGame.move(uciToMove(uciMoves[0]));
    const lineUci = uciMoves.slice(1);
    if (!lineUci.length) return null;
    const themes = String(row.themes || "mix").split(/\s+/).filter(Boolean);
    return {
      id: row.id,
      title: row.openingTags ? String(row.openingTags).split(/\s+/)[0].replaceAll("_", " ") : themes.slice(0, 2).join(" + "),
      fen: displayGame.fen(),
      rating: Number(row.rating),
      popularity: Number(row.popularity || 0),
      plays: Number(row.plays || 0),
      themes,
      side: displayGame.turn() === "w" ? "White" : "Black",
      solution: sanMoves.slice(1),
      lineUci,
      board: boardFromFen(displayGame.fen()),
      gameUrl: row.gameUrl || "",
    };
  } catch {
    return null;
  }
}

function publicPlayer(player, viewerId = null) {
  return {
    id: player.id,
    sessionId: viewerId === player.id ? player.sessionId : undefined,
    name: player.name,
    score: player.score,
    lastScore: player.lastScore,
    connected: player.connected,
    answered: player.answered,
    correct: player.correct,
    solveTime: player.solveTime,
    attempts: player.attempts,
    correctCount: player.correctCount,
    averageTime: player.averageTime,
    progress: player.progress || 0,
    totalPlayerMoves: player.totalPlayerMoves || 0,
    board: viewerId === player.id ? player.board : null,
    fen: viewerId === player.id ? player.puzzleFen : null,
    feedback: player.feedback || "",
  };
}

function publicPlayers(room, viewerId = null) {
  return [...room.players.values()].map((player) => publicPlayer(player, viewerId));
}

function rankedPlayers(room) {
  return publicPlayers(room).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function scoreForRank(room, rank) {
  const { curve, maxPoints, cutoff } = room.settings;
  if (rank > cutoff && curve !== "flat") return 0;
  if (curve === "winner") return rank === 1 ? maxPoints : 0;
  if (curve === "flat") return maxPoints;
  if (curve === "exponential") return Math.round(maxPoints * Math.pow(0.72, rank - 1));
  const fraction = (cutoff - rank + 1) / cutoff;
  if (curve === "quadratic") return Math.round(maxPoints * fraction * fraction);
  return Math.round(maxPoints * fraction);
}

function totalPlayerMoves(puzzle) {
  return Math.ceil((puzzle?.lineUci?.length || 0) / 2);
}

function visiblePuzzle(room, forHost = false, viewerId = null) {
  if (!room.currentPuzzle) return null;
  if (forHost || room.status === "reveal" || room.status === "ended") return room.currentPuzzle;
  if (!viewerId || room.status !== "live") return null;
  const { solution, lineUci, gameUrl, themes, title, ...safePuzzle } = room.currentPuzzle;
  return safePuzzle;
}

function snapshot(room, forHost = false, viewerId = null, ranked = rankedPlayers(room), allPlayers = null) {
  const viewerPlayer = viewerId ? room.players.get(viewerId) : null;
  const players = viewerId
    ? (viewerPlayer ? [publicPlayer(viewerPlayer, viewerId)] : [])
    : (allPlayers || publicPlayers(room));
  return {
    roomCode: room.code,
    hostConnected: room.hostConnected,
    status: room.status,
    hasStarted: room.hasStarted,
    settings: room.settings,
    players,
    ranked: viewerId ? [] : ranked,
    playerCount: room.players.size,
    viewerRank: viewerId ? ranked.findIndex((player) => player.id === viewerId) + 1 : null,
    puzzle: visiblePuzzle(room, forHost, viewerId),
    timeLeft: room.timeLeft,
    serverNow: Date.now(),
    roundEndsAt: room.roundEndsAt,
    usedCount: room.usedPuzzleIds.size,
    puzzleCount: puzzleRows.length,
    events: room.events,
  };
}

function emitRoom(room) {
  const ranked = rankedPlayers(room);
  const allPlayers = publicPlayers(room);
  io.to(roomChannel(room.code)).emit("state", snapshot(room, false, null, ranked, allPlayers));
  io.to(hostChannel(room.code)).emit("state", snapshot(room, true, null, ranked, allPlayers));
  for (const player of room.players.values()) {
    io.to(player.id).emit("state", snapshot(room, false, player.id, ranked, allPlayers));
  }
}

function emitSpectatorsNow(room) {
  const ranked = rankedPlayers(room);
  const allPlayers = publicPlayers(room);
  io.to(roomChannel(room.code)).emit("state", snapshot(room, false, null, ranked, allPlayers));
  io.to(hostChannel(room.code)).emit("state", snapshot(room, true, null, ranked, allPlayers));
}

function emitSpectators(room) {
  clearTimeout(room.spectatorEmitHandle);
  room.spectatorEmitHandle = setTimeout(() => {
    room.spectatorEmitHandle = null;
    emitSpectatorsNow(room);
  }, 75);
}

function emitPlayer(room, player) {
  const ranked = rankedPlayers(room);
  io.to(player.id).emit("state", snapshot(room, false, player.id, ranked));
}

function emitRoomEntry(room, player = null) {
  emitSpectatorsNow(room);
  if (player) emitPlayer(room, player);
}

function filteredRows(room) {
  const { ratingMin, ratingMax, minPopularity, theme } = room.settings;
  return puzzleRows.filter((row) =>
    Number(row.rating) >= ratingMin &&
    Number(row.rating) <= ratingMax &&
    Number(row.popularity || 0) >= minPopularity &&
    (theme === "mix" || String(row.themes || "").split(/\s+/).includes(theme)) &&
    !room.usedPuzzleIds.has(row.id),
  );
}

function choosePuzzle(room) {
  const choices = filteredRows(room);
  const pool = choices.length ? choices : puzzleRows;
  for (let attempt = 0; attempt < Math.min(pool.length, 60); attempt += 1) {
    const puzzle = puzzleFromRow(pool[Math.floor(Math.random() * pool.length)]);
    if (puzzle) return puzzle;
  }
  return null;
}

function stopTimer(room) {
  if (room.tickHandle) clearInterval(room.tickHandle);
  room.tickHandle = null;
}

function scheduleSave() {
  clearTimeout(saveHandle);
  saveHandle = setTimeout(() => {
    saveRooms().catch((error) => console.error(`Could not save session cache: ${error.message}`));
  }, 150);
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostToken: room.hostToken,
    hostConnected: false,
    status: room.status === "live" ? "reveal" : room.status,
    hasStarted: room.hasStarted,
    players: [...room.players.values()].map((player) => ({ ...player, connected: false })),
    settings: room.settings,
    usedPuzzleIds: [...room.usedPuzzleIds],
    currentPuzzle: room.currentPuzzle,
    roundStartedAt: null,
    roundEndsAt: null,
    timeLeft: room.status === "live" ? 0 : room.timeLeft,
    events: room.status === "live" ? ["Server restarted; round ended", ...room.events].slice(0, 10) : room.events,
  };
}

async function saveRooms() {
  const payload = {
    savedAt: new Date().toISOString(),
    rooms: [...rooms.values()].filter((room) => room.status !== "ended").map(serializeRoom),
  };
  await mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

async function loadRooms() {
  if (!existsSync(CACHE_PATH)) return;
  const payload = JSON.parse(await readFile(CACHE_PATH, "utf8"));
  if (!Array.isArray(payload.rooms)) return;
  for (const cached of payload.rooms) {
    if (!cached.code || rooms.has(cached.code)) continue;
    rooms.set(cached.code, {
      code: cached.code,
      hostToken: cached.hostToken,
      hostConnected: false,
      hostSocketId: null,
      status: cached.status || "lobby",
      hasStarted: Boolean(cached.hasStarted),
      players: new Map((cached.players || []).map((player) => [player.id, { ...player, connected: false }])),
      settings: cached.settings,
      usedPuzzleIds: new Set(cached.usedPuzzleIds || []),
      currentPuzzle: cached.currentPuzzle || null,
      roundStartedAt: null,
      roundEndsAt: null,
      timeLeft: Number(cached.timeLeft || 0),
      tickHandle: null,
      spectatorEmitHandle: null,
      events: cached.events || ["Room restored"],
    });
  }
}

function endRound(room, reason = "Round ended") {
  stopTimer(room);
  if (room.status !== "live") return;
  for (const player of room.players.values()) {
    if (!player.answered) player.feedback = reason === "Time ended" ? "Time ended. Solution shown below." : "Round ended. Solution shown below.";
    else if (!player.correct) player.feedback = `${player.feedback} Solution shown below.`;
  }
  room.status = "reveal";
  addEvent(room, reason);
  emitRoom(room);
}

function startTimer(room) {
  stopTimer(room);
  room.tickHandle = setInterval(() => {
    if (room.status !== "live") return stopTimer(room);
    room.timeLeft = Math.max(0, Math.ceil((room.roundEndsAt - Date.now()) / 1000));
    if (room.timeLeft <= 0) endRound(room, "Time ended");
    else emitSpectatorsNow(room);
  }, 1000);
}

function playerTemplate(socket, name) {
  return {
    id: socket.id,
    sessionId: randomUUID(),
    name,
    score: 0,
    lastScore: 0,
    connected: true,
    answered: false,
    correct: null,
    solveTime: null,
    attempts: 0,
    correctCount: 0,
    totalTime: 0,
    averageTime: null,
    puzzleFen: null,
    lineIndex: 0,
    progress: 0,
    totalPlayerMoves: 0,
    board: null,
    feedback: "",
  };
}

function requireHost(socket, roomCode, token) {
  const room = getRoom(roomCode);
  if (!room || token !== room.hostToken) {
    socket.emit("errorMessage", "Host login required");
    return null;
  }
  return room;
}

async function loadPuzzleRows() {
  if (!existsSync(PACK_PATH)) return [];
  const pack = JSON.parse(await readFile(PACK_PATH, "utf8"));
  return Array.isArray(pack.puzzles) ? pack.puzzles : [];
}

function attachSocket(socket, room, role) {
  socketRooms.set(socket.id, room.code);
  socketRoles.set(socket.id, role);
}

function findPlayerBySession(room, sessionId) {
  return [...room.players.values()].find((player) => player.sessionId === sessionId);
}

function reconnectPlayer(socket, room, player) {
  room.players.delete(player.id);
  player.id = socket.id;
  player.connected = true;
  room.players.set(socket.id, player);
  attachSocket(socket, room, "player");
  return player;
}

function markPlayerDisconnected(room, player) {
  player.connected = false;
  addEvent(room, `${player.name} disconnected`);
  emitSpectators(room);
  scheduleSave();
}

io.on("connection", (socket) => {
  socket.on("host:login", ({ password }) => {
    if (password !== HOST_PASSWORD) {
      socket.emit("host:login-result", { ok: false, message: "Wrong host password" });
      return;
    }
    const room = createRoom();
    socket.join(hostChannel(room.code));
    room.hostConnected = true;
    room.hostSocketId = socket.id;
    attachSocket(socket, room, "host");
    addEvent(room, "Host signed in");
    socket.emit("host:login-result", { ok: true, token: room.hostToken, roomCode: room.code });
    emitSpectatorsNow(room);
  });

  socket.on("host:resume", ({ roomCode, token }) => {
    const room = requireHost(socket, roomCode, token);
    if (!room) {
      socket.emit("host:resume-result", { ok: false, message: "Host session expired" });
      return;
    }
    socket.join(hostChannel(room.code));
    room.hostConnected = true;
    room.hostSocketId = socket.id;
    attachSocket(socket, room, "host");
    socket.emit("host:resume-result", { ok: true, token: room.hostToken, roomCode: room.code });
    emitSpectatorsNow(room);
  });

  socket.on("room:watch", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }
    socket.join(roomChannel(room.code));
    attachSocket(socket, room, "watcher");
    socket.emit("state", snapshot(room, false));
  });

  socket.on("player:join", ({ roomCode, name }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("join-result", { ok: false, message: "Room not found" });
      return;
    }
    if (room.hasStarted) {
      socket.emit("join-result", { ok: false, message: "Game already started" });
      return;
    }
    const cleanName = String(name || "").trim().slice(0, 18);
    if (!cleanName) {
      socket.emit("join-result", { ok: false, message: "Name is required" });
      return;
    }
    const player = playerTemplate(socket, cleanName);
    attachSocket(socket, room, "player");
    room.players.set(socket.id, player);
    addEvent(room, `${cleanName} joined`);
    socket.emit("join-result", { ok: true, id: socket.id, playerSessionId: player.sessionId, roomCode: room.code });
    emitRoomEntry(room, player);
  });

  socket.on("player:resume", ({ roomCode, playerSessionId }) => {
    const room = getRoom(roomCode);
    const player = room && findPlayerBySession(room, playerSessionId);
    if (!room || !player) {
      socket.emit("resume-result", { ok: false, message: "Room session expired" });
      return;
    }
    const previousId = player.id;
    reconnectPlayer(socket, room, player);
    addEvent(room, `${player.name} reconnected`);
    socket.emit("resume-result", { ok: true, id: socket.id, previousId, playerSessionId: player.sessionId, roomCode: room.code });
    emitRoomEntry(room, player);
  });

  socket.on("host:update-settings", ({ roomCode, token, settings }) => {
    const room = requireHost(socket, roomCode, token);
    if (!room) return;
    room.settings = { ...room.settings, ...settings };
    scheduleSave();
    emitRoom(room);
  });

  socket.on("host:preview", ({ roomCode, token }) => {
    const room = requireHost(socket, roomCode, token);
    if (!room) return;
    const puzzle = choosePuzzle(room);
    if (!puzzle) {
      socket.emit("errorMessage", "No puzzles match the current filters");
      return;
    }
    room.currentPuzzle = puzzle;
    room.status = "preview";
    addEvent(room, `Previewing ${puzzle.id}`);
    emitRoom(room);
  });

  socket.on("host:start", ({ roomCode, token }) => {
    const room = requireHost(socket, roomCode, token);
    if (!room) return;
    if (!room.currentPuzzle) room.currentPuzzle = choosePuzzle(room);
    if (!room.currentPuzzle) {
      socket.emit("errorMessage", "No puzzle available");
      return;
    }
    for (const player of room.players.values()) {
      player.lastScore = 0;
      player.answered = false;
      player.correct = null;
      player.solveTime = null;
      player.puzzleFen = room.currentPuzzle.fen;
      player.lineIndex = 0;
      player.progress = 0;
      player.totalPlayerMoves = totalPlayerMoves(room.currentPuzzle);
      player.board = boardFromFen(room.currentPuzzle.fen);
      player.feedback = "Your move.";
    }
    room.usedPuzzleIds.add(room.currentPuzzle.id);
    room.hasStarted = true;
    room.status = "live";
    room.roundStartedAt = Date.now();
    room.timeLeft = room.settings.timer;
    room.roundEndsAt = room.roundStartedAt + room.settings.timer * 1000;
    addEvent(room, `Started ${room.currentPuzzle.id}`);
    startTimer(room);
    emitRoom(room);
  });

  socket.on("host:end-round", ({ roomCode, token }) => {
    const room = requireHost(socket, roomCode, token);
    if (room) endRound(room, "Round force ended");
  });

  socket.on("host:end-session", ({ roomCode, token }) => {
    const room = requireHost(socket, roomCode, token);
    if (!room) return;
    stopTimer(room);
    room.status = "ended";
    room.roundEndsAt = null;
    addEvent(room, "Session ended");
    emitRoom(room);
    scheduleSave();
  });

  socket.on("player:move", ({ move }) => {
    const room = getRoom(socketRooms.get(socket.id));
    const player = room?.players.get(socket.id);
    if (!room || !player || !room.currentPuzzle || room.status !== "live" || player.answered) return;
    const game = new Chess(player.puzzleFen || room.currentPuzzle.fen);
    const attempted = String(move || "").trim().toLowerCase();
    let played = null;
    try {
      played = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(attempted)
        ? game.move(uciToMove(attempted))
        : null;
    } catch {
      played = null;
    }
    const expected = room.currentPuzzle.lineUci[player.lineIndex];
    if (!played) {
      player.feedback = "That is not a legal move.";
      emitPlayer(room, player);
      return;
    }
    if (moveToUci(played) !== expected) {
      player.answered = true;
      player.correct = false;
      player.lastScore = 0;
      player.solveTime = Number(Math.max(0.1, (Date.now() - room.roundStartedAt) / 1000).toFixed(1));
      player.attempts += 1;
      player.board = boardFromFen(game.fen());
      player.feedback = "Wrong move. Puzzle failed.";
      addEvent(room, `${player.name} missed ${room.currentPuzzle.id}`);
      if (everyPlayerAnswered(room)) endRound(room);
      else {
        emitSpectators(room);
        emitPlayer(room, player);
      }
      return;
    }
    player.lineIndex += 1;
    player.progress += 1;
    player.feedback = "Correct.";
    const reply = room.currentPuzzle.lineUci[player.lineIndex];
    if (reply) {
      game.move(uciToMove(reply));
      player.lineIndex += 1;
      player.feedback = "Correct. Opponent replied. Your move.";
    }
    player.puzzleFen = game.fen();
    player.board = boardFromFen(game.fen());
    if (player.lineIndex >= room.currentPuzzle.lineUci.length) {
      const elapsed = Math.max(0.1, (Date.now() - room.roundStartedAt) / 1000);
      const rank = [...room.players.values()].filter((p) => p.correct).length + 1;
      const points = scoreForRank(room, rank);
      player.score += points;
      player.lastScore = points;
      player.answered = true;
      player.correct = true;
      player.solveTime = Number(elapsed.toFixed(1));
      player.attempts += 1;
      player.correctCount += 1;
      player.totalTime += elapsed;
      player.averageTime = Number((player.totalTime / player.correctCount).toFixed(1));
      player.feedback = `Solved. +${points} points.`;
      addEvent(room, `${player.name} solved ${room.currentPuzzle.id}`);
    }
    if (everyPlayerAnswered(room)) endRound(room);
    else {
      scheduleSave();
      emitSpectators(room);
      emitPlayer(room, player);
    }
  });

  socket.on("player:give-up", () => {
    const room = getRoom(socketRooms.get(socket.id));
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status !== "live" || player.answered) return;
    player.answered = true;
    player.correct = false;
    player.lastScore = 0;
    player.attempts += 1;
    player.feedback = "You gave up.";
    addEvent(room, `${player.name} gave up`);
    if (everyPlayerAnswered(room)) endRound(room);
    else {
      scheduleSave();
      emitSpectators(room);
      emitPlayer(room, player);
    }
  });

  socket.on("disconnect", () => {
    const room = getRoom(socketRooms.get(socket.id));
    const role = socketRoles.get(socket.id);
    const player = room?.players.get(socket.id);
    if (room && player) {
      markPlayerDisconnected(room, player);
    } else if (room && role === "host" && room.hostSocketId === socket.id) {
      room.hostConnected = false;
      room.hostSocketId = null;
      emitRoom(room);
      scheduleSave();
    }
    socketRooms.delete(socket.id);
    socketRoles.delete(socket.id);
  });
});

puzzleRows = await loadPuzzleRows();
await loadRooms();

httpServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the existing server or start with PORT=3001.`);
    process.exit(1);
  }
  throw error;
});

httpServer.listen(PORT, () => {
  console.log(`PuzzleArena running at http://localhost:${PORT}`);
  console.log(`Host password: ${HOST_PASSWORD}`);
  console.log(`${puzzleRows.length.toLocaleString()} puzzle rows loaded`);
});
