#!/usr/bin/env node
'use strict';
/*
 * approval-queue-starter — a one-file job queue where AI proposes work
 * and a human taps Approve before anything runs.
 *
 * Zero dependencies. Node 18+.  Run:  node dispatcher.js
 * Then open http://127.0.0.1:4949
 *
 * The rules this thing lives by:
 *   1. Nothing runs without a tap.
 *   2. The journal is the truth (journal.jsonl).
 *   3. Jobs declare their own postconditions (mustExitZero, mustMatch).
 *   4. Timeouts are budgets, not suggestions (default 15m, cap 2h).
 *   5. Duplicate ids are refused, so history stays honest.
 *
 * MIT licensed. Read the README's security model before you tunnel this.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- config

const ROOT = process.env.QUEUE_ROOT ? path.resolve(process.env.QUEUE_ROOT) : process.cwd();
const PORT = Number(process.env.PORT || 4949);
const HOST = '127.0.0.1'; // never change this without reading the README
const TOKEN = process.env.APPROVAL_TOKEN || '';
const SCAN_MS = 2000;

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours — the cap a typo can't raise
const MAX_CAPTURE = 5 * 1024 * 1024; // keep the starter's memory honest

const DIR = {
  queue: path.join(ROOT, 'queue'),
  done: path.join(ROOT, 'queue', 'done'),
  invalid: path.join(ROOT, 'queue', 'invalid'),
  held: path.join(ROOT, 'pending-approval'),
  results: path.join(ROOT, 'results'),
};
const JOURNAL = path.join(ROOT, 'journal.jsonl');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// ---------------------------------------------------------------- state

/** id -> { id, title, cmd, workdir, timeoutMs, mustExitZero, mustMatch, file, heldAt } */
const held = new Map();
/** jobs approved and waiting for the single runner slot, in tap order */
const runQueue = [];
let running = null; // { id, startedAt, child }

// ---------------------------------------------------------------- helpers

function ensureDirs() {
  for (const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });
}

function journal(event, id, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, id, ...extra }) + '\n';
  fs.appendFileSync(JOURNAL, line, 'utf8');
  process.stdout.write(line);
}

function moveFile(from, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  const to = path.join(toDir, path.basename(from));
  try {
    fs.renameSync(from, to);
    return to;
  } catch (err) {
    // rename fails across volumes — fall back to copy+unlink rather than
    // deleting anything. If even that fails, journal it and leave the file
    // alone: a move we can't do is not a job we get to silently discard.
    try {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return to;
    } catch (err2) {
      journal('move-failed', path.basename(from), { to: toDir, reason: err2.message });
      return null;
    }
  }
}

// Killing the shell is not killing the job. `cmd` runs under a shell, so the
// thing doing the work is a *grandchild* — on Windows child.kill() leaves it
// alive and its open pipes mean 'close' never fires, so the kill never gets
// journaled and a runaway job looks like a hung one. Kill the whole tree.
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } // negative pid = the process group
    catch (_) { try { child.kill('SIGKILL'); } catch (__) {} }
  }
}

function alreadyRan(id) {
  // Rule 5: an id that already has results can never run again.
  return fs.existsSync(path.join(DIR.results, id + '.log'));
}

function humanMs(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------- intake

function parseJob(raw, file) {
  let job;
  try {
    job = JSON.parse(raw);
  } catch (err) {
    return { error: 'not valid JSON: ' + err.message };
  }
  if (!job || typeof job !== 'object') return { error: 'job must be a JSON object' };
  if (!ID_RE.test(String(job.id || ''))) {
    return { error: 'id must match [A-Za-z0-9_-] and be 1-80 chars' };
  }
  if (typeof job.cmd !== 'string' || !job.cmd.trim()) {
    return { error: 'cmd is required and must be a non-empty string' };
  }

  let timeoutMs = Number(job.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_TIMEOUT_MS);

  if (job.mustMatch != null) {
    try { new RegExp(job.mustMatch); }
    catch (err) { return { error: 'mustMatch is not a valid regex: ' + err.message }; }
  }

  return {
    job: {
      id: String(job.id),
      title: typeof job.title === 'string' ? job.title : '',
      cmd: job.cmd,
      workdir: typeof job.workdir === 'string' ? job.workdir : ROOT,
      timeoutMs,
      mustExitZero: job.mustExitZero === undefined ? true : !!job.mustExitZero,
      mustMatch: job.mustMatch == null ? null : String(job.mustMatch),
      file,
    },
  };
}

function scanQueue() {
  let entries;
  try { entries = fs.readdirSync(DIR.queue, { withFileTypes: true }); }
  catch (err) { return; }

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const file = path.join(DIR.queue, ent.name);

    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { continue; } // still being written; next scan picks it up

    const { job, error } = parseJob(raw, file);

    if (error) {
      journal('invalid', ent.name, { reason: error });
      moveFile(file, DIR.invalid);
      continue;
    }
    if (held.has(job.id) || (running && running.id === job.id) || runQueue.some((j) => j.id === job.id)) {
      journal('refused', job.id, { reason: 'a job with this id is already in flight' });
      moveFile(file, DIR.invalid);
      continue;
    }
    if (alreadyRan(job.id)) {
      journal('refused', job.id, { reason: 'duplicate id — results already exist; retries need a fresh id' });
      moveFile(file, DIR.invalid);
      continue;
    }

    const heldFile = moveFile(file, DIR.held);
    if (!heldFile) continue;
    job.file = heldFile;
    job.heldAt = new Date().toISOString();
    held.set(job.id, job);
    journal('held', job.id, { title: job.title, cmd: job.cmd, detail: 'pending approval' });
  }
}

// ---------------------------------------------------------------- runner

function approve(id, by) {
  const job = held.get(id);
  if (!job) return false;
  held.delete(id);
  runQueue.push(job);
  journal('approved', id, { title: job.title, by });
  pump();
  return true;
}

function reject(id, by) {
  const job = held.get(id);
  if (!job) return false;
  held.delete(id);
  journal('rejected', id, { title: job.title, by });
  moveFile(job.file, DIR.done);
  return true;
}

function pump() {
  if (running || runQueue.length === 0) return; // rule: one job at a time
  const job = runQueue.shift();
  runJob(job);
}

function runJob(job) {
  const startedAt = Date.now();
  const logPath = path.join(DIR.results, job.id + '.log');
  const stream = fs.createWriteStream(logPath, { flags: 'w' });
  stream.write(`# ${job.id} — ${job.title || '(no title)'}\n# started ${new Date(startedAt).toISOString()}\n# cmd: ${job.cmd}\n---\n`);

  const child = spawn(job.cmd, {
    shell: true,
    cwd: fs.existsSync(job.workdir) ? job.workdir : ROOT,
    env: process.env,
    detached: process.platform !== 'win32', // own process group, so killTree can take the group
  });

  running = { id: job.id, startedAt, child };
  journal('started', job.id, { title: job.title, pid: child.pid, timeoutMs: job.timeoutMs });

  let captured = '';
  let bytesOut = 0;
  let bytesErr = 0;
  let killReason = null;

  const absorb = (buf, isErr) => {
    if (isErr) bytesErr += buf.length; else bytesOut += buf.length;
    stream.write(buf);
    if (captured.length < MAX_CAPTURE) captured += buf.toString('utf8');
  };
  child.stdout.on('data', (b) => absorb(b, false));
  child.stderr.on('data', (b) => absorb(b, true));

  const timer = setTimeout(() => {
    killReason = `timeout (${humanMs(job.timeoutMs)} budget exceeded)`;
    killTree(child);
  }, job.timeoutMs);

  // A spawn that never starts is a failure like any other — never a silent one.
  child.on('error', (err) => {
    if (!killReason) killReason = 'spawn error: ' + err.message;
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const failures = [];

    if (killReason) failures.push(killReason);
    if (job.mustExitZero && code !== 0) failures.push(`mustExitZero: exit code ${code}`);
    if (job.mustMatch && !new RegExp(job.mustMatch).test(captured)) {
      failures.push(`mustMatch: /${job.mustMatch}/ not found in captured output`);
    }

    const status = killReason ? 'killed' : failures.length ? 'failed' : 'success';
    stream.end(`\n---\n# ${status} · exit ${code} · ${durationMs}ms\n${failures.map((f) => '# FAILED: ' + f).join('\n')}\n`);

    journal(killReason ? 'killed' : 'finished', job.id, {
      title: job.title,
      exitCode: code,
      bytesOut,
      bytesErr,
      durationMs,
      killReason,
      status,
      postconditionsFailed: failures.length ? failures : undefined,
    });

    moveFile(job.file, DIR.done);
    running = null;
    pump();
  });
}

// ---------------------------------------------------------------- web ui

function page() {
  const q = TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : '';
  const cards = [...held.values()].map((j) => `
    <div class="card">
      <div class="id">${esc(j.id)}</div>
      <div class="title">${esc(j.title || '(no title)')}</div>
      <pre class="cmd">${esc(j.cmd)}</pre>
      <div class="meta">budget ${humanMs(j.timeoutMs)} ·
        mustExitZero ${j.mustExitZero} ·
        mustMatch ${j.mustMatch ? esc(j.mustMatch) : '—'}</div>
      <div class="btns">
        <a class="ok" href="/approve/${encodeURIComponent(j.id)}${q}">Approve</a>
        <a class="no" href="/reject/${encodeURIComponent(j.id)}${q}">Reject</a>
      </div>
    </div>`).join('');

  const now = running
    ? `<div class="running">running: <b>${esc(running.id)}</b> · ${Math.round((Date.now() - running.startedAt) / 1000)}s</div>`
    : '<div class="running idle">idle</div>';

  const waiting = runQueue.length
    ? `<div class="running">approved, waiting for the runner: ${runQueue.map((j) => esc(j.id)).join(', ')}</div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>approval queue</title><style>
:root{color-scheme:dark}
body{background:#0d1117;color:#e6edf3;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0;padding:18px}
h1{font-size:17px;letter-spacing:.04em;margin:0 0 4px;color:#9da7b3;font-weight:600}
.sub{color:#6e7681;font-size:13px;margin-bottom:16px}
.running{background:#161b22;border-left:3px solid #3fb950;padding:9px 12px;border-radius:5px;margin-bottom:12px;font-size:14px}
.running.idle{border-left-color:#30363d;color:#6e7681}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:14px}
.id{color:#d29922;font-size:13px}
.title{margin:4px 0 8px;font-size:15px}
.cmd{background:#0d1117;border:1px solid #21262d;border-radius:5px;padding:9px;overflow-x:auto;font-size:13px;margin:0 0 8px;white-space:pre-wrap;word-break:break-all}
.meta{color:#6e7681;font-size:12px;margin-bottom:12px}
.btns{display:flex;gap:10px}
a.ok,a.no{flex:1;text-align:center;padding:13px;border-radius:6px;text-decoration:none;font-weight:600}
a.ok{background:#238636;color:#fff}
a.no{background:#21262d;color:#e6edf3;border:1px solid #30363d}
.empty{color:#6e7681;padding:26px 0;text-align:center}
</style></head><body>
<h1>APPROVAL QUEUE</h1>
<div class="sub">nothing runs until you tap. the journal is the truth.</div>
${now}${waiting}
${cards || '<div class="empty">no jobs held. drop one in <code>queue/</code>.</div>'}
<script>setTimeout(function(){location.reload()},4000)</script>
</body></html>`;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const send = (code, body, type) => {
    res.writeHead(code, { 'content-type': type || 'text/html; charset=utf-8' });
    res.end(body);
  };

  // Token gate. Set APPROVAL_TOKEN before you put this behind any tunnel.
  if (TOKEN && url.searchParams.get('t') !== TOKEN) {
    return send(403, 'forbidden — append ?t=<APPROVAL_TOKEN>', 'text/plain; charset=utf-8');
  }

  const q = TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : '';
  const redirect = () => { res.writeHead(302, { location: '/' + q }); res.end(); };

  const approveMatch = url.pathname.match(/^\/approve\/(.+)$/);
  if (approveMatch) {
    const id = decodeURIComponent(approveMatch[1]);
    const ok = approve(id, { auth: TOKEN ? 'token' : 'none', src: clientIp(req) });
    if (!ok) return send(404, 'no such held job: ' + esc(id), 'text/plain; charset=utf-8');
    return redirect();
  }

  const rejectMatch = url.pathname.match(/^\/reject\/(.+)$/);
  if (rejectMatch) {
    const id = decodeURIComponent(rejectMatch[1]);
    const ok = reject(id, { auth: TOKEN ? 'token' : 'none', src: clientIp(req) });
    if (!ok) return send(404, 'no such held job: ' + esc(id), 'text/plain; charset=utf-8');
    return redirect();
  }

  if (url.pathname === '/journal.jsonl') {
    const body = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : '';
    return send(200, body, 'text/plain; charset=utf-8');
  }

  if (url.pathname === '/') return send(200, page());
  return send(404, 'not found', 'text/plain; charset=utf-8');
});

// ---------------------------------------------------------------- boot

ensureDirs();
scanQueue();
setInterval(scanQueue, SCAN_MS);

server.listen(PORT, HOST, () => {
  console.log(`approval queue on http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`);
  console.log(`root: ${ROOT}`);
  if (!TOKEN) console.log('APPROVAL_TOKEN is not set — fine on localhost, required before any tunnel.');
});
