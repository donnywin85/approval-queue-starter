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
| `cmd` | yes | **a shell command line**, parsed by your system shell and run as you on approval — read the [Security model](#security-model--read-this-before-you-write-your-first-job) before writing one |
| `workdir` | no | working directory (default: dispatcher's cwd) |
| `timeoutMs` | no | kill budget, default 900000 (15 min), cap 2 h |
| `mustExitZero` | no | default `true` |
| `mustMatch` | no | regex the captured output must contain |

Environment: `PORT` (default 4949), `APPROVAL_TOKEN` (see below), `QUEUE_ROOT` (default: cwd).

## Security model — read this before you write your first job

**A job's `cmd` is executed through a shell, with your privileges.** The dispatcher runs
`spawn(job.cmd, { shell: true })`, so your system shell — `/bin/sh -c` on Unix, `cmd.exe /c` on
Windows — parses the string, with everything that implies: pipes, redirects, `&&`, `;`, `` ` ``,
`$(...)`, globbing, variable expansion. The job runs **as the user running the dispatcher**, with
that user's files, SSH keys and cloud logins, and it **inherits the dispatcher's entire
environment** (`env: process.env`), so every secret exported in that shell is readable by the job.
There is no sandbox, no allowlist, and no argument-vector form. That is deliberate — running the
command you approved is the whole product — but it has three consequences you have to design for:

- **Treat the queue directory as code, not as data.** A file in `queue/` is a program that will run
  as you the moment you tap Approve. Anyone, or anything, that can write a file there can execute
  code as you. **Write-protect it**: keep it on a local disk, restrict it to your own account
  (`chmod 700 queue`, or remove inherited ACLs on Windows), and never point `QUEUE_ROOT` at a synced
  folder, a network share, a world-writable temp dir, or any path a web service can write to. The
  queue directory IS the security boundary — the approval tap only decides *when* it fires.
- **Never generate `cmd` from untrusted content.** If an agent composes a job from a web page, an
  email, an issue body, a filename, a model's own output, or anything else you did not write, that
  content is one `;` or `$(...)` away from *being* the command. Escaping is not a fix; there is no
  safe quoting. Build the command only from values you control, and when a job must act on external
  data, hand that data to **a script you wrote** via a file or stdin instead of splicing it into the
  command line.
- **Read the approval card as a command line, not as a task name.** Tapping Approve approves
  arbitrary shell, not a reviewed argument list. The card shows `cmd` verbatim for exactly that
  reason — read all of it, including whatever follows the first `&&`.

Then, for exposure:

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
