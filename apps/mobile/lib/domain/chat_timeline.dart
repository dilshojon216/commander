import 'package:commander_contracts/commander_contracts.dart';

/// Chat elementlarini render modeliga yig'adi: upsert (bir xil `id` almashtiradi),
/// `usage` o'z `requestId` li oxirgi element ostida, `tool_use` + `tool_result` juftlanadi.
sealed class ChatEntry {
  const ChatEntry(this.id);
  final String id;
}

class UserEntry extends ChatEntry {
  const UserEntry(this.item) : super('u');
  final ChatUserItem item;
  @override
  String get id => item.id;
}

class AssistantEntry extends ChatEntry {
  const AssistantEntry(this.item, this.usage) : super('a');
  final ChatAssistantItem item;
  final ChatUsageItem? usage;
  @override
  String get id => item.id;
}

class ToolEntry extends ChatEntry {
  const ToolEntry(this.use, this.result) : super('t');
  final ChatToolUseItem use;
  final ChatToolResultItem? result;
  @override
  String get id => use.id;
}

class NoticeEntry extends ChatEntry {
  const NoticeEntry(this.item) : super('n');
  final ChatNoticeItem item;
  @override
  String get id => item.id;
}

class ChangedFile {
  const ChangedFile(this.path, this.added, this.removed);
  final String path;
  final int added;
  final int removed;
}

const _editTools = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'};

String chatItemId(ChatItem i) => switch (i) {
  ChatItemUser(:final value) => value.id,
  ChatItemAssistant(:final value) => value.id,
  ChatItemThinking(:final value) => value.id,
  ChatItemToolUse(:final value) => value.id,
  ChatItemToolResult(:final value) => value.id,
  ChatItemNotice(:final value) => value.id,
  ChatItemUsage(:final value) => value.id,
  ChatItemUnknown(:final raw) => 'unknown:${raw.hashCode}',
};

int chatItemTs(ChatItem i) => switch (i) {
  ChatItemUser(:final value) => value.ts,
  ChatItemAssistant(:final value) => value.ts,
  ChatItemThinking(:final value) => value.ts,
  ChatItemToolUse(:final value) => value.ts,
  ChatItemToolResult(:final value) => value.ts,
  ChatItemNotice(:final value) => value.ts,
  ChatItemUsage(:final value) => value.ts,
  ChatItemUnknown() => 0,
};

class ChatTimeline {
  const ChatTimeline({
    this.items = const [],
    this.olderCursor,
    this.reachedStart = false,
  });

  final List<ChatItem> items;

  /// Keyingi eski sahifa uchun `before`.
  final String? olderCursor;

  /// `cursor: null` kelgan: fayl boshiga yetildi.
  final bool reachedStart;

  ChatTimeline apply(ChatItemsToClientPayload p) {
    var list = List<ChatItem>.of(items);
    if (p.replace == true) list = [];
    if (p.older == true) {
      final existing = {for (final i in list) chatItemId(i)};
      final fresh = p.items
          .where((i) => !existing.contains(chatItemId(i)))
          .toList();
      list = [...fresh, ...list];
    } else {
      for (final it in p.items) {
        final id = chatItemId(it);
        final idx = list.indexWhere((e) => chatItemId(e) == id);
        if (idx >= 0) {
          list[idx] = it;
        } else {
          list.add(it);
        }
      }
    }
    final isHistory = p.replace == true || p.older == true;
    return ChatTimeline(
      items: list,
      olderCursor: isHistory ? p.cursor : olderCursor,
      reachedStart: isHistory ? p.cursor == null : reachedStart,
    );
  }

  List<ChatEntry> get entries {
    final usageByRequest = <String, ChatUsageItem>{};
    final results = <String, ChatToolResultItem>{};
    for (final i in items) {
      if (i is ChatItemUsage) usageByRequest[i.value.requestId] = i.value;
      if (i is ChatItemToolResult) results[i.value.toolUseId] = i.value;
    }
    final out = <ChatEntry>[];
    final usedUsage = <String>{};
    final pairedResults = <String>{};
    for (final i in items) {
      switch (i) {
        case ChatItemUser(:final value):
          out.add(UserEntry(value));
        case ChatItemAssistant(:final value):
          out.add(AssistantEntry(value, null));
        case ChatItemToolUse(:final value):
          final r = results[value.toolUseId];
          if (r != null) pairedResults.add(r.id);
          out.add(ToolEntry(value, r));
        case ChatItemNotice(:final value):
          out.add(NoticeEntry(value));
        case ChatItemToolResult(:final value):
          // juftsiz natija (tool_use eski sahifada qolgan): alohida blok
          if (!items.any(
            (e) => e is ChatItemToolUse && e.value.toolUseId == value.toolUseId,
          )) {
            out.add(
              ToolEntry(
                ChatToolUseItem(
                  id: 'orphan:${value.id}',
                  ts: value.ts,
                  toolUseId: value.toolUseId,
                  toolName: value.toolName ?? 'tool',
                  summary: '',
                ),
                value,
              ),
            );
          }
        case ChatItemThinking() || ChatItemUsage() || ChatItemUnknown():
          break;
      }
    }
    // usage: shu requestId li OXIRGI assistant/tool elementi ostida
    for (var k = out.length - 1; k >= 0; k--) {
      final e = out[k];
      final rid = switch (e) {
        AssistantEntry(:final item) => item.requestId,
        ToolEntry(:final use) => use.requestId,
        _ => null,
      };
      if (rid == null || usedUsage.contains(rid)) continue;
      final u = usageByRequest[rid];
      if (u == null) continue;
      usedUsage.add(rid);
      if (e is AssistantEntry) out[k] = AssistantEntry(e.item, u);
    }
    return out;
  }

  /// O'zgargan fayllar (Edit/Write tool'laridan).
  List<ChangedFile> get changedFiles {
    final map = <String, (int, int)>{};
    for (final i in items) {
      if (i is! ChatItemToolUse || !_editTools.contains(i.value.toolName))
        continue;
      final path = i.value.summary
          .replaceFirst(RegExp(r'^\w+:\s*'), '')
          .replaceAll(RegExp(r'\s*\([+\-−]\d+.*\)$'), '')
          .trim();
      if (path.isEmpty) continue;
      final cur = map[path] ?? (0, 0);
      map[path] = (
        cur.$1 + (i.value.lines?.added ?? 0),
        cur.$2 + (i.value.lines?.removed ?? 0),
      );
    }
    return [
      for (final e in map.entries) ChangedFile(e.key, e.value.$1, e.value.$2),
    ];
  }
}
