import { Chess } from "/vendor/chess.js";

const socket = io();
const page = document.body.dataset.page;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let state = null;
let hostToken = sessionStorage.getItem("hostToken") || "";
let roomCode = (params.get("room") || sessionStorage.getItem("roomCode") || "").toUpperCase();
let playerId = sessionStorage.getItem("playerId") || "";
let playerSessionId = sessionStorage.getItem("playerSessionId") || "";
let selectedSquare = null;
let selectedPieceCode = "";
let draggedSquare = null;
let draggedPieceCode = "";
let highlightedMoves = [];
let clockOffsetMs = 0;

const squareNames = Array.from({ length: 64 }, (_, index) => {
  const file = "abcdefgh"[index % 8];
  const rank = 8 - Math.floor(index / 8);
  return `${file}${rank}`;
});
const blackSquareNames = [...squareNames].reverse();

const pieceColor = (code) => code && code === code.toUpperCase() ? "white" : "black";
const has = (id) => Boolean($(id));
const text = (id, value) => {
  if (has(id)) $(id).textContent = value;
};
const html = (id, value) => {
  if (has(id)) $(id).innerHTML = value;
};
const cleanRoomCode = (value) => String(value || "").trim().toUpperCase();

function wireEnter(ids, action) {
  ids.forEach((id) => {
    $(id)?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") action();
    });
  });
}

function wireUppercaseRoomInput(id) {
  $(id)?.addEventListener("input", (event) => {
    event.target.value = cleanRoomCode(event.target.value);
  });
}

function playerById(id) {
  return state?.players.find((player) => player.id === id) || null;
}

function rankOf(id) {
  return state?.ranked.findIndex((player) => player.id === id) + 1 || 0;
}

function canPlay() {
  const self = playerById(playerId);
  return Boolean(self && state?.puzzle && state.status === "live" && !self.answered);
}

function activeFen() {
  const self = playerById(playerId);
  return self?.fen || state?.puzzle?.fen || "";
}

function legalMovesFrom(square) {
  if (!canPlay() || !square || !activeFen()) return [];
  try {
    const game = new Chess(activeFen());
    return game.moves({ square, verbose: true });
  } catch {
    return [];
  }
}

function isSelectablePiece(square) {
  return legalMovesFrom(square).length > 0;
}

function hostPayload(extra = {}) {
  return { roomCode, token: hostToken, ...extra };
}

function emitSettings() {
  if (page !== "admin" || !roomCode || !hostToken) return;
  socket.emit("host:update-settings", hostPayload({
    settings: {
      ratingMin: Number($("ratingMin").value),
      ratingMax: Number($("ratingMax").value),
      minPopularity: Number($("minPopularity").value),
      theme: $("theme").value,
      timer: Number($("timer").value),
      maxPoints: Number($("maxPoints").value),
      cutoff: Number($("cutoff").value),
      curve: $("curve").value,
    },
  }));
}

function promotionFor(pieceCode, toSquare) {
  return pieceCode?.toLowerCase() === "p" && /[18]$/.test(toSquare) ? "q" : "";
}

function playMove(from, to, pieceCode) {
  if (!canPlay() || !from || !to || from === to) return;
  const legalMove = legalMovesFrom(from).find((move) => move.to === to && (!move.promotion || move.promotion === promotionFor(pieceCode, to)));
  if (!legalMove) {
    text("playerFeedback", "That move is not legal.");
    selectedSquare = null;
    selectedPieceCode = "";
    highlightedMoves = [];
    renderAll();
    return;
  }
  const move = `${legalMove.from}${legalMove.to}${legalMove.promotion || ""}`;
  selectedSquare = null;
  selectedPieceCode = "";
  highlightedMoves = [];
  draggedSquare = null;
  draggedPieceCode = "";
  socket.emit("player:move", { move });
}

function renderBoard(target, puzzle, playable, playerBoard) {
  if (!target) return;
  target.innerHTML = "";
  const board = playerBoard || puzzle?.board || Array(64).fill(null);
  const flip = target.dataset.flip === "black";
  const visualSquares = flip ? blackSquareNames : squareNames;
  const visualBoard = flip ? [...board].reverse() : board;
  visualBoard.forEach((piece, index) => {
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const squareName = visualSquares[index];
    const showRank = file === 0;
    const showFile = rank === 7;
    const square = document.createElement("button");
    square.type = "button";
    square.className = `square ${(file + rank) % 2 === 0 ? "light" : "dark"}`;
    square.dataset.square = squareName;
    square.disabled = !playable;
    if (playable) square.classList.add("clickable");
    if (selectedSquare === squareName) square.classList.add("selected");
    if (highlightedMoves.some((move) => move.to === squareName)) {
      square.classList.add(piece ? "legal-capture" : "legal-move");
    }

    if (piece) {
      const span = document.createElement("span");
      span.className = `piece piece-${pieceColor(piece.code)}`;
      span.textContent = piece.symbol;
      span.draggable = playable && isSelectablePiece(squareName);
      span.addEventListener("dragstart", (event) => {
        if (!playable || !isSelectablePiece(squareName)) {
          event.preventDefault();
          return;
        }
        draggedSquare = squareName;
        draggedPieceCode = piece.code;
        highlightedMoves = legalMovesFrom(squareName);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", squareName);
      });
      square.append(span);
    }

    if (showRank) {
      const rankLabel = document.createElement("span");
      rankLabel.className = "coord coord-rank";
      rankLabel.textContent = squareName[1];
      square.append(rankLabel);
    }
    if (showFile) {
      const fileLabel = document.createElement("span");
      fileLabel.className = "coord coord-file";
      fileLabel.textContent = squareName[0];
      square.append(fileLabel);
    }

    square.addEventListener("click", () => handleSquareClick(squareName, piece));
    square.addEventListener("dragover", (event) => {
      if (playable) event.preventDefault();
    });
    square.addEventListener("drop", (event) => {
      event.preventDefault();
      playMove(draggedSquare || event.dataTransfer.getData("text/plain"), squareName, draggedPieceCode);
    });
    target.append(square);
  });
}

function handleSquareClick(square, piece) {
  if (!canPlay()) return;

  if (!selectedSquare) {
    if (!piece) return;
    if (!isSelectablePiece(square)) {
      text("playerFeedback", "It is not that side's turn.");
      return;
    }
    selectedSquare = square;
    selectedPieceCode = piece.code;
    highlightedMoves = legalMovesFrom(square);
  } else if (selectedSquare === square) {
    selectedSquare = null;
    selectedPieceCode = "";
    highlightedMoves = [];
  } else if (piece && isSelectablePiece(square)) {
    selectedSquare = square;
    selectedPieceCode = piece.code;
    highlightedMoves = legalMovesFrom(square);
  } else {
    playMove(selectedSquare, square, selectedPieceCode);
  }
  renderAll();
}

function renderRows(target, players, mode = "normal") {
  if (!target) return;
  target.innerHTML = "";
  if (!players.length) {
    target.innerHTML = `<div class="message">No players have joined yet.</div>`;
    return;
  }

  players.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = "row";
    const status = player.answered
      ? player.correct ? `+${player.lastScore}` : "miss"
      : `${player.progress || 0}/${player.totalPlayerMoves || 0}`;
    row.innerHTML = `
      <span class="rank">#${index + 1}</span>
      <span class="avatar">${player.name.slice(0, 1).toUpperCase()}</span>
      <strong>${player.name}</strong>
      <span>${player.score} pts</span>
      <span>${mode === "roster" ? status : player.lastScore ? `+${player.lastScore}` : status}</span>
    `;
    target.append(row);
  });
}

function renderPuzzleInfo(prefix, puzzle) {
  text(`${prefix}PuzzleMeta`, puzzle ? `${puzzle.id} - ${puzzle.rating} - ${puzzle.side} to move` : "Waiting for host");
  const defaultTitle = prefix === "player" ? "Find the best move" : "No puzzle yet";
  text(`${prefix}PuzzleTitle`, puzzle?.title || defaultTitle);
}

function displayTimeLeft() {
  if (state?.status !== "live") return "";
  if (!state.roundEndsAt) return `${state.timeLeft || 0}s`;
  const now = Date.now() + clockOffsetMs;
  return `${Math.max(0, Math.ceil((state.roundEndsAt - now) / 1000))}s`;
}

function refreshLocalClock() {
  if (!state) return;
  const value = displayTimeLeft();
  if (page === "player") {
    $("playerTimer")?.classList.toggle("hidden", state.status !== "live");
    text("playerTimer", value);
  }
  if (page === "tv") {
    text("tvTimer", state.status === "live" ? value.replace("s", "") : "Ready");
  }
}

function renderAdmin() {
  text("status", state.status);
  text("hostBadge", hostToken ? "unlocked" : "locked");
  $("hostLogin")?.classList.toggle("hidden", Boolean(hostToken));
  $("hostControls")?.classList.toggle("hidden", !hostToken);
  text("puzzleCount", state.puzzleCount.toLocaleString());
  text("usedCount", state.usedCount.toLocaleString());
  text("waitingCount", state.players.filter((player) => !player.answered).length.toString());
  if (has("exportLink")) $("exportLink").href = `/api/export.csv?room=${encodeURIComponent(roomCode)}`;
  if (has("tvLink")) $("tvLink").href = `/tv?room=${encodeURIComponent(roomCode)}`;

  for (const [key, value] of Object.entries(state.settings)) {
    const input = $(key);
    if (input && document.activeElement !== input) input.value = value;
  }

  const puzzle = state.puzzle;
  text("puzzleMeta", puzzle ? `${puzzle.id} - ${puzzle.rating} - ${puzzle.side} to move` : "No puzzle selected");
  text("puzzleTitle", puzzle?.title || "Preview a puzzle to begin");
  html("puzzleTags", puzzle ? puzzle.themes.map((theme) => `<span>${theme}</span>`).join("") : "");
  $("solutionBox")?.classList.toggle("hidden", !(puzzle?.solution && (state.status === "reveal" || state.status === "ended" || hostToken)));
  html("solutionBox", puzzle?.solution ? `<strong>Solution</strong><br>${puzzle.solution.join(" ")}` : "");
  renderBoard($("hostBoard"), puzzle, false);
  renderRows($("roster"), state.players, "roster");
  html("events", state.events.map((event) => `<div class="message">${event}</div>`).join(""));
}

function renderPlayer() {
  const self = playerById(playerId);
  const board = self?.board || state.puzzle?.board;
  const playerCount = state.playerCount ?? state.players.length;
  const ownRank = self ? (state.viewerRank || rankOf(playerId)) : 0;
  const showSolution = Boolean(state.puzzle?.solution && (state.status === "reveal" || state.status === "ended"));
  if (has("playerBoard")) $("playerBoard").dataset.flip = state.puzzle?.side === "Black" ? "black" : "white";
  renderPuzzleInfo("player", state.puzzle);
  $("playerTimer")?.classList.toggle("hidden", state.status !== "live");
  text("playerTimer", displayTimeLeft());
  renderBoard($("playerBoard"), state.puzzle, canPlay(), board);
  $("playerSolutionBox")?.classList.toggle("hidden", !showSolution);
  html("playerSolutionBox", showSolution ? `<strong>Solution</strong><br>${state.puzzle.solution.join(" ")}` : "");
  $("joinBox")?.classList.toggle("hidden", Boolean(self));
  text("ownScore", self ? self.score : 0);
  text("ownRankNumber", self ? `#${ownRank}` : "--");
  text("ownRank", self ? `${playerCount} players in room` : "Not joined");
  text("ownProgress", self ? `${self.progress || 0}/${self.totalPlayerMoves || 0}` : "0/0");
  text("playerRoundStatus", state.status === "live" ? "Live puzzle" : state.status === "ended" ? "Session ended" : self ? "Between rounds" : "Join required");
  $("giveUp") && ($("giveUp").disabled = !canPlay());
  text("playerFeedback", self?.feedback || (self ? "Wait for the host to start the next puzzle." : "Enter the Room ID from the host to join."));
}

function renderTv() {
  $("tvJoinBox")?.classList.toggle("hidden", Boolean(state?.roomCode));
  text("tvTimer", state.status === "live" ? displayTimeLeft().replace("s", "") : "Ready");
  text("tvStatus", state.status);
  text("tvTitle", state.status === "ended" ? `Final standings - ${state.ranked.length} players` : state.status === "live" ? `${state.ranked.length} players solving` : state.hasStarted ? `Standings - ${state.ranked.length} players` : "Waiting for players");
  renderRows($("tvLeaderboard"), state.ranked);
}

function renderAll() {
  if (!state) return;
  roomCode = state.roomCode || roomCode;
  if (roomCode) sessionStorage.setItem("roomCode", roomCode);
  text("roomCode", roomCode || "----");
  text("connectionState", socket.connected ? "live" : "offline");
  if (page === "admin") renderAdmin();
  if (page === "player") renderPlayer();
  if (page === "tv") renderTv();
}

function resumeKnownSession() {
  if (page === "admin" && roomCode && hostToken) {
    socket.emit("host:resume", { roomCode, token: hostToken });
  }
  if (page === "player" && roomCode && playerSessionId) {
    socket.emit("player:resume", { roomCode, playerSessionId });
  }
}

if (page === "admin") {
  for (const [id, label] of window.PUZZLE_THEMES || []) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    $("theme").append(option);
  }

  const loginHost = () => socket.emit("host:login", { password: $("hostPassword").value });
  $("hostLoginButton").addEventListener("click", loginHost);
  wireEnter(["hostPassword"], loginHost);
  $("saveSettings").addEventListener("click", emitSettings);
  $("previewPuzzle").addEventListener("click", () => {
    emitSettings();
    socket.emit("host:preview", hostPayload());
  });
  $("startRound").addEventListener("click", () => {
    emitSettings();
    socket.emit("host:start", hostPayload());
  });
  $("forceEnd").addEventListener("click", () => socket.emit("host:end-round", hostPayload()));
  $("endSession").addEventListener("click", () => {
    if (confirm("End this session and leave the TV on final standings?")) {
      socket.emit("host:end-session", hostPayload());
    }
  });
}

if (page === "player") {
  if (roomCode && has("roomCodeInput")) $("roomCodeInput").value = roomCode;
  const savedName = sessionStorage.getItem("playerName") || "";
  if (savedName && has("nickname")) $("nickname").value = savedName;
  wireUppercaseRoomInput("roomCodeInput");
  const joinPlayer = () => {
    roomCode = cleanRoomCode($("roomCodeInput").value);
    const name = $("nickname").value.trim();
    if (!roomCode) {
      text("playerFeedback", "Room ID is required.");
      $("roomCodeInput").focus();
      return;
    }
    if (!name) {
      text("playerFeedback", "Name is required.");
      $("nickname").focus();
      return;
    }
    sessionStorage.setItem("playerName", name);
    socket.emit("player:join", { roomCode, name });
  };
  $("joinButton").addEventListener("click", joinPlayer);
  wireEnter(["roomCodeInput", "nickname"], joinPlayer);
  $("giveUp").addEventListener("click", () => socket.emit("player:give-up"));
}

if (page === "tv") {
  if (roomCode && has("tvRoomCode")) $("tvRoomCode").value = roomCode;
  wireUppercaseRoomInput("tvRoomCode");
  const watchRoom = () => {
    roomCode = cleanRoomCode($("tvRoomCode").value || roomCode);
    if (roomCode) socket.emit("room:watch", { roomCode });
  };
  $("watchRoomButton").addEventListener("click", watchRoom);
  wireEnter(["tvRoomCode"], watchRoom);
  if (roomCode) socket.on("connect", watchRoom);
  if (roomCode && socket.connected) watchRoom();
}

text("roomCode", roomCode || "----");

socket.on("connect", () => {
  text("connectionState", "live");
  resumeKnownSession();
});
socket.on("disconnect", () => text("connectionState", "offline"));
socket.on("state", (nextState) => {
  state = nextState;
  if (state.serverNow) clockOffsetMs = state.serverNow - Date.now();
  if (!canPlay()) {
    selectedSquare = null;
    selectedPieceCode = "";
    highlightedMoves = [];
    draggedSquare = null;
    draggedPieceCode = "";
  }
  renderAll();
});
socket.on("host:login-result", (result) => {
  text("hostMessage", result.message || "");
  if (result.ok) {
    hostToken = result.token;
    roomCode = result.roomCode;
    sessionStorage.setItem("hostToken", hostToken);
    sessionStorage.setItem("roomCode", roomCode);
    text("hostMessage", `Room ${roomCode} created. Share this Room ID with players.`);
  }
});
socket.on("host:resume-result", (result) => {
  if (!result.ok) {
    hostToken = "";
    sessionStorage.removeItem("hostToken");
    text("hostMessage", result.message || "Host session expired. Create a new room.");
    return;
  }
  hostToken = result.token;
  roomCode = result.roomCode;
  sessionStorage.setItem("hostToken", hostToken);
  sessionStorage.setItem("roomCode", roomCode);
});
socket.on("join-result", (result) => {
  if (!result.ok) {
    text("playerFeedback", result.message || "Could not join room.");
    return;
  }
  playerId = result.id;
  playerSessionId = result.playerSessionId;
  roomCode = result.roomCode;
  sessionStorage.setItem("playerId", playerId);
  sessionStorage.setItem("playerSessionId", playerSessionId);
  sessionStorage.setItem("roomCode", roomCode);
});
socket.on("resume-result", (result) => {
  if (!result.ok) {
    playerId = "";
    playerSessionId = "";
    sessionStorage.removeItem("playerId");
    sessionStorage.removeItem("playerSessionId");
    text("playerFeedback", result.message || "Room session expired. Join again.");
    return;
  }
  playerId = result.id;
  playerSessionId = result.playerSessionId;
  roomCode = result.roomCode;
  sessionStorage.setItem("playerId", playerId);
  sessionStorage.setItem("playerSessionId", playerSessionId);
  sessionStorage.setItem("roomCode", roomCode);
});
socket.on("errorMessage", (message) => {
  text("hostMessage", message);
  text("playerFeedback", message);
});

setInterval(refreshLocalClock, 250);
