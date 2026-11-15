import DashboardCore
import MenuBarCore
import SwiftUI

/// Chap panel: bo'limlar (⌘1...⌘9 tartibida), jonli hisoblagichlar va haftalik limit kartasi.
public struct DashboardSidebar: View {
    private let navigation: NavigationModel
    private let counters: SidebarCounters
    private let limit: SidebarLimitSummary?

    public init(navigation: NavigationModel, counters: SidebarCounters, limit: SidebarLimitSummary?) {
        self.navigation = navigation
        self.counters = counters
        self.limit = limit
    }

    public var body: some View {
        VStack(spacing: 0) {
            List(selection: selection) {
                Section {
                    ForEach(SidebarSection.allCases.prefix(9), id: \.self) { row($0) }
                }
                Section {
                    ForEach(SidebarSection.allCases.dropFirst(9), id: \.self) { row($0) }
                }
            }
            .listStyle(.sidebar)
            if let limit { WeeklyLimitCard(summary: limit).padding(10) }
        }
    }

    private var selection: Binding<SidebarSection?> {
        Binding(get: { navigation.selectedSection }, set: { if let section = $0 { navigation.select(section) } })
    }

    private func row(_ section: SidebarSection) -> some View {
        SidebarRow(section: section, badge: counters.badge(for: section), count: counters.count(for: section))
            .tag(section)
    }
}

struct SidebarRow: View {
    let section: SidebarSection
    let badge: Int?
    let count: String?

    var body: some View {
        HStack(spacing: 8) {
            Label(section.title, systemImage: section.symbol)
            Spacer(minLength: 4)
            if let badge {
                Text("\(badge)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(Theme.orange))
                    .accessibilityLabel("\(badge) ta diqqat talab qiladi")
            }
            if let count {
                Text(count).font(Theme.mono).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// "Haftalik limit" kartasi: taxmin shtrixli va "taxmin" yozuvi bilan (CLAUDE.md #6).
struct WeeklyLimitCard: View {
    let summary: SidebarLimitSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(Strings.weeklyLimit)
            HStack(alignment: .firstTextBaseline) {
                Text(summary.percentText).font(.system(size: 15, weight: .semibold, design: .monospaced)).foregroundStyle(color)
                Spacer()
                if let reset = summary.resetText { Text(reset).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
            }
            LimitBar(pct: summary.fraction * 100, color: color, estimate: summary.isEstimate)
            if summary.isEstimate { Text(Strings.estimate).font(.system(size: 11)).foregroundStyle(Theme.faint) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: Layout.cardCornerRadius).fill(Theme.surface2))
    }

    private var color: Color {
        switch summary.level {
        case .normal: summary.isEstimate ? Theme.muted : Theme.blue
        case .warn: Theme.yellow
        case .critical: Theme.red
        }
    }
}
