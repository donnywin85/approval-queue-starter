# approval-queue-starter

**A one-file job queue where AI proposes work and a human taps Approve before anything runs.**

Zero dependencies. One file. Node 18+.

## Measured, not promised

This is the stripped-down version of a pattern that runs a real, small, unglamorous online business —
data APIs, a public dashboard, a newsletter that drafts itself from measured data. Through this exact
loop, agents have deployed services, repaired a newsletter that contradicted its own data, rotated a
compromised credential, and shut down a five-hour data-exfiltration incident while I was at my day job.
Not one of those actions ran without a human tap first. I'm not selling you a number: the business it
came from made **zero dollars** last month, and every claim on this page is something you can reproduce
by running the file. That's the whole standard here — measured, not promised.

## The pattern, in five lines

1. An agent (or you) writes a job as a small JSON file into `queue/` — a title, a shell command, and the
   conditions its output must satisfy.
2. The dispatcher picks it up and **holds** it. Nothing runs yet.
3. You open the page — on your phone, from anywhere — read what the job intends to do, and tap **Approve**.
4. It runs, one job at a time, under a hard time budget, with all output captured to `results/<id>.log`.
5. Every state change — held, approved, started, finished, killed — appends to `journal.jsonl`. If the
   journal doesn't say it happened, it didn't happen.

## Quickstart

```bash
mkdir my-queue && cd my-queue
curl -O https://raw.githubusercontent.com/donnywin85/approval-queue-starter/main/dispatcher.js
node dispatcher.js
# open http://127.0.0.1:4949
```

Drop a job in:

```bash
mkdir -p queue
cat > queue/hello.json << 'EOF'
{
  "id": "hello",
  "title": "prove the loop works",
  "cmd": "echo it ran && echo VERDICT: DONE",
  "mustMatch": "VERDICT: DONE"
}
EOF
```

Refresh the page → the job is **held** with an Approve button. Tap it. Output lands in
`results/hello.log`, the job file archives to `queue/done/`, and the lifecycle lands in
`journal.jsonl`:

```json
{"ts":"...","event":"held","id":"hello","title":"prove the loop works","detail":"pending approval"}
{"ts":"...","event":"approved","id":"hello","by":{"auth":"token","src":"127.0.0.1"}}
{"ts":"...","event":"started","id":"hello","pid":9828,"timeoutMs":900000}
{"ts":"...","event":"finished","id":"hello","exitCode":0,"bytesOut":24,"durationMs":13,"status":"success"}
```

## The rules this thing lives by

1. **Nothing runs without a tap.** Every job is held, no matter how safe it looks. Templates that
   auto-run "safe" jobs are how surprises happen.
2. **The journal is the truth.** Folders lie (a running job's file sits in `pending-approval/` until it
   finishes). If `journal.jsonl` doesn't say it happened, it didn't happen.
3. **Jobs declare their own postconditions.** `mustExitZero` (default on) and `mustMatch` (a regex the
   output must contain). A job that can't prove it did the work reports `failed`, loudly, with reasons.
4. **Timeouts are budgets, not suggestions.** Default 15 min, cap 2 h. A silent job dies at its budget,
   the whole process tree gets killed, and the kill is journaled.
5. **Duplicate ids are refused.** A job id that already has results can never run again — retries get
   fresh ids, so history stays honest.

## Job file reference

| field | required | meaning |
|---|---|---|
| `id` | yes | unique, `[A-Za-z0-9_-]`, max 80 chars |
| `title` | no | what + why, shown on the approval card |
| `cmd` | yes | shell command to run on approval |
| `workdir` | no | working directory (default: dispatcher's cwd) |
| `timeoutMs` | no | kill budget, default 900000 (15 min), cap 2 h |
| `mustExitZero` | no | default `true` |
| `mustMatch` | no | regex the captured output must contain |

Environment: `PORT` (default 4949), `APPROVAL_TOKEN` (see below), `QUEUE_ROOT` (default: cwd).

## Security model — read before tunneling

- **Jobs are arbitrary shell commands.** Anyone who can write to `queue/` can run code as you the moment
  you tap Approve. The queue directory IS the security boundary.
- The web UI binds `127.0.0.1` only. To approve from your phone, put it behind **your own authenticated
  tunnel** (Cloudflare Tunnel + Access, Tailscale Serve, etc). Never expose the raw port.
- Set `APPROVAL_TOKEN=something-long` and the Approve/Reject links require it. Do this before any tunnel.
- This starter runs **one job at a time** on purpose — a serial queue is auditable; a parallel one is a party.

## Where this pattern goes next

The production version this was distilled from adds: per-job soft-timeout declarations, a denylist that
auto-holds jobs touching secrets, postcondition sets, result files with machine-checkable verdict lines,
and watchdog sensors that alert when the queue itself dies. Build those when you need them — the one-file
version is the working core.

---

### Where this came from

I have a full-time job. In the evenings, AI agents build and run a real online business, and everything I
publish about it is a real log with a real timestamp — including the quiet weeks and the small numbers.

- **Newsletter** — the week's measurements, free, every Monday: **https://arbdatadesk.beehiiv.com**
- **Live dashboard** — the public one this queue operates, updated hourly:
  **https://arb-dex-data-production.up.railway.app/dashboard**

MIT licensed — see [LICENSE](LICENSE).
