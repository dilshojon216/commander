import 'package:commander_contracts/commander_contracts.dart';

import '../core/network/api_client.dart';

/// Markaz REST sirti (`/v1`): javoblar generatsiya qilingan modellarga dekodlanadi.
/// Qo'lda DTO yo'q; faqat so'rov yo'llari va query'lar shu yerda.
class CenterApi {
  const CenterApi(this._c);
  final ApiClient _c;

  // --- identity ---
  Future<ClientPairResponse> pair(Uri center, ClientPairBody body) async =>
      ClientPairResponse.fromJson(
        await _c.postUnauthenticated(center, '/v1/clients/pair', body.toJson()),
      );

  Future<ClientDeviceMeResponse> me() async =>
      ClientDeviceMeResponse.fromJson(await _c.get('/v1/devices/me'));

  Future<void> revokeSelf() async {
    await _c.post('/v1/devices/me/revoke');
  }

  // --- o'qish ---
  Future<ListMachinesResponse> machines() async =>
      ListMachinesResponse.fromJson(await _c.get('/v1/machines'));

  Future<ListSessionsResponseV1> sessions({
    bool active = false,
    SessionStatus? status,
    String? project,
    int limit = 200,
    String? cursor,
  }) async => ListSessionsResponseV1.fromJson(
    await _c.get(
      '/v1/sessions',
      query: {
        if (active) 'active': '1',
        'status': status?.toJson(),
        'project': project,
        'limit': '$limit',
        'cursor': cursor,
      },
    ),
  );

  Future<SessionDto> session(String id) async =>
      SessionDto.fromJson(await _c.get('/v1/sessions/$id'));

  Future<ListProjectsResponse> projects() async =>
      ListProjectsResponse.fromJson(await _c.get('/v1/projects'));

  Future<ProjectDetailDto> project(String id) async =>
      ProjectDetailDto.fromJson(await _c.get('/v1/projects/$id'));

  Future<ProjectTasksResponse> projectTasks(String id) async =>
      ProjectTasksResponse.fromJson(await _c.get('/v1/projects/$id/tasks'));

  Future<UsageSummaryResponse> usageSummary() async =>
      UsageSummaryResponse.fromJson(await _c.get('/v1/usage/summary'));

  Future<UsageResponse> usage({
    required UsageBucket bucket,
    required DateTime from,
    required DateTime to,
    UsageGroupBy groupBy = UsageGroupBy.none,
    String? project,
  }) async => UsageResponse.fromJson(
    await _c.get(
      '/v1/usage',
      query: {
        'bucket': bucket.toJson(),
        'from': ContractDates.format(from),
        'to': ContractDates.format(to),
        'groupBy': groupBy.toJson(),
        'project': project,
      },
    ),
  );

  Future<LimitsResponse> limits() async =>
      LimitsResponse.fromJson(await _c.get('/v1/limits'));

  Future<ListApprovalsResponse> approvals() async =>
      ListApprovalsResponse.fromJson(await _c.get('/v1/approvals'));

  Future<ListAlertsResponse> alerts() async => ListAlertsResponse.fromJson(
    await _c.get('/v1/alerts', query: {'state': 'open'}),
  );

  Future<HealthSummaryResponse> healthSummary() async =>
      HealthSummaryResponse.fromJson(await _c.get('/v1/health/summary'));

  Future<ListQueueResponse> queue() async =>
      ListQueueResponse.fromJson(await _c.get('/v1/queue'));

  Future<ListTemplatesResponse> templates({String? projectId}) async =>
      ListTemplatesResponse.fromJson(
        await _c.get('/v1/templates', query: {'projectId': projectId}),
      );

  // --- yozish ---
  Future<ApprovalDecisionResponse> decide(
    String approvalId,
    ApprovalDecisionBody body,
  ) async => ApprovalDecisionResponse.fromJson(
    await _c.post('/v1/approvals/$approvalId/decision', body: body.toJson()),
  );

  Future<CreateCommandResponse> createCommand(
    CreateCommandBody body, {
    required String idempotencyKey,
  }) async => CreateCommandResponse.fromJson(
    await _c.post(
      '/v1/commands',
      body: body.toJson(),
      headers: {'Idempotency-Key': idempotencyKey},
    ),
  );

  Future<CommandDto> command(String id) async =>
      CommandDto.fromJson(await _c.get('/v1/commands/$id'));

  Future<void> cancelCommand(String id) async {
    await _c.post('/v1/commands/$id/cancel');
  }

  Future<void> cancelQueueItem(String id) async {
    await _c.post('/v1/queue/$id/cancel');
  }

  Future<RenderTemplateResponse> renderTemplate(
    String id,
    RenderTemplateBody body,
  ) async => RenderTemplateResponse.fromJson(
    await _c.post('/v1/templates/$id/render', body: body.toJson()),
  );
}
