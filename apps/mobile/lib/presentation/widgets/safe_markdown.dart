import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import 'common.dart';

/// Xavfsiz markdown: xom HTML renderlanmaydi (matn bo'lib qoladi), rasmlar yuklanmaydi,
/// havolalar ochilmaydi (chat matni ishonchsiz).
class SafeMarkdown extends StatelessWidget {
  const SafeMarkdown(this.data, {super.key});
  final String data;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final base = TextStyle(color: c.tx, fontSize: 14, height: 1.45);
    return MarkdownBody(
      data: data,
      selectable: true,
      onTapLink: (text, href, title) {},
      imageBuilder: (uri, title, alt) => Text(
        '[rasm: ${alt ?? ''}]',
        style: TextStyle(color: c.mu, fontSize: 12),
      ),
      styleSheet: MarkdownStyleSheet(
        p: base,
        h1: base.copyWith(fontSize: 18, fontWeight: FontWeight.w700),
        h2: base.copyWith(fontSize: 16, fontWeight: FontWeight.w700),
        h3: base.copyWith(fontSize: 15, fontWeight: FontWeight.w600),
        a: base.copyWith(color: c.blue),
        code: monoStyle(context, size: 12.5).copyWith(backgroundColor: c.s2),
        codeblockDecoration: BoxDecoration(
          color: c.s2,
          border: Border.all(color: c.bd),
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        codeblockPadding: const EdgeInsets.all(10),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: c.bd, width: 3)),
        ),
        listBullet: base,
      ),
    );
  }
}
