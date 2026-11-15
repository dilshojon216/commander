import SwiftUI

/// Rangli xabar chizig'i (ikonka + matn).
public struct Banner: View {
    private let text: String
    private let fg: Color
    private let bg: Color
    private let icon: String

    public init(text: String, fg: Color, bg: Color, icon: String) {
        self.text = text
        self.fg = fg
        self.bg = bg
        self.icon = icon
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).accessibilityHidden(true)
            Text(text).font(.system(size: 11, weight: .medium))
            Spacer()
        }
        .padding(8).foregroundStyle(fg)
        .background(RoundedRectangle(cornerRadius: 8).fill(bg))
    }
}

/// Xato yoki ogohlantirish xabari; ixtiyoriy "Qayta urinish" tugmasi.
public struct ErrorBanner: View {
    private let message: String
    private let retry: (() -> Void)?

    public init(_ message: String, retry: (() -> Void)? = nil) {
        self.message = message
        self.retry = retry
    }

    public var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
            Text(message).font(.system(size: 11, weight: .medium))
            Spacer()
            if let retry {
                Button(Strings.retry, action: retry).buttonStyle(.borderless)
            }
        }
        .padding(8).foregroundStyle(Theme.red)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.redBg))
    }
}

/// Lockdown yoqilgan: masofadan faqat rad etish mumkin.
public struct LockdownBanner: View {
    public init() {}

    public var body: some View {
        Banner(text: Strings.lockdownActive, fg: Theme.red, bg: Theme.redBg, icon: "lock.fill")
    }
}
