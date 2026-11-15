import AppKit
import MenuBarCore
import SwiftUI

/// Dizayn tokenlari (MacMenuBar.dc.html: `.t-dark` / `.t-light`). Har biri tizim ko'rinishiga moslashadi.
public enum Theme {
    public static let text = dynamic(dark: 0xECEEF1, light: 0x14171C)
    public static let muted = dynamic(dark: 0xA3ABB8, light: 0x525B68)
    public static let faint = Color(hex: 0x7A8390)
    public static let blue = dynamic(dark: 0x5B9BFF, light: 0x1D5FD6)
    public static let yellow = dynamic(dark: 0xE8BE54, light: 0x8A5A00)
    public static let orange = dynamic(dark: 0xFF8A4C, light: 0xB23C08)
    public static let green = dynamic(dark: 0x4CC38A, light: 0x13733F)
    public static let red = dynamic(dark: 0xFF6B66, light: 0xC42B27)
    public static let onOk = dynamic(dark: 0x06150D, light: 0xFFFFFF)

    public static let blueBg = dynamic(dark: 0x5B9BFF, light: 0xE7EFFD, darkAlpha: 0.16)
    public static let yellowBg = dynamic(dark: 0xE8BE54, light: 0xFBF1D6, darkAlpha: 0.16)
    public static let orangeBg = dynamic(dark: 0xFF8A4C, light: 0xFCE8DC, darkAlpha: 0.18)
    public static let greenBg = dynamic(dark: 0x4CC38A, light: 0xE1F3E8, darkAlpha: 0.16)
    public static let redBg = dynamic(dark: 0xFF6B66, light: 0xFBE3E2, darkAlpha: 0.18)
    public static let grayBg = dynamic(dark: 0x9AA3B0, light: 0xECEEF2, darkAlpha: 0.14)
    /// `--s2` / `--s3` / `--bd`
    public static let surface2 = overlay(dark: 0.06, light: 0.04)
    public static let surface3 = overlay(dark: 0.10, light: 0.07)
    public static let border = overlay(dark: 0.12, light: 0.10)

    public static let mono = Font.system(size: 11, design: .monospaced)

    // Maskot ranglari (Mascot.dc.html: ikkala mavzuda bir xil).
    public enum Mascot {
        public static let body = Color(hex: 0x2B3A67)
        public static let screen = Color(hex: 0x0E1424)
        public static let limb = Color(hex: 0x3E4F86)
        public static let cheek = Color(hex: 0xFF8FA3)
    }

    /// Antenna chirog'i (maskot va bildirishnoma rangi bir xil, mavzudan mustaqil).
    public static func light(_ l: MascotLight) -> Color {
        switch l {
        case .gray: return Color(hex: 0x5C6B8A)
        case .blue: return Color(hex: 0x5B9BFF)
        case .yellow: return Color(hex: 0xE8BE54)
        case .orange: return Color(hex: 0xFF8A4C)
        case .green: return Color(hex: 0x4CC38A)
        case .red: return Color(hex: 0xFF6B66)
        }
    }

    public static func status(_ s: SessionStatusKind) -> (fg: Color, bg: Color) {
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
public enum SessionStatusKind: Sendable {
    case working, waiting, approval, done, idle, other
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

extension Color {
    public init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }
}
