import type { Decl, Prop, TypeRef } from './ir.ts';

/** Dart zaxiralangan/ichki so'zlar: maydon nomiga `_` qo'shiladi. */
const DART_KEYWORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'covariant', 'default', 'deferred',
  'do', 'dynamic', 'else', 'enum', 'export', 'extends', 'extension', 'external', 'factory', 'false', 'final', 'finally', 'for', 'get',
  'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library', 'mixin', 'new', 'null', 'of', 'on', 'operator', 'part',
  'required', 'rethrow', 'return', 'set', 'show', 'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var',
  'void', 'while', 'with', 'yield', 'hashCode', 'runtimeType', 'toString', 'noSuchMethod', 'values', 'index', 'name',
]);
const DART_RESERVED_TYPES = new Set([
  'String', 'int', 'double', 'bool', 'List', 'Map', 'Object', 'Type', 'Function', 'Null', 'Set', 'Future', 'Stream', 'Iterable', 'Enum',
  'Record', 'Duration', 'DateTime', 'Uri', 'Error', 'Exception', 'Symbol', 'Never', 'Comparable', 'Pattern', 'Match', 'Sink',
]);

const id = (s: string): string => (DART_KEYWORDS.has(s) ? `${s}_` : s);
export const dartType = (name: string): string => (DART_RESERVED_TYPES.has(name) ? `${name}Model` : name);
const lit = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;

function ty(t: TypeRef): string {
  switch (t.k) {
    case 'string':
      return 'String';
    case 'int':
      return 'int';
    case 'double':
      return 'double';
    case 'bool':
      return 'bool';
    case 'any':
      return 'Object?';
    case 'nullable':
      return t.inner.k === 'any' ? 'Object?' : `${ty(t.inner)}?`;
    case 'array':
      return `List<${ty(t.item)}>`;
    case 'map':
      return `Map<String, ${ty(t.value)}>`;
    case 'ref':
      return dartType(t.name);
  }
}

const isOptional = (p: Prop): boolean => !p.required || p.type.k === 'nullable';
const propType = (p: Prop): string => {
  const t = ty(p.type.k === 'nullable' ? p.type.inner : p.type);
  return isOptional(p) && !t.endsWith('?') ? `${t}?` : t;
};
const doc = (d: string | undefined, indent: string): string =>
  d ? d.split('\n').map((l) => `${indent}/// ${l.trim()}`.trimEnd()).join('\n') + '\n' : '';

/** JSON qiymatdan (expr: Object?) `t` tipidagi ifoda (null'siz holat uchun). */
function dec(expr: string, t: TypeRef): string {
  switch (t.k) {
    case 'string':
      return `${expr} as String`;
    case 'int':
      return `(${expr} as num).toInt()`;
    case 'double':
      return `(${expr} as num).toDouble()`;
    case 'bool':
      return `${expr} as bool`;
    case 'any':
      return expr;
    case 'nullable':
      return t.inner.k === 'any' ? expr : `${expr} == null ? null : ${dec(expr, t.inner)}`;
    case 'array':
      return `(${expr} as List<dynamic>).map((e) => ${dec('e', t.item)}).toList()`;
    case 'map':
      return `(${expr} as Map<String, dynamic>).map((k, v) => MapEntry(k, ${dec('v', t.value)}))`;
    case 'ref':
      return `${dartType(t.name)}.fromJson(${expr})`;
  }
}

function enc(expr: string, t: TypeRef): string {
  switch (t.k) {
    case 'string':
    case 'int':
    case 'double':
    case 'bool':
    case 'any':
      return expr;
    case 'nullable':
    {
      if (t.inner.k === 'any') return expr;
      const inner = enc(`${expr}!`, t.inner);
      return inner === `${expr}!` ? expr : `${expr} == null ? null : ${inner}`;
    }
    case 'array':
      return t.item.k === 'ref' || t.item.k === 'array' || t.item.k === 'map' || t.item.k === 'nullable'
        ? `${expr}.map((e) => ${enc('e', t.item)}).toList()`
        : expr;
    case 'map':
      return t.value.k === 'ref' || t.value.k === 'array' || t.value.k === 'map' || t.value.k === 'nullable'
        ? `${expr}.map((k, v) => MapEntry(k, ${enc('v', t.value)}))`
        : expr;
    case 'ref':
      return `${expr}.toJson()`;
  }
}

/** Ref'lar (obyekt/enum/union) `fromJson(Object?)` qabul qiladi (enum), obyekt/union Map kutadi: tip aniqligi uchun cast. */
function emitObject(d: Extract<Decl, { kind: 'object' }>, kinds: Map<string, Decl['kind']>): string {
  const name = dartType(d.name);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}final class ${name} {`);
  for (const p of d.props) L.push(`${doc(p.doc, '  ')}  final ${propType(p)} ${id(p.name)};`);
  const params = d.props.filter((p) => p.constValue === undefined);
  L.push('');
  if (params.length === 0 && d.props.length === 0) L.push(`  const ${name}();`);
  else {
    const consts = d.props.filter((p) => p.constValue !== undefined);
    const ctorParams = params.map((p) => `${isOptional(p) ? '' : 'required '}this.${id(p.name)}`);
    const inits = consts.map((p) => `${id(p.name)} = ${typeof p.constValue === 'string' ? lit(p.constValue) : String(p.constValue)}`);
    L.push(`  const ${name}(${ctorParams.length ? `{${ctorParams.join(', ')}}` : ''})${inits.length ? ` : ${inits.join(', ')}` : ''};`);
  }
  L.push('');
  L.push(`  factory ${name}.fromJson(Object? raw) {`);
  if (d.props.length > 0) L.push('    final json = raw as Map<String, dynamic>;');
  L.push(`    return ${name}(`);
  for (const p of params) {
    const access = `json[${lit(p.json)}]`;
    const t = p.type;
    let expr: string;
    if (isOptional(p)) {
      const inner = t.k === 'nullable' ? t.inner : t;
      expr = inner.k === 'any' ? access : `${access} == null ? null : ${dec(access, inner)}`;
    } else expr = dec(access, t);
    L.push(`      ${id(p.name)}: ${expr},`);
  }
  L.push('    );');
  L.push('  }');
  L.push('');
  L.push('  Map<String, dynamic> toJson() => {');
  for (const p of d.props) {
    const f = id(p.name);
    const t = p.type.k === 'nullable' ? p.type.inner : p.type;
    const valueExpr = isOptional(p) ? enc(f, { k: 'nullable', inner: t }) : enc(f, p.type);
    if (!p.required) {
      // ixtiyoriy: null bo'lsa kalit yozilmaydi
      L.push(`        if (${f} != null) ${lit(p.json)}: ${t.k === 'any' ? f : enc(`${f}!`, t)},`);
    } else {
      L.push(`        ${lit(p.json)}: ${valueExpr},`);
    }
  }
  L.push('      };');
  L.push('}');
  void kinds;
  return L.join('\n');
}

function emitEnum(d: Extract<Decl, { kind: 'enum' }>): string {
  const name = dartType(d.name);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}/// Noma'lum (kelajakdagi) qiymat \`${name}.unknown\` bo'lib dekodlanadi (xato tashlanmaydi).`);
  L.push(`enum ${name} {`);
  for (const v of d.values) L.push(`  ${v.id === 'value' ? 'value_' : id(v.id)}(${lit(v.raw)}),`);
  L.push("  unknown('');");
  L.push('');
  L.push(`  const ${name}(this.value);`);
  L.push('');
  L.push('  /// Simdagi qiymat (`unknown` uchun bo\'sh satr).');
  L.push('  final String value;');
  L.push('');
  L.push(`  factory ${name}.fromJson(Object? raw) {`);
  L.push(`    for (final e in ${name}.values) {`);
  L.push('      if (e != unknown && e.value == raw) return e;');
  L.push('    }');
  L.push('    return unknown;');
  L.push('  }');
  L.push('');
  L.push('  String toJson() => value;');
  L.push('}');
  return L.join('\n');
}

function emitUnion(d: Extract<Decl, { kind: 'union' }>, declNames: ReadonlySet<string>): string {
  const name = dartType(d.name);
  /** Variant o'rami sinfi: inline variant obyekti bilan nom to'qnashsa `Case` qo'shimchasi. */
  const wrap = (v: { id: string }): string => (declNames.has(`${d.name}${cap(v.id)}`) ? `${name}${cap(v.id)}Case` : `${name}${cap(v.id)}`);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}/// Diskriminant: \`${d.discriminator}\`. Noma'lum qiymat \`${name}Unknown\` bo'ladi (xom JSON saqlanadi).`);
  L.push(`sealed class ${name} {`);
  L.push(`  const ${name}();`);
  L.push('');
  L.push(`  factory ${name}.fromJson(Object? raw) {`);
  L.push('    final json = raw as Map<String, dynamic>;');
  L.push(`    switch (json[${lit(d.discriminator)}]) {`);
  for (const v of d.variants) L.push(`      case ${lit(v.tag)}:\n        return ${wrap(v)}(${dartType(v.ref)}.fromJson(json));`);
  L.push(`      default:\n        return ${name}Unknown(json);`);
  L.push('    }');
  L.push('  }');
  L.push('');
  L.push(`  /// Diskriminant qiymati (\`${d.discriminator}\`).`);
  L.push('  String get tag;');
  L.push('');
  L.push('  Map<String, dynamic> toJson();');
  L.push('}');
  for (const v of d.variants) {
    L.push('');
    L.push(`final class ${wrap(v)} extends ${name} {`);
    L.push(`  const ${wrap(v)}(this.value);`);
    L.push(`  final ${dartType(v.ref)} value;`);
    L.push('  @override');
    L.push(`  String get tag => ${lit(v.tag)};`);
    L.push('  @override');
    L.push('  Map<String, dynamic> toJson() => value.toJson();');
    L.push('}');
  }
  L.push('');
  L.push(`final class ${name}Unknown extends ${name} {`);
  L.push(`  const ${name}Unknown(this.raw);`);
  L.push('  final Map<String, dynamic> raw;');
  L.push('  @override');
  L.push(`  String get tag => (raw[${lit(d.discriminator)}] as String?) ?? '';`);
  L.push('  @override');
  L.push('  Map<String, dynamic> toJson() => raw;');
  L.push('}');
  return L.join('\n');
}

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

export function emitDart(decls: Decl[], constants: string): string {
  const kinds = new Map(decls.map((d) => [d.name, d.kind] as const));
  const names = new Set(decls.map((d) => d.name));
  const parts = decls.map((d) => (d.kind === 'object' ? emitObject(d, kinds) : d.kind === 'enum' ? emitEnum(d) : emitUnion(d, names)));
  return [
    '// GENERATED by libs/contracts/tools/gen.ts from libs/contracts/generated/json-schema. DO NOT EDIT.',
    '// Regenerate: npm run -w libs/contracts gen:schema',
    '// ignore_for_file: type=lint',
    '',
    constants,
    '',
    parts.join('\n\n'),
    '',
  ].join('\n');
}
