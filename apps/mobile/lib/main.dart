import 'package:flutter/material.dart';

import 'app_dependencies.dart';
import 'presentation/app/app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(CommanderApp(deps: AppDependencies.production()));
}
