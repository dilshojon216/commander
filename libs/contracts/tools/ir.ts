/**
 * JSON Schema -> til-mustaqil oraliq model (IR). Swift va Dart generatorlari faqat shu modeldan chiqaradi.
 *
 * Qoidalar:
 *  - nomli sxema (fayl) obyekt/enum/diskriminantli union bo'lsa bitta e'lon (`Decl`), primitiv bo'lsa (masalan EpochMs)
 *    ishlatilgan joyga inline qilinadi;
 *  - nomsiz ichki obyekt/enum/union: ota nomi + maydon nomi (PascalCase) bilan e'lon qilinadi;
 *  - diskriminantli union: barcha variantlar obyekt va umumiy const-satr maydoni bor (`type` afzal, keyin `kind`);
 *  - boshqa har qanday murakkab union (anyOf) va `unknown` -> `any` (JSON qiymat).
 */

export type TypeRef =
  | { k: 'string' }
  | { k: 'int' }
  | { k: 'double' }
  | { k: 'bool' }
  | { k: 'any' }
  | { k: 'nullable'; inner: TypeRef }
  | { k: 'array'; item: TypeRef }
  | { k: 'map'; value: TypeRef }
  | { k: 'ref'; name: string };

export interface Prop {
  /** JSON kaliti (aynan simda ko'rinadigan). */
  json: string;
  /** camelCase identifikator (til kalit so'zlari generatorda tozalanadi). */
  name: string;
  type: TypeRef;
  required: boolean;
  /** const qiymat (diskriminant, `v: 1`): init'da parametr emas. */
  constValue?: string | number;
  doc?: string;
}

export interface EnumValue {
  raw: string;
  id: string;
}

export interface UnionVariant {
  tag: string;
  /** camelCase case nomi. */
  id: string;
  /** Variant obyekt e'loni nomi. */
  ref: string;
}

export type Decl =
  | { kind: 'object'; name: string; props: Prop[]; doc?: string }
  | { kind: 'enum'; name: string; values: EnumValue[]; doc?: string }
  | { kind: 'union'; name: string; discriminator: string; variants: UnionVariant[]; doc?: string };

type Json = Record<string, unknown>;

export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}

/** `device_id` -> `deviceId`, `session.start` -> `sessionStart`, `WARN` -> `warn`, `acceptEdits` -> `acceptEdits`. */
export function camel(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'value';
  const fix = (p: string, i: number): string => {
    const base = /^[A-Z0-9]+$/.test(p) ? p.toLowerCase() : p;
    return i === 0 ? base[0]!.toLowerCase() + base.slice(1) : base[0]!.toUpperCase() + base.slice(1);
  };
  const out = parts.map(fix).join('');
  return /^[0-9]/.test(out) ? `v${out}` : out;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Analyzer {
  readonly decls = new Map<string, Decl>();
  private readonly resolved = new Map<string, TypeRef>();
  private readonly taken = new Set<string>();

  private readonly schemas: ReadonlyMap<string, Json>;

  constructor(schemas: ReadonlyMap<string, Json>) {
    this.schemas = schemas;
    for (const name of schemas.keys()) this.taken.add(name);
  }

  run(): Decl[] {
    for (const name of [...this.schemas.keys()].sort()) this.named(name);
    return [...this.decls.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Nomli sxemani tahlil qiladi: e'lon yoki inline primitiv. */
  private named(name: string): TypeRef {
    const cached = this.resolved.get(name);
    if (cached) return cached;
    const schema = this.schemas.get(name);
    if (!schema) throw new Error(`ir: $ref noma'lum sxemaga: ${name}`);
    // Rekursiya (sikl) uchun oldindan ref belgilaymiz; primitiv bo'lsa keyin almashtiriladi.
    const ref: TypeRef = { k: 'ref', name };
    this.resolved.set(name, ref);
    const t = this.typeOf(schema, name, name);
    if (t.k === 'ref' && t.name === name) return ref;
    // Primitiv/array/map/any bo'lib chiqdi (e'lon yo'q): inline.
    if (!this.decls.has(name)) this.resolved.set(name, t);
    return this.resolved.get(name)!;
  }

  private uniqueName(hint: string): string {
    let n = hint;
    let i = 2;
    while (this.taken.has(n)) n = `${hint}${i++}`;
    this.taken.add(n);
    return n;
  }

  private declName(hint: string, own?: string): string {
    // Nomli sxemaning o'z e'loni o'z nomini oladi; ichkilari noyob nom oladi.
    return own && own === hint ? hint : this.uniqueName(hint);
  }

  private resolveRef(ref: string): Json | undefined {
    return this.schemas.get(ref.replace(/\.json$/, ''));
  }

  typeOf(node: unknown, hint: string, own?: string): TypeRef {
    if (!isObj(node)) return { k: 'any' };
    if (typeof node.$ref === 'string') {
      return this.named(node.$ref.replace(/\.json$/, ''));
    }
    const variants = (node.anyOf ?? node.oneOf) as unknown;
    if (Array.isArray(variants)) return this.unionOf(variants, hint, own, node);

    if ('const' in node) {
      if (typeof node.const === 'string') return { k: 'string' };
      if (typeof node.const === 'number') return Number.isInteger(node.const) ? { k: 'int' } : { k: 'double' };
      if (typeof node.const === 'boolean') return { k: 'bool' };
      return { k: 'any' };
    }
    if (Array.isArray(node.enum)) {
      if (node.enum.every((x) => typeof x === 'string')) return this.declareEnum(node.enum as string[], hint, own, node);
      return { k: 'any' };
    }
    let type = node.type;
    if (Array.isArray(type)) {
      const nonNull = type.filter((t) => t !== 'null');
      const hasNull = nonNull.length !== type.length;
      if (nonNull.length !== 1) return { k: 'any' };
      const inner = this.typeOf({ ...node, type: nonNull[0] }, hint, own);
      return hasNull ? { k: 'nullable', inner } : inner;
    }
    switch (type) {
      case 'string':
        return { k: 'string' };
      case 'integer':
        return { k: 'int' };
      case 'number':
        return { k: 'double' };
      case 'boolean':
        return { k: 'bool' };
      case 'null':
        return { k: 'nullable', inner: { k: 'any' } };
      case 'array': {
        if (Array.isArray(node.prefixItems)) return { k: 'any' };
        return { k: 'array', item: node.items === undefined ? { k: 'any' } : this.typeOf(node.items, `${hint}Item`) };
      }
      case 'object':
        return this.objectOf(node, hint, own);
      default:
        return { k: 'any' };
    }
  }

  private declareEnum(values: string[], hint: string, own: string | undefined, node: Json): TypeRef {
    const name = this.declName(hint, own);
    const used = new Set<string>(['unknown']);
    const vals: EnumValue[] = values.map((raw) => {
      let id = camel(raw === '' ? 'empty' : raw);
      if (id === 'unknown') id = 'unknownValue';
      let n = id;
      let i = 2;
      while (used.has(n)) n = `${id}${i++}`;
      used.add(n);
      return { raw, id: n };
    });
    this.decls.set(name, { kind: 'enum', name, values: vals, ...(typeof node.description === 'string' ? { doc: node.description } : {}) });
    return { k: 'ref', name };
  }

  private objectOf(node: Json, hint: string, own: string | undefined): TypeRef {
    const props = node.properties;
    if (!isObj(props)) {
      const ap = node.additionalProperties;
      if (isObj(ap) && Object.keys(ap).length > 0) return { k: 'map', value: this.typeOf(ap, `${hint}Value`) };
      if (ap === true || (isObj(ap) && Object.keys(ap).length === 0) || 'propertyNames' in node) return { k: 'map', value: { k: 'any' } };
      // `z.object({})`: bo'sh struct
    }
    const name = this.declName(hint, own);
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const out: Prop[] = [];
    const usedNames = new Set<string>();
    for (const [json, sub] of Object.entries(isObj(props) ? props : {})) {
      let id = camel(json);
      let n = id;
      let i = 2;
      while (usedNames.has(n)) n = `${id}${i++}`;
      usedNames.add(n);
      id = n;
      const s = isObj(sub) ? sub : {};
      const prop: Prop = { json, name: id, type: { k: 'any' }, required: required.has(json) };
      if (typeof s.description === 'string') prop.doc = s.description;
      if ('const' in s && (typeof s.const === 'string' || typeof s.const === 'number')) {
        prop.constValue = s.const;
        prop.type = typeof s.const === 'string' ? { k: 'string' } : Number.isInteger(s.const) ? { k: 'int' } : { k: 'double' };
      } else {
        prop.type = this.typeOf(sub, `${name}${pascal(json)}`);
      }
      out.push(prop);
    }
    this.decls.set(name, { kind: 'object', name, props: out, ...(typeof node.description === 'string' ? { doc: node.description } : {}) });
    return { k: 'ref', name };
  }

  private unionOf(variants: unknown[], hint: string, own: string | undefined, node: Json): TypeRef {
    const isNull = (v: unknown): boolean => isObj(v) && v.type === 'null';
    const nonNull = variants.filter((v) => !isNull(v));
    const nullable = nonNull.length !== variants.length;
    const wrap = (t: TypeRef): TypeRef => (nullable && t.k !== 'nullable' ? { k: 'nullable', inner: t } : t);
    if (nonNull.length === 0) return { k: 'nullable', inner: { k: 'any' } };
    if (nonNull.length === 1) return wrap(this.typeOf(nonNull[0], hint, own));

    // satr const/enum aralashmasi -> enum
    const strs: string[] = [];
    let allStr = true;
    for (const v of nonNull) {
      if (isObj(v) && typeof v.const === 'string') strs.push(v.const);
      else if (isObj(v) && Array.isArray(v.enum) && v.enum.every((x) => typeof x === 'string')) strs.push(...(v.enum as string[]));
      else allStr = false;
    }
    if (allStr) return wrap(this.declareEnum([...new Set(strs)], hint, own, node));

    // diskriminantli union
    const objs = nonNull.map((v) => this.asObject(v));
    if (objs.every((o) => o !== null)) {
      const disc = this.findDiscriminator(objs as Json[]);
      if (disc) {
        const name = this.declName(hint, own);
        const out: UnionVariant[] = [];
        const usedIds = new Set<string>();
        nonNull.forEach((v, idx) => {
          const o = objs[idx] as Json;
          const tag = ((o.properties as Json)[disc] as Json).const as string;
          let id = camel(tag);
          let n = id;
          let i = 2;
          while (usedIds.has(n)) n = `${id}${i++}`;
          usedIds.add(n);
          id = n;
          let ref: TypeRef;
          if (isObj(v) && typeof v.$ref === 'string') ref = this.named(v.$ref.replace(/\.json$/, ''));
          else ref = this.typeOf(v, `${name}${pascal(tag)}`);
          if (ref.k !== 'ref') throw new Error(`ir: ${name} varianti ${tag} obyekt emas`);
          out.push({ tag, id, ref: ref.name });
        });
        this.decls.set(name, { kind: 'union', name, discriminator: disc, variants: out, ...(typeof node.description === 'string' ? { doc: node.description } : {}) });
        return wrap({ k: 'ref', name });
      }
    }
    return wrap({ k: 'any' });
  }

  /** Variantni (ref yoki inline) obyekt sxemasi sifatida qaytaradi. */
  private asObject(v: unknown): Json | null {
    if (!isObj(v)) return null;
    if (typeof v.$ref === 'string') {
      const t = this.resolveRef(v.$ref);
      return t ? this.asObject(t) : null;
    }
    return v.type === 'object' && isObj(v.properties) ? v : null;
  }

  private findDiscriminator(objs: Json[]): string | null {
    const first = objs[0]!.properties as Json;
    const candidates = Object.keys(first).filter((k) => objs.every((o) => {
      const p = (o.properties as Json)[k];
      return isObj(p) && typeof p.const === 'string' && (o.required as string[] | undefined)?.includes(k);
    }));
    if (candidates.length === 0) return null;
    const pick = ['type', 'kind'].find((k) => candidates.includes(k)) ?? candidates.sort()[0]!;
    const tags = objs.map((o) => ((o.properties as Json)[pick] as Json).const as string);
    return new Set(tags).size === tags.length ? pick : null;
  }
}

export function analyze(files: { name: string; schema: Json }[]): Decl[] {
  return new Analyzer(new Map(files.map((f) => [f.name, f.schema]))).run();
}
