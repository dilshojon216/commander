import DashboardCore
import SwiftUI

/// Kichik "pill" (holat belgisi).
public struct Pill: View {
    private let text: String
    private let fg: Color
    private let bg: Color
    private let dot: Bool
    private let pulsing: Bool
    private let mono: Bool

    public init(text: String, fg: Color, bg: Color, dot: Bool = true, pulsing: Bool = false, mono: Bool = false) {
        self.text = text
        self.fg = fg
        self.bg = bg
        self.dot = dot
        self.pulsing = pulsing
        self.mono = mono
    }

    public var body: some View {
        HStack(spacing: 5) {
            if dot { PulsingDot(color: fg, pulsing: pulsing) }
            Text(text).font(mono ? Theme.mono.weight(.medium) : .system(size: 11, weight: .medium)).lineLimit(1)
        }
        .padding(.horizontal, 7)
        .frame(height: 20)
        .foregroundStyle(fg)
        .background(Capsule().fill(bg))
    }
}

/// Sessiya holatini rang va matn bilan ko'rsatadigan pill.
public struct StatusPill: View {
    private let kind: SessionStatusKind
    private let text: String

    public init(kind: SessionStatusKind, text: String) {
        self.kind = kind
        self.text = text
    }

    public var body: some View {
        let colors = Theme.status(kind)
        Pill(text: text, fg: colors.fg, bg: colors.bg, pulsing: kind == .working)
    }
}

public struct PulsingDot: View {
    private let color: Color
    private let pulsing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    public init(color: Color, pulsing: Bool = false) {
        self.color = color
        self.pulsing = pulsing
    }

    public var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .opacity(pulsing && dim && !reduceMotion ? 0.3 : 1)
            .onAppear {
                guard pulsing, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// Aloqa holati belgisi (`ConnectionBadge` ohangidan rang tanlanadi).
public struct ConnectionIndicator: View {
    private let badge: ConnectionBadge

    public init(badge: ConnectionBadge) {
        self.badge = badge
    }

    public var body: some View {
        let colors = Self.colors(for: badge.tone)
        Pill(text: badge.title, fg: colors.fg, bg: colors.bg, pulsing: badge.pulsing)
    }

    private static func colors(for tone: ConnectionBadge.Tone) -> (fg: Color, bg: Color) {
        switch tone {
        case .good: (Theme.green, Theme.greenBg)
        case .neutral: (Theme.muted, Theme.grayBg)
        case .warning: (Theme.yellow, Theme.yellowBg)
        case .danger: (Theme.red, Theme.redBg)
        }
    }
}
