#!/usr/bin/env node
"use strict";

/**
 * Stands in for `sb-recorder` in tests: the same argument (one WAV path), the same
 * JSON-on-stderr protocol, the same PCM-on-stdout stream, and the same SIGINT
 * handling. Environment variables steer the paths the real helper reaches only
 * with real hardware:
 *
 *   SB_FAKE_RECORDER_EXIT_MS    exit on its own after this many ms (an unexpected death)
 *   SB_FAKE_RECORDER_EXIT_CODE  the code that exit uses (default 1)
 *   SB_FAKE_RECORDER_DEVICE_MS  emit a `device` line after this many ms
 *   SB_FAKE_RECORDER_STALL_MS   emit the `stdout consumer stalled` error after this many ms
 *   SB_FAKE_RECORDER_KILL_MS    kill itself with SIGKILL after this many ms (no clean exit)
 *   SB_FAKE_RECORDER_STOP_CODE  the code to exit with on SIGINT/SIGTERM (default 0: a clean stop)
 *   SB_FAKE_RECORDER_IGNORE_SIGNALS  ignore SIGINT and SIGTERM entirely, the way a helper wedged
 *                                    inside a CoreAudio call that never returns does
 */

const fs = require("node:fs");
const path = require("node:path");

const CHUNK_MS = 100;
/** 16 000 frames a second, two bytes a frame, a tenth of a second. */
const CHUNK_BYTES = 3200;

const wavPath = process.argv[2];
if (!wavPath) {
  process.stderr.write(`${JSON.stringify({ state: "error", message: "usage: fake-recorder <wav>" })}\n`);
  process.exit(1);
}

function header(dataLength) {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataLength, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataLength, 40);
  return b;
}

// Signal handlers first: a stop can arrive the instant the WAV exists, and before the handler
// is on, SIGINT would end the process with no code at all, which reads as a clean stop.
let fd = null;
let dataLength = 0;
const timers = [];
const stopCode = Number(process.env.SB_FAKE_RECORDER_STOP_CODE ?? 0);
function finish(code) {
  for (const t of timers) clearInterval(t);
  if (fd !== null) {
    fs.writeSync(fd, header(dataLength), 0, 44, 0);
    fs.closeSync(fd);
  }
  process.exit(code);
}
if (process.env.SB_FAKE_RECORDER_IGNORE_SIGNALS) {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGINT", () => finish(stopCode));
  process.on("SIGTERM", () => finish(stopCode));
}

// SB_FAKE_RECORDER_FAIL_EARLY: refuse before touching the WAV, the way the real helper does when
// microphone access is denied -- a JSON error, exit 1, and no file on disk at all.
if (process.env.SB_FAKE_RECORDER_FAIL_EARLY) {
  process.stderr.write(`${JSON.stringify({ state: "error", message: process.env.SB_FAKE_RECORDER_FAIL_EARLY })}\n`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(wavPath), { recursive: true });
fd = fs.openSync(wavPath, "w");
fs.writeSync(fd, header(0), 0, 44, 0);

function say(line) {
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

say({ state: "recording", systemAudio: true });
// A plain, non-JSON line: what a helper writes just before it aborts, and what the recorder is
// expected to carry into its failure message rather than discard.
if (process.env.SB_FAKE_RECORDER_SAY) process.stderr.write(`${process.env.SB_FAKE_RECORDER_SAY}\n`);

const silence = Buffer.alloc(CHUNK_BYTES);
const timer = setInterval(() => {
  fs.writeSync(fd, silence, 0, silence.length, 44 + dataLength);
  dataLength += silence.length;
  process.stdout.write(silence);
}, CHUNK_MS);

timers.push(timer);
function after(envKey, fn) {
  const ms = Number(process.env[envKey]);
  if (Number.isFinite(ms) && ms >= 0) timers.push(setTimeout(fn, ms));
}

after("SB_FAKE_RECORDER_DEVICE_MS", () => say({ state: "device", systemAudio: false }));
after("SB_FAKE_RECORDER_STALL_MS", () => say({ state: "error", message: "stdout consumer stalled" }));

after("SB_FAKE_RECORDER_EXIT_MS", () => finish(Number(process.env.SB_FAKE_RECORDER_EXIT_CODE ?? 1)));
// No handler runs for SIGKILL: the header is left as it was, exactly like a crash.
after("SB_FAKE_RECORDER_KILL_MS", () => process.kill(process.pid, "SIGKILL"));

