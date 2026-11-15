import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

struct FooterButton: View {
    let title: String
    let icon: String
    var shortcut: Character?
    let action: () -> Void

    var body: some View {
        let b = Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11, weight: .medium))
                Text(title).font(.system(size: 12, weight: .medium))
                if let shortcut { Text("⌘\(String(shortcut).uppercased())").font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint) }
            }
            .padding(.horizontal, 9).frame(height: 26)
        }
        .buttonStyle(IconButtonStyle())
        if let shortcut { b.keyboardShortcut(KeyEquivalent(shortcut), modifiers: .command) } else { b }
    }
}

struct IconButtonStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.text)
            .background(RoundedRectangle(cornerRadius: 7).fill(configuration.isPressed ? Theme.surface3 : hover ? Theme.surface2 : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 7))
            .onHover { hover = $0 }
    }
}

/// Bo'lim kartasi: sarlavha + yengil fon.
struct PanelCard<Content: View>: View {
    let title: String
    let icon: String
    var tint: Color = Theme.muted
    var trailing: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                CardTitle(title: title, icon: icon, tint: tint)
                Spacer()
                if let trailing { Text(trailing).font(.system(size: 11)).foregroundStyle(Theme.faint) }
            }
            content()
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
    }
}

struct CardTitle: View {
    let title: String
    let icon: String
    var tint: Color = Theme.muted
    var count: Int?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint).accessibilityHidden(true)
            SectionLabel(title)
            if let count, count > 0 {
                Text("\(count)").font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
                    .padding(.horizontal, 5).background(Capsule().fill(tint.opacity(0.16)))
            }
        }
    }
}

struct MenuRow: View {
    let title: String
    var shortcut: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if let shortcut { Text(shortcut).font(Theme.mono).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
    }
}

struct RowButtonStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.text)
            .background(RoundedRectangle(cornerRadius: 7).fill(hover || configuration.isPressed ? Theme.surface3 : .clear))
            .onHover { hover = $0 }
    }
}
