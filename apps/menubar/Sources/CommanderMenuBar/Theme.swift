import AppKit
import MenuBarCore
import SwiftUI

/// Dizayn tokenlari (MacMenuBar.dc.html: `.t-dark` / `.t-light`). Har biri tizim ko'rinishiga moslashadi.
enum Theme {
    static let text = dynamic(dark: 0xECEEF1, light: 0x14171C)
    static let muted = dynamic(dark: 0xA3ABB8, light: 0x525B68)
    static let faint = Color(hex: 0x7A8390)
    static let blue = dynamic(dark: 0x5B9BFF, light: 0x1D5FD6)
    static let yellow = dynamic(dark: 0xE8BE54, light: 0x8A5A00)
    static let orange = dynamic(dark: 0xFF8A4C, light: 0xB23C08)
    static let green = dynamic(dark: 0x4CC38A, light: 0x13733F)
    static let red = dynamic(dark: 0xFF6B66, light: 0xC42B27)
    static let onOk = dynamic(dark: 0x06150D, light: 0xFFFFFF)

    static let blueBg = dynamic(dark: 0x5B9BFF, light: 0xE7EFFD, darkAlpha: 0.16)
    static let yellowBg = dynamic(dark: 0xE8BE54, light: 0xFBF1D6, darkAlpha: 0.16)
    static let orangeBg = dynamic(dark: 0xFF8A4C, light: 0xFCE8DC, darkAlpha: 0.18)
    static let greenBg = dynamic(dark: 0x4CC38A, light: 0xE1F3E8, darkAlpha: 0.16)
    static let redBg = dynamic(dark: 0xFF6B66, light: 0xFBE3E2, darkAlpha: 0.18)
    static let grayBg = dynamic(dark: 0x9AA3B0, light: 0xECEEF2, darkAlpha: 0.14)
    /// `--s2` / `--s3` / `--bd`
    static let surface2 = overlay(dark: 0.06, light: 0.04)
    static let surface3 = overlay(dark: 0.10, light: 0.07)
    static let border = overlay(dark: 0.12, light: 0.10)

    static let mono = Font.system(size: 11, design: .monospaced)

    // Maskot ranglari (Mascot.dc.html: ikkala mavzuda bir xil).
    enum Mascot {
        static let body = Color(hex: 0x2B3A67)
        static let screen = Color(hex: 0x0E1424)
        static let limb = Color(hex: 0x3E4F86)
        static let cheek = Color(hex: 0xFF8FA3)
    }

    /// Antenna chirog'i (maskot va bildirishnoma rangi bir xil, mavzudan mustaqil).
    static func light(_ l: MascotLight) -> Color {
        switch l {
        case .gray: return Color(hex: 0x5C6B8A)
        case .blue: return Color(hex: 0x5B9BFF)
        case .yellow: return Color(hex: 0xE8BE54)
        case .orange: return Color(hex: 0xFF8A4C)
        case .green: return Color(hex: 0x4CC38A)
        case .red: return Color(hex: 0xFF6B66)
        }
    }

    static func status(_ s: SessionStatusKind) -> (fg: Color, bg: Color) {
        switch s {
        case .working: return (blue, blueBg)
        case .waiting: return (yellow, yellowBg)
        case .approval: return (orange, orangeBg)
        case .done: return (green, greenBg)
        case .idle, .other: return (muted, grayBg)
        }
    }

    private static func dynamic(dark: UInt32, light: UInt32, darkAlpha: CGFloat = 1) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(hex: dark, alpha: darkAlpha) : NSColor(hex: light)
        })
    }

    private static func overlay(dark: CGFloat, light: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.white.withAlphaComponent(dark) : NSColor.black.withAlphaComponent(light)
        })
    }
}

/// Sessiya holatining rang guruhi.
enum SessionStatusKind {
    case working, waiting, approval, done, idle, other
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}

/// Kichik "pill" (holat belgisi).
struct Pill: View {
    let text: String
    let fg: Color
    let bg: Color
    var dot = true
    var pulsing = false
    var mono = false

    var body: some View {
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

struct PulsingDot: View {
    let color: Color
    var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
            .opacity(pulsing && dim && !reduceMotion ? 0.3 : 1)
            .onAppear {
                guard pulsing, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.muted)
    }
}
