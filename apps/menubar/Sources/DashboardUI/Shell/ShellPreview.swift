import DashboardCore
import SwiftUI

/// Qobiqning statik namunasi (`--render-previews` PNG'si uchun): `List`/`NavigationSplitView` AppKit asosida bo'lgani sababli
/// `ImageRenderer` ularni chiza olmaydi, shuning uchun yon menyu qatorlari va kartalar oddiy `VStack`da qayta yig'iladi.
public struct ShellPreview: View {
    private let counters: SidebarCounters
    private let limit: SidebarLimitSummary?
    private let selected: SidebarSection
    private let route: Route

    public init(counters: SidebarCounters, limit: SidebarLimitSummary?, selected: SidebarSection = .sessions, route: Route = .sessions) {
        self.counters = counters
        self.limit = limit
        self.selected = selected
        self.route = route
    }

    public var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(SidebarSection.allCases, id: \.self) { section in
                    SidebarRow(section: section, badge: counters.badge(for: section), count: counters.count(for: section))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(section == selected ? Theme.blueBg : .clear))
                        .foregroundStyle(section == selected ? Theme.blue : Theme.text)
                    if section.shortcutDigit == 9 { Divider().padding(.vertical, 4) }
                }
                Spacer(minLength: 12)
                if let limit { WeeklyLimitCard(summary: limit) }
            }
            .padding(10)
            .frame(width: Layout.sidebarIdealWidth, height: 640, alignment: .top)
            .background(Theme.surface2)
            Divider()
            NativePlaceholderView(route: route, openWebView: {}, openBrowser: {})
                .frame(width: 620, height: 640)
        }
    }
}
