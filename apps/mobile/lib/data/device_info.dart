import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';

class DeviceIdentity {
  const DeviceIdentity({required this.name, required this.platform});
  final String name;

  /// `android` | `ios`.
  final String platform;
}

abstract interface class DeviceIdentityProvider {
  Future<DeviceIdentity> read();
}

class PlatformDeviceIdentityProvider implements DeviceIdentityProvider {
  @override
  Future<DeviceIdentity> read() async {
    final plugin = DeviceInfoPlugin();
    try {
      if (Platform.isAndroid) {
        final a = await plugin.androidInfo;
        final name = '${a.manufacturer} ${a.model}'.trim();
        return DeviceIdentity(
          name: name.isEmpty ? 'Android' : name,
          platform: 'android',
        );
      }
      if (Platform.isIOS) {
        final i = await plugin.iosInfo;
        return DeviceIdentity(
          name: i.name.isEmpty ? 'iPhone' : i.name,
          platform: 'ios',
        );
      }
    } catch (_) {}
    return DeviceIdentity(
      name: 'Mobil qurilma',
      platform: Platform.isIOS ? 'ios' : 'android',
    );
  }
}
