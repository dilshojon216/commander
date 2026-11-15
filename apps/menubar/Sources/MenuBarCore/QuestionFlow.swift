import CommanderContracts
import Foundation

/// AskUserQuestion (`kind == .question`) approval'lari: ko'rinish, tugmalar va javob tanasi (sof mantiq).
/// Javob = `POST /v1/approvals/:id/decision` `allow` + `answers` (indekslar, label matni emas).
public enum QuestionFlow {
    public static let recommendedMarker = "(Recommended)"
    public static let multiNote = "Bir nechta javob: dashboard yoki Telegram'da javob bering"

    /// Label tavsiya belgisini o'z ichiga oladimi (faqat vizual belgi; hech qachon avto-tanlanmaydi).
    public static func isRecommendedLabel(_ label: String) -> Bool {
        label.contains(recommendedMarker)
    }

    /// "(Recommended)" -> "(tavsiya)".
    public static func displayOptionLabel(_ label: String) -> String {
        label.replacingOccurrences(of: recommendedMarker, with: "(tavsiya)")
    }

    /// Bitta savol va bitta tanlovli (multiSelect emas) — faqat shunda tugmalar chiqadi.
    public static func isSingleSelectSingleQuestion(_ a: ApprovalDto) -> Bool {
        guard a.kind == .question, let qs = a.questions, qs.count == 1 else { return false }
        return qs[0].multiSelect == false && !qs[0].options.isEmpty
    }

    public struct OptionButton: Equatable, Sendable {
        public let index: Int
        public let title: String
        public let description: String
        public let isRecommended: Bool
    }

    /// Bitta-savol/bitta-tanlov uchun tugmalar; aks holda bo'sh.
    public static func buttons(for a: ApprovalDto) -> [OptionButton] {
        guard isSingleSelectSingleQuestion(a), let q = a.questions?.first else { return [] }
        return q.options.enumerated().map { i, o in
            OptionButton(index: i, title: displayOptionLabel(o.label), description: o.description, isRecommended: isRecommendedLabel(o.label))
        }
    }

    /// Faqat o'qish uchun ko'rinish (ko'p savol / multiSelect): (savol matni, variantlar sarlavhalari).
    public static func readOnlyLines(for a: ApprovalDto) -> [(question: String, options: [String])] {
        (a.questions ?? []).map { q in (q.question, q.options.map { displayOptionLabel($0.label) }) }
    }

    /// Javob tanasi; yaroqsiz indeks yoki mos kelmaydigan approval -> nil.
    public static func answerBody(for a: ApprovalDto, optionIndex: Int) -> ApprovalDecisionBody? {
        guard isSingleSelectSingleQuestion(a), let q = a.questions?.first,
              q.options.indices.contains(optionIndex) else { return nil }
        return ApprovalDecisionBody(behavior: .allow, message: nil, answers: [AskAnswer(q: 0, picks: [optionIndex])])
    }
}
