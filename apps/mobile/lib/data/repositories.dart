import 'package:commander_contracts/commander_contracts.dart';

import '../core/util/ids.dart';
import 'center_api.dart';

/// Sessiyalar o'qish.
class SessionsRepository {
  const SessionsRepository(this._api);
  final CenterApi _api;

  Future<List<SessionDto>> active() async =>
      (await _api.sessions(active: true)).items;
  Future<List<SessionDto>> byStatus(SessionStatus s) async =>
      (await _api.sessions(status: s, limit: 100)).items;
  Future<SessionDto> get(String id) => _api.session(id);
}

/// Loyihalar va ish maydoni (faqat o'qish).
class ProjectsRepository {
  const ProjectsRepository(this._api);
  final CenterApi _api;

  Future<ListProjectsResponse> list() => _api.projects();
  Future<ProjectDetailDto> detail(String id) => _api.project(id);
  Future<ProjectTasksResponse> tasks(String id) => _api.projectTasks(id);

  /// Loyiha kunlik tokenlari (oxirgi [days] kun).
  Future<UsageResponse> daily(String id, {int days = 14}) {
    final to = DateTime.now().toUtc();
    return _api.usage(
      bucket: UsageBucket.v1d,
      from: to.subtract(Duration(days: days)),
      to: to,
      project: id,
    );
  }
}

/// Tokenlar tahlili.
class UsageRepository {
  const UsageRepository(this._api);
  final CenterApi _api;

  Future<UsageResponse> series({
    required int days,
    UsageGroupBy groupBy = UsageGroupBy.none,
  }) {
    final to = DateTime.now().toUtc();
    return _api.usage(
      bucket: UsageBucket.v1d,
      from: to.subtract(Duration(days: days)),
      to: to,
      groupBy: groupBy,
    );
  }
}

/// Navbat (ro'yxat + bekor qilish).
class QueueRepository {
  const QueueRepository(this._api);
  final CenterApi _api;

  Future<List<QueueItemDto>> list() async => (await _api.queue()).items;
  Future<void> cancel(String id) => _api.cancelQueueItem(id);
}

/// Boshqaruv: ruxsat qarori, buyruqlar.
class ControlRepository {
  const ControlRepository(this._api);
  final CenterApi _api;

  Future<ApprovalDecisionResponse> decide(
    String approvalId,
    ApprovalBehavior behavior, {
    String? message,
    List<AskAnswer>? answers,
  }) => _api.decide(
    approvalId,
    ApprovalDecisionBody(
      behavior: behavior,
      message: message,
      answers: answers,
    ),
  );

  Future<CreateCommandResponse> startSession({
    required String machineId,
    required String cwd,
    required String prompt,
    String? model,
    required RemotePermissionMode mode,
    bool remoteControl = false,
    String? idempotencyKey,
  }) => _api.createCommand(
    CreateCommandBodySessionStartCase(
      CreateCommandBodySessionStart(
        machineId: machineId,
        cwd: cwd,
        prompt: prompt,
        model: model,
        permissionMode: mode,
        remoteControl: remoteControl ? true : null,
      ),
    ),
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
  );

  Future<CreateCommandResponse> prompt(
    String sessionId,
    String text, {
    String? idempotencyKey,
  }) => _api.createCommand(
    CreateCommandBodySessionPromptCase(
      CreateCommandBodySessionPrompt(sessionId: sessionId, text: text),
    ),
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
  );

  Future<CreateCommandResponse> stop(String sessionId) => _api.createCommand(
    CreateCommandBodySessionStopCase(
      CreateCommandBodySessionStop(sessionId: sessionId),
    ),
    idempotencyKey: newIdempotencyKey(),
  );

  Future<CreateCommandResponse> remoteControl(
    String sessionId, {
    required bool enable,
  }) => _api.createCommand(
    CreateCommandBodySessionRemoteControlCase(
      CreateCommandBodySessionRemoteControl(
        sessionId: sessionId,
        enable: enable,
      ),
    ),
    idempotencyKey: newIdempotencyKey(),
  );

  Future<CommandDto> command(String id) => _api.command(id);
  Future<void> cancelCommand(String id) => _api.cancelCommand(id);

  Future<List<TemplateDto>> templates({String? projectId}) async =>
      (await _api.templates(projectId: projectId)).items;
  Future<RenderTemplateResponse> renderTemplate(
    String id, {
    String? projectId,
  }) => _api.renderTemplate(id, RenderTemplateBody(projectId: projectId));
}
