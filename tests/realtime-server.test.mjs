import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { io as createClient } from "socket.io-client";

const PORT = 3917;
const SERVER_URL = `http://localhost:${PORT}`;
const SESSION_CACHE = fileURLToPath(new URL(".session-cache-test.json", import.meta.url));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(socket, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state", onState);
      reject(new Error("Timed out waiting for state"));
    }, timeout);

    function onState(state) {
      if (!predicate || predicate(state)) {
        clearTimeout(timer);
        socket.off("state", onState);
        resolve(state);
      }
    }

    socket.on("state", onState);
  });
}

async function waitForEvent(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);

    function onEvent(payload) {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }

    socket.on(event, onEvent);
  });
}

test("runs a real hosted round over sockets", async () => {
  let host;
  let player;
  let resumedPlayer;
  let blankPlayer;
  let latePlayer;
  await unlink(SESSION_CACHE).catch(() => {});

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST_PASSWORD: "testpass",
      PUZZLE_PACK: fileURLToPath(new URL("fixture-pack.json", import.meta.url)),
      SESSION_CACHE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    for (let i = 0; i < 50 && !output.includes(SERVER_URL); i += 1) {
      await wait(100);
    }
    assert.match(output, /PuzzleArena running/);

    host = createClient(SERVER_URL);
    player = createClient(SERVER_URL);
    blankPlayer = createClient(SERVER_URL);
    await Promise.all([
      waitForEvent(host, "connect"),
      waitForEvent(player, "connect"),
      waitForEvent(blankPlayer, "connect"),
    ]);

    const emptyLobbyPromise = waitForState(host, (state) => state.status === "lobby");
    host.emit("host:login", { password: "testpass" });
    const login = await waitForEvent(host, "host:login-result");
    assert.equal(login.ok, true);
    assert.match(login.roomCode, /^[A-Z2-9]{4}$/);
    const emptyLobby = await emptyLobbyPromise;
    assert.equal(emptyLobby.players.length, 0);
    assert.equal(emptyLobby.roomCode, login.roomCode);

    blankPlayer.emit("player:join", { roomCode: login.roomCode, name: "   " });
    const rejected = await waitForEvent(blankPlayer, "join-result");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.message, "Name is required");

    const joinedStatePromise = waitForState(host, (state) => state.players.length === 1);
    player.emit("player:join", { roomCode: login.roomCode, name: "Ava" });
    const joined = await waitForEvent(player, "join-result");
    assert.equal(joined.ok, true);
    assert.equal(joined.roomCode, login.roomCode);
    assert.ok(joined.playerSessionId);
    await joinedStatePromise;

    const disconnectedStatePromise = waitForState(host, (state) => state.players[0]?.connected === false);
    player.close();
    await disconnectedStatePromise;
    resumedPlayer = createClient(SERVER_URL);
    await waitForEvent(resumedPlayer, "connect");
    const resumedStatePromise = waitForState(host, (state) => state.players.length === 1 && state.players[0].connected === true);
    resumedPlayer.emit("player:resume", { roomCode: login.roomCode, playerSessionId: joined.playerSessionId });
    const resumed = await waitForEvent(resumedPlayer, "resume-result");
    assert.equal(resumed.ok, true);
    player = resumedPlayer;
    await resumedStatePromise;

    const secondJoinedPromise = waitForState(host, (state) => state.players.length === 2);
    blankPlayer.emit("player:join", { roomCode: login.roomCode, name: "Ben" });
    const secondJoined = await waitForEvent(blankPlayer, "join-result");
    assert.equal(secondJoined.ok, true);
    await secondJoinedPromise;

    const playerPreviewPromise = waitForState(player, (state) => state.status === "preview");
    const previewStatePromise = waitForState(host, (state) => state.status === "preview" && state.puzzle?.lineUci?.length === 3);
    host.emit("host:preview", { roomCode: login.roomCode, token: login.token });
    const preview = await previewStatePromise;
    const playerPreview = await playerPreviewPromise;
    assert.ok(preview.puzzle.id);
    assert.equal(playerPreview.puzzle, null);

    const livePlayerPromise = waitForState(player, (state) => state.status === "live" && state.puzzle);
    host.emit("host:start", { roomCode: login.roomCode, token: login.token });
    const livePlayerState = await livePlayerPromise;
    assert.equal(livePlayerState.hasStarted, true);
    assert.equal(livePlayerState.puzzle.lineUci, undefined);
    assert.equal(livePlayerState.puzzle.solution, undefined);
    assert.equal(livePlayerState.puzzle.answer, undefined);
    assert.equal(livePlayerState.puzzle.title, undefined);
    assert.equal(livePlayerState.puzzle.themes, undefined);
    assert.ok(livePlayerState.players[0].board);

    latePlayer = createClient(SERVER_URL);
    await waitForEvent(latePlayer, "connect");
    latePlayer.emit("player:join", { roomCode: login.roomCode, name: "Late" });
    const lateJoin = await waitForEvent(latePlayer, "join-result");
    assert.equal(lateJoin.ok, false);
    assert.equal(lateJoin.message, "Game already started");

    const illegalPromise = waitForState(player, (state) => state.status === "live" && state.players[0].feedback === "That is not a legal move.");
    player.emit("player:move", { move: "a8a7" });
    const afterIllegal = await illegalPromise;
    assert.equal(afterIllegal.players[0].answered, false);
    assert.equal(afterIllegal.players[0].correct, null);

    const midwayPromise = waitForState(host, (state) => state.players[0].progress === 1 && state.status === "live");
    player.emit("player:move", { move: preview.puzzle.lineUci[0] });
    const midway = await midwayPromise;
    assert.equal(midway.players[0].answered, false);

    const solvedPromise = waitForState(host, (state) => state.status === "live" && state.players.some((p) => p.name === "Ava" && p.correct));
    player.emit("player:move", { move: preview.puzzle.lineUci[2] });
    const solved = await solvedPromise;
    const solvedPlayer = solved.players.find((p) => p.name === "Ava");
    assert.equal(solvedPlayer.answered, true);
    assert.equal(solvedPlayer.correct, true);
    assert.ok(solvedPlayer.score > 0);

    const playerRevealPromise = waitForState(blankPlayer, (state) => state.status === "reveal" && state.puzzle?.solution?.length);
    host.emit("host:end-round", { roomCode: login.roomCode, token: login.token });
    const playerReveal = await playerRevealPromise;
    assert.deepEqual(playerReveal.puzzle.solution, preview.puzzle.solution);
    assert.match(playerReveal.players[0].feedback, /Solution shown below/);

  } finally {
    host?.close();
    player?.close();
    blankPlayer?.close();
    latePlayer?.close();
    child.kill();
    await unlink(SESSION_CACHE).catch(() => {});
  }
});
