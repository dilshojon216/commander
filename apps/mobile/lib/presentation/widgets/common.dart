import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/util/format.dart';
import '../../data/realtime_client.dart';
import '../../domain/session_labels.dart';

Color toneFg(AppColors c, StatusTone t) => switch (t) {
  StatusTone.blue => c.blue,
  StatusTone.yellow => c.yel,
  StatusTone.orange => c.org,
  StatusTone.green => c.grn,
  StatusTone.red => c.red,
  StatusTone.gray => c.mu,
  StatusTone.faint => c.fa,
};

Color toneBg(AppColors c, StatusTone t) => switch (t) {
  StatusTone.blue => c.blueBg,
  StatusTone.yellow => c.yelBg,
  StatusTone.orange => c.orgBg,
  StatusTone.green => c.grnBg,
  StatusTone.red => c.redBg,
  StatusTone.gray || StatusTone.faint => c.grayBg,
};

TextStyle monoStyle(
  BuildContext context, {
  double size = 12,
  FontWeight weight = FontWeight.w400,
  Color? color,
}) => TextStyle(
  fontFamily: AppSizes.monoFamily,
  fontSize: size,
  fontWeight: weight,
  color: color ?? context.c.tx,
);

/// Chegarali karta (dizayn `.card`).
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    this.borderColor,
    this.onTap,
    this.semanticLabel,
  });
  final Widget child;
  final EdgeInsets padding;
  final Color? borderColor;
  final VoidCallback? onTap;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final body = Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: c.s1,
        border: Border.all(color: borderColor ?? c.bd),
        borderRadius: BorderRadius.circular(AppRadius.card),
      ),
      child: child,
    );
    if (onTap == null)
      return Semantics(container: true, label: semanticLabel, child: body);
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppRadius.card),
          onTap: onTap,
          child: body,
        ),
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({
    super.key,
    required this.label,
    required this.tone,
    this.live = false,
    this.dashed = false,
    this.dot = true,
  });
  final String label;
  final StatusTone tone;
  final bool live;
  final bool dashed;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fg = toneFg(c, tone);
    return Container(
      height: 22,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: dashed ? null : toneBg(c, tone),
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: dashed ? Border.all(color: fg.withValues(alpha: 0.7)) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            PulseDot(color: fg, pulsing: live),
            const SizedBox(width: 6),
          ],
          Text(
            label,
            style: TextStyle(
              color: fg,
              fontSize: 12,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class PulseDot extends StatefulWidget {
  const PulseDot({super.key, required this.color, this.pulsing = false});
  final Color color;
  final bool pulsing;
  @override
  State<PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<PulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void initState() {
    super.initState();
    if (widget.pulsing) _a.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(PulseDot old) {
    super.didUpdateWidget(old);
    if (widget.pulsing && !_a.isAnimating) _a.repeat(reverse: true);
    if (!widget.pulsing && _a.isAnimating) _a.stop();
  }

  @override
  void dispose() {
    _a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dot = Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
    );
    if (!widget.pulsing || MediaQuery.of(context).disableAnimations) return dot;
    return FadeTransition(
      opacity: Tween(begin: 1.0, end: 0.3).animate(_a),
      child: dot,
    );
  }
}

class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.6,
        color: context.c.mu,
      ),
    ),
  );
}

/// Xato banneri (qayta urinish bilan).
class ErrorBanner extends StatelessWidget {
  const ErrorBanner({super.key, required this.message, this.onRetry});
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: c.redBg,
          border: Border.all(color: c.red),
          borderRadius: BorderRadius.circular(AppRadius.md),
        ),
        child: Row(
          children: [
            Icon(Icons.cloud_off_outlined, color: c.red, size: 20),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(message, style: TextStyle(color: c.tx, fontSize: 13)),
            ),
            if (onRetry != null)
              TextButton(onPressed: onRetry, child: const Text('Qayta')),
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(AppSpacing.xl),
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 32, color: context.c.fa),
          const SizedBox(height: AppSpacing.sm),
          Text(
            text,
            textAlign: TextAlign.center,
            style: TextStyle(color: context.c.mu),
          ),
        ],
      ),
    ),
  );
}

class Loading extends StatelessWidget {
  const Loading({super.key});
  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(AppSpacing.xl),
    child: Center(child: CircularProgressIndicator()),
  );
}

/// "Jonli" / "Qayta ulanmoqda…" belgisi.
class ConnectionChip extends StatelessWidget {
  const ConnectionChip(this.status, {super.key});
  final RealtimeStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, tone, live) = switch (status) {
      RealtimeStatus.live => ('Jonli', StatusTone.green, true),
      RealtimeStatus.connecting => ('Ulanmoqda…', StatusTone.gray, false),
      RealtimeStatus.reconnecting => (
        'Qayta ulanmoqda…',
        StatusTone.yellow,
        false,
      ),
      RealtimeStatus.unauthorized => ('Ruxsat yo\'q', StatusTone.red, false),
      RealtimeStatus.idle => ('Oflayn', StatusTone.gray, false),
    };
    return Semantics(
      label: 'Ulanish: $label',
      child: StatusPill(label: label, tone: tone, live: live),
    );
  }
}

class LockdownBanner extends StatelessWidget {
  const LockdownBanner({super.key});
  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.sm,
        ),
        color: c.red,
        child: Text(
          'Lockdown yoqiq: masofadan faqat rad etish mumkin',
          style: TextStyle(
            color: c.bg,
            fontWeight: FontWeight.w600,
            fontSize: 13,
          ),
        ),
      ),
    );
  }
}

/// Teskari sanoq (har soniya yangilanadi).
class CountdownText extends StatefulWidget {
  const CountdownText({super.key, required this.remaining, this.style});
  final Duration Function() remaining;
  final TextStyle? style;
  @override
  State<CountdownText> createState() => _CountdownTextState();
}

class _CountdownTextState extends State<CountdownText> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.remaining();
    return Semantics(
      label: 'Qolgan vaqt ${formatCountdown(r)}',
      child: Text(
        formatCountdown(r),
        style:
            widget.style ??
            monoStyle(context, size: 14, weight: FontWeight.w600),
      ),
    );
  }
}

/// Tasdiq dialogi: `true` = tasdiqlandi.
Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  required String body,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(body),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: const Text('Bekor'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(
            confirmLabel,
            style: destructive ? TextStyle(color: ctx.c.red) : null,
          ),
        ),
      ],
    ),
  );
  return ok ?? false;
}

void showSnack(BuildContext context, String text) =>
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));

/// Oddiy ustunli grafik (kunlik tokenlar). Oxirgi ustun ta'kidlanadi.
class MiniBars extends StatelessWidget {
  const MiniBars({
    super.key,
    required this.values,
    this.height = 40,
    this.barWidth = 6,
    this.semanticLabel,
  });
  final List<double> values;
  final double height;
  final double barWidth;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final maxV = values.fold<double>(0, (m, v) => v > m ? v : m);
    return Semantics(
      label: semanticLabel,
      image: true,
      child: SizedBox(
        height: height,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < values.length; i++)
              Padding(
                padding: const EdgeInsets.only(right: 3),
                child: Container(
                  width: barWidth,
                  height: maxV == 0
                      ? 2
                      : (values[i] / maxV * height).clamp(2, height),
                  decoration: BoxDecoration(
                    color: i == values.length - 1 ? c.blue : c.blueBg,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
