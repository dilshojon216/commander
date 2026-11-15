import 'package:commander_contracts/commander_contracts.dart';

/// Claude Code AskUserQuestion so'rovlari (approval.kind == question): sof mantiq.

const _recommendedMarker = '(Recommended)';
const multiAnswerNote =
    "Bir nechta javob: dashboard yoki Telegram'da javob bering";

bool isQuestion(ApprovalDto a) => a.kind == ApprovalKind.question;

/// Variant yorlig'ida "(Recommended)" belgisi bormi (faqat ko'rinish uchun, hech narsa avtomatik tanlanmaydi).
bool isRecommendedLabel(String label) => label.contains(_recommendedMarker);

/// "(Recommended)" -> "(tavsiya)".
String displayOptionLabel(String label) => label
    .replaceAll(_recommendedMarker, '(tavsiya)')
    .replaceAll(RegExp(r'\s{2,}'), ' ')
    .trim();

/// Mobil ilova javob bera oladigan savolmi: aynan bitta savol, multiSelect emas, kamida bitta variant.
bool isAnswerableQuestion(ApprovalDto a) {
  if (!isQuestion(a)) return false;
  final qs = a.questions;
  if (qs == null || qs.length != 1) return false;
  final q = qs.first;
  return !q.multiSelect && q.options.isNotEmpty;
}

/// Bitta savolga bitta variant tanlangan javob (indekslar, yorliq matni emas). Noto'g'ri indeksda null.
List<AskAnswer>? buildSingleAnswer(ApprovalDto a, int optionIndex) {
  if (!isAnswerableQuestion(a)) return null;
  if (optionIndex < 0 || optionIndex >= a.questions!.first.options.length)
    return null;
  return [
    AskAnswer(q: 0, picks: [optionIndex]),
  ];
}

/// Ro'yxat/diqqat kartasi uchun qisqa matn: sarlavha va savol matni.
String questionSummary(ApprovalDto a) {
  final qs = a.questions;
  if (qs == null || qs.isEmpty) return a.toolInputRedacted;
  final first = qs.first;
  final head = first.header.trim().isEmpty
      ? first.question
      : '${first.header}: ${first.question}';
  return qs.length > 1 ? '$head (+${qs.length - 1} ta savol)' : head;
}
