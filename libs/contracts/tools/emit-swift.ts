import type { Decl, Prop, TypeRef } from './ir.ts';

const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open',
  'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break',
  'case', 'catch', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw',
  'switch', 'where', 'while', 'Any', 'as', 'await', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws', 'true', 'try', 'Type',
]);
/** Stdlib/Foundation nomlari bilan to'qnashuvdan saqlanish. */
const SWIFT_RESERVED_TYPES = new Set([
  'String', 'Int', 'Double', 'Bool', 'Array', 'Dictionary', 'Optional', 'Result', 'Error', 'Codable', 'Hashable', 'Sendable', 'Encoder',
  'Decoder', 'Void', 'Never', 'Any', 'Data', 'Date', 'URL', 'Set', 'Task', 'JSONValue', 'Encodable', 'Decodable', 'Equatable',
]);

const id = (s: string): string => (SWIFT_KEYWORDS.has(s) ? `\`${s}\`` : s);
export const swiftType = (name: string): string => (SWIFT_RESERVED_TYPES.has(name) ? `${name}Model` : name);

function ty(t: TypeRef): string {
  switch (t.k) {
    case 'string':
      return 'String';
    case 'int':
      return 'Int';
    case 'double':
      return 'Double';
    case 'bool':
      return 'Bool';
    case 'any':
      return 'JSONValue';
    case 'nullable':
      return `${ty(t.inner)}?`;
    case 'array':
      return `[${ty(t.item)}]`;
    case 'map':
      return `[String: ${ty(t.value)}]`;
    case 'ref':
      return swiftType(t.name);
  }
}

/** Bir qavat nullable'ni olib tashlaydi (decodeIfPresent uchun asos tip). */
const base = (t: TypeRef): TypeRef => (t.k === 'nullable' ? base(t.inner) : t);
const isOptional = (p: Prop): boolean => !p.required || p.type.k === 'nullable';
const propType = (p: Prop): string => (isOptional(p) ? `${ty(base(p.type))}?` : ty(p.type));
const swiftString = (s: string): string => JSON.stringify(s);
const doc = (d: string | undefined, indent: string): string =>
  d ? d.split('\n').map((l) => `${indent}/// ${l.trim()}`.trimEnd()).join('\n') + '\n' : '';

function emitObject(d: Extract<Decl, { kind: 'object' }>): string {
  const name = swiftType(d.name);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}public struct ${name}: Codable, Hashable, Sendable {`);
  for (const p of d.props) {
    L.push(`${doc(p.doc, '    ')}    public let ${id(p.name)}: ${propType(p)}`.replace(/^\n/, ''));
  }
  const params = d.props.filter((p) => p.constValue === undefined);
  const sig = params.map((p) => `${id(p.name)}: ${propType(p)}${isOptional(p) ? ' = nil' : ''}`).join(', ');
  L.push('');
  L.push(`    public init(${sig}) {`);
  for (const p of d.props) {
    if (p.constValue !== undefined) {
      L.push(`        self.${id(p.name)} = ${typeof p.constValue === 'string' ? swiftString(p.constValue) : String(p.constValue)}`);
    } else L.push(`        self.${id(p.name)} = ${id(p.name)}`);
  }
  L.push('    }');
  if (d.props.length > 0) {
    L.push('');
    const needRaw = d.props.some((p) => p.name !== p.json);
    L.push('    private enum CodingKeys: String, CodingKey {');
    for (const p of d.props) L.push(`        case ${id(p.name)}${needRaw && p.name !== p.json ? ` = ${swiftString(p.json)}` : ''}`);
    L.push('    }');
    L.push('');
    L.push('    public init(from decoder: Decoder) throws {');
    L.push('        let c = try decoder.container(keyedBy: CodingKeys.self)');
    for (const p of d.props) {
      const key = `.${id(p.name)}`;
      L.push(
        isOptional(p)
          ? `        self.${id(p.name)} = try c.decodeIfPresent(${ty(base(p.type))}.self, forKey: ${key})`
          : `        self.${id(p.name)} = try c.decode(${ty(p.type)}.self, forKey: ${key})`,
      );
    }
    L.push('    }');
    L.push('');
    L.push('    public func encode(to encoder: Encoder) throws {');
    L.push('        var c = encoder.container(keyedBy: CodingKeys.self)');
    for (const p of d.props) {
      const key = `.${id(p.name)}`;
      // required+nullable: aniq null yoziladi; ixtiyoriy: kalit tashlab ketiladi
      L.push(!p.required ? `        try c.encodeIfPresent(self.${id(p.name)}, forKey: ${key})` : `        try c.encode(self.${id(p.name)}, forKey: ${key})`);
    }
    L.push('    }');
  } else {
    L.push('');
    L.push('    public init(from decoder: Decoder) throws {}');
    L.push('    public func encode(to encoder: Encoder) throws { _ = encoder.container(keyedBy: AnyCodingKey.self) }');
  }
  L.push('}');
  return L.join('\n');
}

function emitEnum(d: Extract<Decl, { kind: 'enum' }>): string {
  const name = swiftType(d.name);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}/// Noma'lum (kelajakdagi) qiymatlar \`.unknown(raw)\` bo'lib dekodlanadi, xato tashlanmaydi.`);
  L.push(`public enum ${name}: Hashable, Sendable, Codable {`);
  for (const v of d.values) L.push(`    case ${id(v.id)}`);
  L.push('    case unknown(String)');
  L.push('');
  L.push('    public init(rawValue: String) {');
  L.push('        switch rawValue {');
  for (const v of d.values) L.push(`        case ${swiftString(v.raw)}: self = .${id(v.id)}`);
  L.push('        default: self = .unknown(rawValue)');
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    public var rawValue: String {');
  L.push('        switch self {');
  for (const v of d.values) L.push(`        case .${id(v.id)}: return ${swiftString(v.raw)}`);
  L.push('        case .unknown(let raw): return raw');
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    public init(from decoder: Decoder) throws {');
  L.push('        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))');
  L.push('    }');
  L.push('');
  L.push('    public func encode(to encoder: Encoder) throws {');
  L.push('        var c = encoder.singleValueContainer()');
  L.push('        try c.encode(rawValue)');
  L.push('    }');
  L.push('}');
  return L.join('\n');
}

function emitUnion(d: Extract<Decl, { kind: 'union' }>): string {
  const name = swiftType(d.name);
  const L: string[] = [];
  L.push(`${doc(d.doc, '')}/// Diskriminant: \`${d.discriminator}\`. Noma'lum qiymat \`.unknown(${d.discriminator}:raw:)\` bo'ladi.`);
  L.push(`public enum ${name}: Hashable, Sendable, Codable {`);
  for (const v of d.variants) L.push(`    case ${id(v.id)}(${swiftType(v.ref)})`);
  L.push(`    case unknown(${id(d.discriminator)}: String, raw: JSONValue)`);
  L.push('');
  L.push('    private enum TagKey: String, CodingKey {');
  L.push(`        case tag = ${swiftString(d.discriminator)}`);
  L.push('    }');
  L.push('');
  L.push('    public init(from decoder: Decoder) throws {');
  L.push('        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)');
  L.push('        switch tag {');
  for (const v of d.variants) L.push(`        case ${swiftString(v.tag)}: self = .${id(v.id)}(try ${swiftType(v.ref)}(from: decoder))`);
  L.push(`        default: self = .unknown(${id(d.discriminator)}: tag, raw: try JSONValue(from: decoder))`);
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push('    public func encode(to encoder: Encoder) throws {');
  L.push('        switch self {');
  for (const v of d.variants) L.push(`        case .${id(v.id)}(let value): try value.encode(to: encoder)`);
  L.push('        case .unknown(_, let raw): try raw.encode(to: encoder)');
  L.push('        }');
  L.push('    }');
  L.push('');
  L.push(`    /// Diskriminant qiymati (\`${d.discriminator}\`).`);
  L.push(`    public var ${id(d.discriminator)}: String {`);
  L.push('        switch self {');
  for (const v of d.variants) L.push(`        case .${id(v.id)}: return ${swiftString(v.tag)}`);
  L.push(`        case .unknown(let tag, _): return tag`);
  L.push('        }');
  L.push('    }');
  L.push('}');
  return L.join('\n');
}

export function emitSwift(decls: Decl[], constants: string): string {
  const parts = decls.map((d) => (d.kind === 'object' ? emitObject(d) : d.kind === 'enum' ? emitEnum(d) : emitUnion(d)));
  return [
    '// GENERATED by libs/contracts/tools/gen.ts from libs/contracts/generated/json-schema. DO NOT EDIT.',
    '// Regenerate: npm run -w libs/contracts gen:schema',
    '',
    'import Foundation',
    '',
    constants,
    '',
    parts.join('\n\n'),
    '',
  ].join('\n');
}
