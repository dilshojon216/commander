import { camel } from './ir.ts';

/** Klientlarga kerakli skalyar/massiv konstantalar (eksport nomi). Qiymatlar contracts'dan olinadi, qo'lda yozilmaydi. */
export const CONSTANT_NAMES: readonly string[] = [
  'AGENT_PROTOCOL_VERSION',
  'CLIENT_WS_PATH',
  'CLIENT_WS_SUBPROTOCOL',
  'CLIENT_WS_TOKEN_SUBPROTOCOL_PREFIX',
  'CLIENT_WS_CLOSE',
  'CLIENT_LIMITS',
  'CLIENT_CHANNELS',
  'CLIENT_TOKEN_PREFIX',
  'CLIENT_TOKEN_SCOPES',
  'CLIENT_DEVICE_KINDS',
  'CLIENT_PAIRING_KINDS',
  'PAIRING_SCOPES',
  'CLIENT_PAIRING_CODE_LENGTH',
  'CLIENT_PAIRING_DEFAULT_TTL_MINUTES',
  'CLIENT_PAIRING_TOKEN_DAYS',
  'PAIRING_URL_SCHEME',
  'SESSION_STATUSES',
];

type Scalar = string | number | boolean;
export type ConstValue = Scalar | Scalar[];
export interface FlatConstant {
  name: string;
  value: ConstValue;
}

export function collectConstants(ns: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of CONSTANT_NAMES) {
    if (!(n in ns)) throw new Error(`gen: konstanta topilmadi: ${n}`);
    out[n] = ns[n];
  }
  return out;
}

/** CLIENT_WS_CLOSE.authFailed -> `clientWsCloseAuthFailed`. Faqat skalyar, skalyar massiv va skalyar obyektlar. */
export function flatten(consts: Record<string, unknown>): FlatConstant[] {
  const out: FlatConstant[] = [];
  const isScalar = (v: unknown): v is Scalar => ['string', 'number', 'boolean'].includes(typeof v);
  for (const [name, value] of Object.entries(consts)) {
    const base = camel(name.toLowerCase());
    if (isScalar(value)) out.push({ name: base, value });
    else if (Array.isArray(value) && value.every(isScalar)) out.push({ name: base, value: value as Scalar[] });
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!isScalar(v)) throw new Error(`gen: ${name}.${k} skalyar emas`);
        out.push({ name: `${base}${k[0]!.toUpperCase()}${k.slice(1)}`, value: v });
      }
    } else throw new Error(`gen: ${name} qo'llab-quvvatlanmaydigan konstanta`);
  }
  return out;
}

const q = (s: string): string => JSON.stringify(s);

export function swiftConstants(items: FlatConstant[]): string {
  const L = ['/// Kontrakt konstantalari (contracts\'dan generatsiya qilingan).', 'public enum CommanderContract {'];
  for (const { name, value } of items) {
    if (Array.isArray(value)) L.push(`    public static let ${name}: [${typeof value[0] === 'number' ? 'Int' : 'String'}] = [${value.map((v) => (typeof v === 'string' ? q(v) : String(v))).join(', ')}]`);
    else if (typeof value === 'string') L.push(`    public static let ${name} = ${q(value)}`);
    else if (typeof value === 'boolean') L.push(`    public static let ${name} = ${value}`);
    else L.push(`    public static let ${name}: ${Number.isInteger(value) ? 'Int' : 'Double'} = ${value}`);
  }
  L.push('}');
  return L.join('\n');
}

export function dartConstants(items: FlatConstant[]): string {
  const dq = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
  const L = ["/// Kontrakt konstantalari (contracts'dan generatsiya qilingan).", 'abstract final class CommanderContract {'];
  for (const { name, value } of items) {
    if (Array.isArray(value)) L.push(`  static const ${name} = <${typeof value[0] === 'number' ? 'int' : 'String'}>[${value.map((v) => (typeof v === 'string' ? dq(v) : String(v))).join(', ')}];`);
    else if (typeof value === 'string') L.push(`  static const ${name} = ${dq(value)};`);
    else if (typeof value === 'boolean') L.push(`  static const ${name} = ${value};`);
    else L.push(`  static const ${name} = ${value};`);
  }
  L.push('}');
  return L.join('\n');
}
