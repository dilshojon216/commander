import type { INestApplicationContext } from '@nestjs/common';
import type { parseArgs as ParseArgs } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { ListAuditQuerySchema, PutHealthThresholdsBodySchema, buildPairingUrl, parsePairingUrl } from '@commander/contracts';
import type { AdminCenterKeyShow, AdminDeviceList, AdminEnrollCodeList, AdminLockdownStatus, AdminTelegramList, AdminTelegramPending, AdminTokenList } from '@commander/contracts';
import { AuditService } from '../identity/audit/audit.service.js';
import { CenterKeyAdminService } from '../identity/center-key-admin.service.js';
import { DeviceKeysService } from '../identity/devices/device-keys.service.js';
import { DevicesService } from '../identity/devices/devices.service.js';
import { EnrollmentService } from '../identity/enrollment/enrollment.service.js';
import { PairingService } from '../identity/pairing/pairing.service.js';
import { LockdownService } from '../identity/lockdown/lockdown.service.js';
import { ClientTokensService } from '../identity/tokens/client-tokens.service.js';
import { HealthThresholdsService } from '../health/health-thresholds.service.js';
import { RetentionService } from '../retention/retention.service.js';
import { deviceEntry, enrollCodeEntry, telegramEntries, telegramPendingEntry, tokenEntry } from './admin-json.js';
import { encodeQr, renderQr } from './qr.js';
import { isChatId } from '../telegram/chat-ids.js';
import { TelegramAccessService } from '../telegram/telegram-access.service.js';

const VIA = 'cli';

export const USAGE = `Commander admin CLI

  enroll-code create --kind agentd --machine-name <name> [--ttl-minutes 15] [--json]
  enroll-code list [--json]
  token create --kind <web|menubar|mobile|telegram> --name <name> --scopes <read,approve,control,admin> [--expires-days N | --no-expiry] [--json]   (default expiry: 90 days)
  token list [--json]
  client pair --kind <menubar|mobile> --name <name> --scopes <read,approve[,control]> [--ttl-minutes 10] [--expires-days 90]
              [--center-url https://...] [--fingerprint <fp>] [--json]   (bir martalik pairing kodi + terminal QR)
  token revoke <id>
  token rotate <id> [--grace-hours 24] [--expires-days N] [--inherit-stepup-exempt] [--json]
              (yangi token chiqaradi; eski token grace'dan keyin yaroqsiz, 0 = darhol bekor qilinadi)
  device list [--json]      (--json: machineId ham bor: qurilma <-> mashina)
  device revoke <id>        (ochiq WS ulanishi darhol, 4010 bilan uziladi)
  device require-rotation <id>   (agentd kalitini aylantirishi talab qilinadi; agentd o'zi bajaradi)
  lockdown <on|off|status> [--json]
  telegram pending [--json]   (allowlist'da yo'q /start yuboruvchilar: chat id + username)
  telegram allow <chatId>     (allowlist'ga qo'shadi, audit; env bilan birlashadi)
  telegram remove <chatId>    (DB allowlist'dan olib tashlaydi, qurilmani revoke qiladi)
  telegram list [--json]
  audit verify
  audit list [--limit N] [--before <id>] [--action <name>] [--json]   (oxirgi yozuvlar; sukut 50, eng ko'pi 200)
  health thresholds get [--json]
  health thresholds set --body '<json>' [--json]   (body = PUT /v1/health/thresholds tanasi: {"defaults":{...},"machines":{"<uuid>":{...}|null}}; audit)
  center-key show             (buyruq-imzo kaliti: public key + fingerprint + ustma-ust tushish oynasi)
  center-key rotate [--overlap-days 30]   (yangi imzo kaliti; agentlar pin'ni eski kalit imzosi bilan TOFUsiz yangilaydi)
  retention status            (retention/compression siyosatlari va jadval qatorlari soni)

Secrets (enrollment code, token) are printed ONCE to stdout and never stored in plaintext.
`;

type Parse = typeof ParseArgs;

const print = (line: string): void => void process.stdout.write(`${line}\n`);

export async function runCli(app: INestApplicationContext, argv: string[], parseArgs: Parse): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      kind: { type: 'string' },
      'machine-name': { type: 'string' },
      name: { type: 'string' },
      scopes: { type: 'string' },
      'ttl-minutes': { type: 'string' },
      'expires-days': { type: 'string' },
      'no-expiry': { type: 'boolean', default: false },
      'grace-hours': { type: 'string' },
      'overlap-days': { type: 'string' },
      'inherit-stepup-exempt': { type: 'boolean', default: false },
      'center-url': { type: 'string' },
      fingerprint: { type: 'string' },
      json: { type: 'boolean', default: false },
      limit: { type: 'string' },
      before: { type: 'string' },
      action: { type: 'string' },
      body: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [group, action, arg] = positionals;
  const json = (v: unknown): void => print(JSON.stringify(v));
  if (values.help || !group) {
    process.stderr.write(USAGE);
    return values.help ? 0 : 2;
  }

  const num = (v: string | undefined, label: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
    return n;
  };

  if (group === 'enroll-code' && action === 'create') {
    const created = await app.get(EnrollmentService).createCode(
      { kind: values.kind ?? '', machineName: values['machine-name'] ?? '', ttlMinutes: num(values['ttl-minutes'], '--ttl-minutes') },
      VIA,
    );
    if (values.json) print(JSON.stringify(created));
    else {
      print(`Enrollment code: ${created.code}`);
      print(`Machine name:    ${created.machine_name}`);
      print(`Expires at:      ${created.expires_at}  (single use)`);
      print(`Code id:         ${created.id}`);
    }
    return 0;
  }
  if (group === 'enroll-code' && action === 'list') {
    const rows = await app.get(EnrollmentService).listCodes();
    if (values.json) {
      const out: AdminEnrollCodeList = { items: rows.map((r) => enrollCodeEntry(r)) };
      json(out);
      return 0;
    }
    for (const r of rows) {
      const state = r.used_at ? 'used' : r.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
      print(`${r.id}  ${state.padEnd(8)}  ${r.machine_name}  expires ${r.expires_at.toISOString()}`);
    }
    return 0;
  }
  if (group === 'token' && action === 'create') {
    const issued = await app.get(ClientTokensService).issue(
      {
        kind: values.kind ?? '',
        name: values.name ?? '',
        scopes: (values.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        expiresInDays: num(values['expires-days'], '--expires-days'),
        neverExpires: values['no-expiry'] === true,
      },
      VIA,
    );
    if (values.json) print(JSON.stringify(issued));
    else {
      print(`Token:      ${issued.token}`);
      print(`Id:         ${issued.id}`);
      print(`Kind/name:  ${issued.kind} / ${issued.name}`);
      print(`Scopes:     ${issued.scopes.join(',')}`);
      print(`Expires at: ${issued.expires_at ?? 'never'}`);
      if (issued.expires_at === null) process.stderr.write('WARNING: this token never expires. Prefer the default 90 days (omit --no-expiry) and rotate it.\n');
      process.stderr.write('Store the token now: it cannot be shown again.\n');
    }
    return 0;
  }
  if (group === 'client' && action === 'pair') {
    const config = app.get(ConfigService);
    const centerUrl = values['center-url'] ?? config.get<string>('CENTER_PUBLIC_URL');
    if (!centerUrl) throw new Error('center URL required: pass --center-url https://<host> or set CENTER_PUBLIC_URL');
    const base = centerUrl.replace(/\/+$/, '');
    // Noto'g'ri manzil kodni behuda sarflamasin: avval tekshiramiz.
    if (!parsePairingUrl(buildPairingUrl({ centerUrl: base, code: 'CHECK' }))) throw new Error('center URL must be https://<host> (or http://127.0.0.1 for dev)');
    const fingerprint = values.fingerprint ?? (config.get<string>('CENTER_PUBLIC_FINGERPRINT') || undefined);
    const created = await app.get(PairingService).createCode(
      {
        kind: values.kind ?? '',
        name: values.name ?? '',
        scopes: (values.scopes ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        ttlMinutes: num(values['ttl-minutes'], '--ttl-minutes'),
        expiresDays: num(values['expires-days'], '--expires-days'),
      },
      VIA,
    );
    const url = buildPairingUrl({ centerUrl: base, code: created.code, fingerprint });
    if (values.json) print(JSON.stringify({ id: created.id, code: created.code, url, expires_at: created.expires_at, kind: created.kind, scopes: created.scopes }));
    else {
      print(renderQr(encodeQr(url)));
      print('');
      print(`Pairing code: ${created.code}`);
      print(`URL:          ${url}`);
      print(`Kind/name:    ${created.kind} / ${created.name}`);
      print(`Scopes:       ${created.scopes.join(',')}${created.scopes.includes('control') ? '  (control: step-up still applies)' : ''}`);
      print(`Expires at:   ${created.expires_at}  (single use; token valid ${created.token_days} days)`);
      print(`Code id:      ${created.id}`);
      process.stderr.write('Scan the QR in the app or type the code. It cannot be shown again.\n');
    }
    return 0;
  }
  if (group === 'token' && action === 'list') {
    const tokens = await app.get(ClientTokensService).list();
    if (values.json) {
      const out: AdminTokenList = { items: tokens.map((d) => tokenEntry(d)) };
      json(out);
      return 0;
    }
    for (const d of tokens) {
      print(`${d.id}  ${d.revokedAt ? 'revoked' : 'active '}  ${d.kind}/${d.name}  [${d.scopes.join(',')}]  last_used ${d.lastUsedAt?.toISOString() ?? 'never'}  expires ${d.expiresAt?.toISOString() ?? 'never'}${!d.revokedAt && !d.expiresAt ? '  !! NO EXPIRY: rotate with `token rotate <id> --expires-days 90`' : ''}`);
    }
    return 0;
  }
  if (group === 'token' && action === 'revoke' && arg) {
    const d = await app.get(DevicesService).revoke(arg, 'client', VIA);
    print(`Token ${d.id} (${d.kind}/${d.name}) revoked`);
    return 0;
  }
  if (group === 'token' && action === 'rotate' && arg) {
    const graceRaw = values['grace-hours'];
    const graceHours = graceRaw === undefined ? 24 : Number(graceRaw);
    const rotated = await app.get(ClientTokensService).rotate(
      arg,
      { graceHours, expiresInDays: num(values['expires-days'], '--expires-days'), inheritStepUpExempt: values['inherit-stepup-exempt'] === true },
      VIA,
    );
    if (values.json) print(JSON.stringify(rotated));
    else {
      print(`New token:  ${rotated.token}`);
      print(`New id:     ${rotated.id}`);
      print(`Kind/name:  ${rotated.kind} / ${rotated.name}   Scopes: ${rotated.scopes.join(',')}`);
      print(`Expires at: ${rotated.expires_at ?? 'never'}`);
      print(rotated.grace_ends_at ? `Old token ${rotated.rotated_from} stays valid until ${rotated.grace_ends_at} (grace), then becomes invalid` : `Old token ${rotated.rotated_from} revoked immediately`);
      if (rotated.stepup_exempt_inherited) print('Step-up exemption inherited by the new token');
      process.stderr.write('Store the new token now: it cannot be shown again. Update the client before the grace period ends.\n');
    }
    return 0;
  }
  if (group === 'device' && action === 'require-rotation' && arg) {
    const d = await app.get(DeviceKeysService).requireRotation(arg, VIA);
    print(`Device ${d.id} (${d.name}) must rotate its key: agentd does it automatically (now if connected, else on its next connection)`);
    return 0;
  }
  if (group === 'device' && action === 'list') {
    const devices = (await app.get(DevicesService).list()).filter((x) => x.kind === 'agentd');
    if (values.json) {
      const out: AdminDeviceList = { items: devices.map(deviceEntry) };
      json(out);
      return 0;
    }
    for (const d of devices) {
      print(`${d.id}  ${d.revokedAt ? 'revoked' : 'active '}  machine ${d.machineId}  ${d.name}  last_used ${d.lastUsedAt?.toISOString() ?? 'never'}`);
    }
    return 0;
  }
  if (group === 'device' && action === 'revoke' && arg) {
    const d = await app.get(DevicesService).revoke(arg, 'agentd', VIA);
    print(`Device ${d.id} (${d.name}) revoked`);
    return 0;
  }
  if (group === 'lockdown' && (action === 'on' || action === 'off')) {
    const state = await app.get(LockdownService).set(action === 'on', VIA);
    if (values.json) json({ enabled: state.enabled, since: state.since } satisfies AdminLockdownStatus);
    else print(`Lockdown ${state.enabled ? 'ON' : 'OFF'}`);
    return 0;
  }
  if (group === 'center-key' && action === 'show') {
    const st = app.get(CenterKeyAdminService).status();
    if (values.json) json({ public_key: st.publicKey, fingerprint: st.fingerprint, overlap: st.overlap } satisfies AdminCenterKeyShow);
    else {
      print(`Center command-signing public key: ${st.publicKey}`);
      print(`Fingerprint:                       ${st.fingerprint}   (agentd: "agentd center-key show" shows the pinned one)`);
      for (const o of st.overlap) print(`Overlap: ${o.fromFingerprint} -> ${o.toFingerprint}  until ${o.expiresAt}`);
    }
    return 0;
  }
  if (group === 'center-key' && action === 'rotate') {
    const r = await app.get(CenterKeyAdminService).rotate(num(values['overlap-days'], '--overlap-days'), VIA);
    print(`Center signing key rotated: ${r.previousFingerprint} -> ${r.newFingerprint}`);
    print(`Overlap window until ${r.expiresAt}: online agents pin the new key automatically (signed by the old key).`);
    print('Agents that stay offline past the window need "agentd center-key reset" (compare the fingerprint above).');
    return 0;
  }
  if (group === 'lockdown' && action === 'status') {
    const s = await app.get(LockdownService).state();
    if (values.json) {
      json({ enabled: s.enabled, since: s.since } satisfies AdminLockdownStatus);
      return 0;
    }
    print(`Lockdown ${s.enabled ? 'ON' : 'OFF'}${s.since ? ` (since ${s.since})` : ''}`);
    return 0;
  }
  if (group === 'telegram' && action === 'pending') {
    const pending = await app.get(TelegramAccessService).listPending();
    if (values.json) {
      json({ items: pending.map(telegramPendingEntry) } satisfies AdminTelegramPending);
      return 0;
    }
    if (pending.length === 0) print('No pending chats (send /start to the bot first; entries expire after 1 hour)');
    for (const p of pending) {
      const ago = Math.max(0, Math.round((Date.now() - p.at) / 60_000));
      print(`${p.chatId}  ${p.username ? `@${p.username}` : '-'}  ${p.name ?? '-'}  ${ago} min ago`);
    }
    if (pending.length > 0) print('Allow with: telegram allow <chatId>');
    return 0;
  }
  if (group === 'telegram' && action === 'allow' && arg) {
    if (!isChatId(arg)) throw new Error('chatId must be a positive integer (private chat id)');
    const r = await app.get(TelegramAccessService).allow(arg, VIA);
    print(r.added ? `Chat ${arg} allowed (device ${r.deviceId})` : `Chat ${arg} was already allowed in the DB allowlist (device ${r.deviceId})`);
    return 0;
  }
  if (group === 'telegram' && action === 'remove' && arg) {
    if (!isChatId(arg)) throw new Error('chatId must be a positive integer');
    const r = await app.get(TelegramAccessService).remove(arg, VIA);
    print(r.removed ? `Chat ${arg} removed from the DB allowlist, telegram device revoked` : `Chat ${arg} was not in the DB allowlist (device revoked if it existed)`);
    if (r.stillInEnv) print('WARNING: this id is also in TELEGRAM_ALLOWED_CHAT_IDS (env): remove it there and restart the app');
    return 0;
  }
  if (group === 'telegram' && action === 'list') {
    const svc = app.get(TelegramAccessService);
    const entries = telegramEntries(svc.envIds(), await svc.dbIds());
    if (values.json) json({ items: entries } satisfies AdminTelegramList);
    else for (const e of entries) print(`${e.chatId}  ${e.source}`);
    return 0;
  }
  if (group === 'retention' && action === 'status') {
    const st = await app.get(RetentionService).status();
    if (values.json) print(JSON.stringify(st));
    else {
      for (const j of st.jobs) print(`${j.proc_name.padEnd(36)} ${(j.target ?? '-').padEnd(30)} ${JSON.stringify(Object.fromEntries(Object.entries(j.config ?? {}).filter(([k]) => /after|offset/.test(k))))}`);
      print('');
      print(`Rows: ${Object.entries(st.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      print(`Chunks (compressed/total): ${st.chunks.map((c) => `${c.table}=${c.compressed}/${c.total}`).join(' ')}`);
      print(st.problems.length === 0 ? 'Policies: OK' : `Policies: ${st.problems.length} problem(s)`);
      for (const p of st.problems) print(`  - ${p}`);
    }
    return st.problems.length === 0 ? 0 : 3;
  }
  if (group === 'audit' && action === 'verify') {
    const r = await app.get(AuditService).verify();
    print(r.ok ? `OK: chain intact (${r.checked_rows} rows)` : `BROKEN: first broken row id ${r.first_broken_id} (${r.checked_rows} rows)`);
    return r.ok ? 0 : 3;
  }

  if (group === 'audit' && action === 'list') {
    const q = ListAuditQuerySchema.safeParse({ limit: values.limit, before: values.before, action: values.action });
    if (!q.success) throw new Error(`invalid audit list options: ${q.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}`);
    const page = await app.get(AuditService).list(q.data);
    if (values.json) json(page);
    else {
      for (const e of page.items) print(`${e.id}  ${e.ts}  ${e.actor_kind.padEnd(8)}  ${e.action}${e.target ? `  ${e.target}` : ''}`);
      if (page.next_before) print(`More: --before ${page.next_before}`);
    }
    return 0;
  }
  if (group === 'health' && action === 'thresholds' && (arg === 'get' || arg === 'set')) {
    const svc = app.get(HealthThresholdsService);
    if (arg === 'set') {
      if (!values.body) throw new Error('health thresholds set requires --body \'<json>\' (PUT /v1/health/thresholds body)');
      let raw: unknown;
      try {
        raw = JSON.parse(values.body);
      } catch {
        throw new Error('--body must be valid JSON');
      }
      const parsed = PutHealthThresholdsBodySchema.safeParse(raw);
      if (!parsed.success) throw new Error(`invalid thresholds body: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
      const body = parsed.data;
      // Audit amaldan OLDIN (fail-closed): "audit yozuvisiz amal yo'q". HTTP yo'li bilan bir xil action nomi.
      await app.get(AuditService).record({
        actorKind: 'system',
        action: 'health.thresholds.update',
        details: { via: VIA, defaults_keys: Object.keys(body.defaults ?? {}), machine_ids: Object.keys(body.machines ?? {}), body },
      });
      const updated = await svc.put(body);
      if (values.json) json(updated);
      else print('Thresholds updated (a running center may take up to 30 s to pick them up)');
      return 0;
    }
    const current = await svc.get();
    if (values.json) json(current);
    else {
      print(`Defaults: ${JSON.stringify(current.defaults)}`);
      for (const [id, patch] of Object.entries(current.machines)) print(`Machine ${id}: ${JSON.stringify(patch)}`);
    }
    return 0;
  }

  process.stderr.write(`Unknown command\n\n${USAGE}`);
  return 2;
}
