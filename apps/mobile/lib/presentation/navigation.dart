import 'package:commander_contracts/commander_contracts.dart';
import 'package:flutter/material.dart';

import 'approval/approval_page.dart';
import 'new_session/new_session_page.dart';
import 'projects/project_detail_page.dart';
import 'queue/queue_page.dart';
import 'session/session_page.dart';
import 'settings/settings_page.dart';
import 'tokens/tokens_page.dart';

/// Ekranlararo o'tish (oddiy Navigator; cubit'lar sahifa ichida yaratiladi).
abstract final class Nav {
  static Future<T?> _push<T>(BuildContext c, Widget page) =>
      Navigator.of(c).push<T>(MaterialPageRoute(builder: (_) => page));

  static void session(BuildContext c, String id, {SessionDto? initial}) =>
      _push(c, SessionPage(sessionId: id, initial: initial));
  static void approval(BuildContext c, String id) =>
      _push(c, ApprovalPage(approvalId: id));
  static void project(BuildContext c, String id, String name) =>
      _push(c, ProjectDetailPage(projectId: id, name: name));
  static void tokens(BuildContext c) => _push(c, const TokensPage());
  static void queue(BuildContext c) => _push(c, const QueuePage());
  static void settings(BuildContext c) => _push(c, const SettingsPage());

  /// Yangi sessiya ochilsa, uning sessiya sahifasiga almashtiradi.
  static void newSession(BuildContext c, {String? machineId}) =>
      _push(c, NewSessionPage(machineId: machineId));

  static void replaceWithSession(BuildContext c, String id) => Navigator.of(c)
      .pushReplacement(
        MaterialPageRoute(builder: (_) => SessionPage(sessionId: id)),
      );
}
