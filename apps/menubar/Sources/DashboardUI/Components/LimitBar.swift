import SwiftUI

/// Limit chizig'i; taxmin bo'lsa shtrixli ramka (rasmiy qiymatdan farq qilsin, CLAUDE.md #6).
public struct LimitBar: View {
    private let pct: Double
    private let color: Color
    private let estimate: Bool

    public init(pct: Double, color: Color, estimate: Bool) {
        self.pct = pct
        self.color = color
        self.estimate = estimate
    }

    public var body: some View {
        GeometryReader { geo in
            let width = geo.size.width * min(max(pct, 0), 100) / 100
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.surface3)
                if estimate {
                    Capsule().strokeBorder(color.opacity(0.8), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                        .frame(width: max(width, 4))
                } else {
                    Capsule().fill(color).frame(width: max(width, 4))
                }
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

/// Kichik resurs o'lchagichi: yorliq + foiz + chiziq (70%+ sariq, 90%+ qizil).
public struct Meter: View {
    private let label: String
    private let pct: Double?

    public init(label: String, pct: Double?) {
        self.label = label
        self.pct = pct
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 3) {
                Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
                Spacer(minLength: 0)
                Text(pct.map { "\(Int($0.rounded()))%" } ?? "—")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundStyle(pct == nil ? Theme.faint : color)
            }
            LimitBar(pct: pct ?? 0, color: color, estimate: false).frame(height: 4)
        }
        .frame(maxWidth: .infinity)
    }

    private var color: Color {
        guard let pct else { return Theme.faint }
        return pct >= 90 ? Theme.red : pct >= 70 ? Theme.yellow : Theme.green
    }
}
