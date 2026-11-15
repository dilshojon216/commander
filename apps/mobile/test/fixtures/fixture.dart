import 'dart:convert';
import 'dart:io';

/// `clients/fixtures/` (jonli center'dan olingan tozalangan javoblar): test paketi ildizidan nisbiy yo'l.
Object? fixture(String name) => jsonDecode(File('../../clients/fixtures/$name.json').readAsStringSync());

Map<String, dynamic> fixtureMap(String name) => (fixture(name) as Map).cast<String, dynamic>();

/// Chuqur nusxa + o'zgartirish.
Map<String, dynamic> patched(Map<String, dynamic> base, void Function(Map<String, dynamic>) patch) {
  final copy = jsonDecode(jsonEncode(base)) as Map<String, dynamic>;
  patch(copy);
  return copy;
}

Map<String, dynamic> sessionJson([void Function(Map<String, dynamic>)? patch]) {
  final first = ((fixtureMap('sessions')['items'] as List).first as Map).cast<String, dynamic>();
  return patch == null ? first : patched(first, patch);
}

Map<String, dynamic> commandJson({String status = 'awaiting_confirmation', bool stepUp = true, String? errorCode, Map<String, dynamic>? result}) => {
      'id': '11111111-1111-4111-8111-111111111111',
      'type': 'session.start',
      'status': status,
      'machineId': '185b42c0-0781-4f16-8936-12e044bdc818',
      'machineSlug': 'mac',
      'projectId': null,
      'sessionId': null,
      'claudeSessionId': null,
      'cwd': '/work/p',
      'permissionMode': 'default',
      'model': 'sonnet',
      'promptLength': 10,
      'promptPreview': 'salom',
      'requestedByDeviceId': '1819fdd5-f037-4625-8066-2e9ebcc7348b',
      'stepUp': {'required': stepUp, 'via': null, 'expiresAt': null, 'confirmedAt': null, 'confirmedByDeviceId': null},
      'errorCode': errorCode,
      'errorMessage': null,
      'result': result,
      'createdAt': '2026-11-14T04:00:00.000Z',
      'sentAt': null,
      'ackedAt': null,
      'finishedAt': null,
      'expiresAt': '2026-11-14T04:02:00.000Z',
    };
