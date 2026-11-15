import 'package:commander_contracts/commander_contracts.dart';
import 'package:commander_mobile/domain/chat_timeline.dart';
import 'package:flutter_test/flutter_test.dart';

ChatItem user(String id, String text) => ChatItem.fromJson({'id': id, 'ts': 1, 'kind': 'user', 'text': text, 'variant': 'prompt'});
ChatItem asst(String id, String text, {String? rid}) => ChatItem.fromJson({'id': id, 'ts': 2, 'kind': 'assistant', 'text': text, 'requestId': ?rid});
ChatItem toolUse(String id, String tuid, {String name = 'Bash', String summary = 'npm test', String? rid, Map<String, int>? lines}) =>
    ChatItem.fromJson({'id': id, 'ts': 3, 'kind': 'tool_use', 'toolUseId': tuid, 'toolName': name, 'summary': summary, 'requestId': ?rid, 'lines': ?lines});
ChatItem toolResult(String id, String tuid, {bool ok = true}) =>
    ChatItem.fromJson({'id': id, 'ts': 4, 'kind': 'tool_result', 'toolUseId': tuid, 'ok': ok, 'text': 'natija', 'truncated': false});
ChatItem usage(String rid) => ChatItem.fromJson({'id': 'usage:$rid', 'ts': 5, 'kind': 'usage', 'requestId': rid, 'inputTokens': 10, 'outputTokens': 20, 'cacheReadTokens': 30, 'cacheCreationTokens': 0});

ChatItemsToClientPayload payload(List<ChatItem> items, {bool? replace, bool? older, String? cursor}) =>
    ChatItemsToClientPayload(sessionId: 's', items: items, replace: replace, older: older, cursor: cursor);

void main() {
  test('upsert: bir xil id oldingisini almashtiradi', () {
    var t = const ChatTimeline().apply(payload([asst('a1', 'hi')]));
    t = t.apply(payload([asst('a1', 'hi there'), user('u2', 'yana')]));
    expect(t.items, hasLength(2));
    final e = t.entries.first as AssistantEntry;
    expect(e.item.text, 'hi there');
  });

  test('replace ro\'yxatni almashtiradi, older boshiga qo\'shadi va cursor\'ni yangilaydi', () {
    var t = const ChatTimeline().apply(payload([user('u3', 'c')], replace: true, cursor: 'cur1'));
    expect(t.olderCursor, 'cur1');
    t = t.apply(payload([user('u1', 'a'), user('u2', 'b')], older: true, cursor: null));
    expect(t.entries.map((e) => e.id), ['u1', 'u2', 'u3']);
    expect(t.reachedStart, isTrue);
    t = t.apply(payload([user('x', 'x')], replace: true, cursor: 'c2'));
    expect(t.items, hasLength(1));
    expect(t.reachedStart, isFalse);
  });

  test("usage shu requestId li assistant ostiga yig'iladi (alohida element emas)", () {
    final t = const ChatTimeline().apply(payload([asst('a1', 'javob', rid: 'r1'), usage('r1')]));
    expect(t.entries, hasLength(1));
    expect((t.entries.single as AssistantEntry).usage?.outputTokens, 20);
  });

  test('tool_use + tool_result juftlanadi; juftsiz natija alohida blok', () {
    var t = const ChatTimeline().apply(payload([toolUse('t1', 'tu1'), toolResult('r1', 'tu1', ok: false)]));
    expect(t.entries, hasLength(1));
    final e = t.entries.single as ToolEntry;
    expect(e.result?.ok, isFalse);
    t = const ChatTimeline().apply(payload([toolResult('r9', 'tu9')]));
    expect(t.entries.single, isA<ToolEntry>());
  });

  test("o'zgargan fayllar Edit/Write'dan yig'iladi", () {
    final t = const ChatTimeline().apply(payload([
      toolUse('t1', 'a', name: 'Edit', summary: 'Edit: src/app.ts (+12 −3)', lines: {'added': 12, 'removed': 3}),
      toolUse('t2', 'b', name: 'Edit', summary: 'Edit: src/app.ts (+1 −0)', lines: {'added': 1, 'removed': 0}),
      toolUse('t3', 'c', name: 'Bash', summary: 'ls'),
    ]));
    expect(t.changedFiles, hasLength(1));
    expect(t.changedFiles.single.path, 'src/app.ts');
    expect(t.changedFiles.single.added, 13);
  });

  test("noma'lum chat elementi yiqitmaydi", () {
    final t = const ChatTimeline().apply(payload([ChatItem.fromJson({'kind': 'future_kind', 'id': 'z'}), user('u', 'x')]));
    expect(t.entries, hasLength(1));
  });
}
