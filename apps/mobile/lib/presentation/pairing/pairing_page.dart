import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../data/pairing_repository.dart';
import '../auth/auth_cubit.dart';
import '../widgets/common.dart';

/// Juftlash: QR skaner, havolani qo'yish yoki markaz URL + kod.
class PairingPage extends StatefulWidget {
  const PairingPage({super.key});
  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  final _link = TextEditingController();
  final _url = TextEditingController();
  final _code = TextEditingController();

  @override
  void dispose() {
    _link.dispose();
    _url.dispose();
    _code.dispose();
    super.dispose();
  }

  void _submit() {
    final auth = context.read<AuthCubit>();
    final input = PairingInput.parse(
      link: _link.text,
      centerUrl: _url.text,
      code: _code.text,
    );
    if (input == null) {
      auth.pairingInputError(
        "Havola yoki (markaz https manzili + kod) noto'g'ri. Havola commander://pair?c=…&code=… ko'rinishida bo'ladi.",
      );
      return;
    }
    auth.pair(input);
  }

  Future<void> _scan() async {
    final raw = await Navigator.of(context)
        .push<String>(MaterialPageRoute(builder: (_) => const _ScanPage()));
    if (raw == null || !mounted) return;
    _link.text = raw;
    _submit();
  }

  Future<void> _paste() async {
    final d = await Clipboard.getData(Clipboard.kTextPlain);
    if (d?.text != null) setState(() => _link.text = d!.text!.trim());
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      body: SafeArea(
        child: BlocBuilder<AuthCubit, AuthState>(
          builder: (context, st) => ListView(
            padding: const EdgeInsets.all(AppSpacing.lg),
            children: [
              const SizedBox(height: AppSpacing.lg),
              Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: const Color(0xFFFF7A45),
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: const Icon(Icons.terminal, color: Colors.white),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  const Text(
                    'Commander',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.xl),
              const Text(
                'Markazga ulanish',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                "Markaz faqat Tailscale tarmog'ida ochiladi. Avval telefonda Tailscale ilovasini yoqing, so'ng Mac'da quyidagi buyruq bilan juftlash kodi yarating:",
                style: TextStyle(color: c.mu),
              ),
              const SizedBox(height: AppSpacing.sm),
              SelectableText(
                'ops/mac/commander-admin.sh client pair --kind mobile --name telefon --scopes read,approve,control',
                style: monoStyle(context, size: 12, color: c.mu),
              ),
              const SizedBox(height: AppSpacing.lg),
              if (st.notice != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: Text(st.notice!, style: TextStyle(color: c.grn)),
                ),
              if (st.error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: ErrorBanner(message: st.error!),
                ),
              SizedBox(
                height: AppSizes.tap,
                child: FilledButton.icon(
                  onPressed: st.busy ? null : _scan,
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('QR kodni skanerlash'),
                ),
              ),
              const SizedBox(height: AppSpacing.xl),
              const SectionLabel('Yoki havolani qo\'ying'),
              const SizedBox(height: AppSpacing.sm),
              TextField(
                controller: _link,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: InputDecoration(
                  hintText: 'commander://pair?c=https://…&code=…',
                  suffixIcon: IconButton(
                    tooltip: 'Vaqtinchalik xotiradan qo\'yish',
                    icon: const Icon(Icons.content_paste),
                    onPressed: _paste,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.xl),
              const SectionLabel('Yoki qo\'lda kiriting'),
              const SizedBox(height: AppSpacing.sm),
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Markaz manzili',
                  hintText: 'https://mac.tailnet.ts.net',
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              TextField(
                controller: _code,
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Juftlash kodi',
                  hintText: 'XXXXX-XXXXX',
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              SizedBox(
                height: AppSizes.tap,
                child: OutlinedButton(
                  onPressed: st.busy ? null : _submit,
                  child: st.busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Juftlash'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ScanPage extends StatefulWidget {
  const _ScanPage();
  @override
  State<_ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<_ScanPage> {
  final _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('QR kodni skanerlang')),
    body: Stack(
      children: [
        MobileScanner(
          controller: _controller,
          onDetect: (capture) {
            if (_done) return;
            for (final b in capture.barcodes) {
              final v = b.rawValue;
              if (v != null && v.startsWith('commander://')) {
                _done = true;
                Navigator.of(context).pop(v);
                return;
              }
            }
          },
          errorBuilder: (context, error) => const EmptyState(
            icon: Icons.no_photography_outlined,
            text: "Kameraga ruxsat berilmagan. Sozlamalardan ruxsat bering yoki havolani qo'lda kiriting.",
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: 32,
          child: Center(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(AppRadius.pill),
              ),
              child: const Text(
                'Terminaldagi QR ni ramkaga tushiring',
                style: TextStyle(color: Colors.white),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
