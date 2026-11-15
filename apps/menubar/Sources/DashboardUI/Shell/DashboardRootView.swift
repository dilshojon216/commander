import DashboardCore
import MenuBarCore
import SwiftUI

/// Native dashboard oynasining ildizi: yon menyu + tafsilot (`NavigationSplitView`), asboblar paneli (orqaga/oldinga, aloqa, lockdown, yangilash).
/// Ma'lumot tashqaridan beriladi (ilova qatlami `AppModel`ni moslaydi); tafsilot ekrani `detail` orqali.
public struct DashboardRootView<Detail: View>: View {
    @Bindable private var navigation: NavigationModel
    private let counters: SidebarCounters
    private let limit: SidebarLimitSummary?
    private let connection: ConnectionBadge
    private let lockdown: Bool
    private let actions: ShellActions
    private let detail: (Route) -> Detail

    public init(
        navigation: NavigationModel,
        counters: SidebarCounters,
        limit: SidebarLimitSummary?,
        connection: ConnectionBadge,
        lockdown: Bool,
        actions: ShellActions,
        @ViewBuilder detail: @escaping (Route) -> Detail
    ) {
        self.navigation = navigation
        self.counters = counters
        self.limit = limit
        self.connection = connection
        self.lockdown = lockdown
        self.actions = actions
        self.detail = detail
    }

    public var body: some View {
        NavigationSplitView {
            DashboardSidebar(navigation: navigation, counters: counters, limit: limit)
                .navigationSplitViewColumnWidth(min: Layout.sidebarMinWidth, ideal: Layout.sidebarIdealWidth, max: Layout.sidebarMaxWidth)
        } detail: {
            detail(navigation.current)
                .frame(minWidth: Layout.detailMinWidth)
                .navigationTitle(navigation.current.title)
        }
        .toolbar { toolbarContent }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { navigation.goBack() } label: { Label(Strings.back, systemImage: "chevron.left") }
                .disabled(!navigation.canGoBack)
                .help("\(Strings.back) (⌘[)")
            Button { navigation.goForward() } label: { Label(Strings.forward, systemImage: "chevron.right") }
                .disabled(!navigation.canGoForward)
                .help("\(Strings.forward) (⌘])")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            ConnectionIndicator(badge: connection)
            if lockdown { Pill(text: Strings.lockdownShort, fg: Theme.red, bg: Theme.redBg, dot: false) }
            Button(action: actions.refresh) { Label(Strings.refresh, systemImage: "arrow.clockwise") }
                .help("\(Strings.refresh) (⌘R)")
            Button(action: actions.openInBrowser) { Label(Strings.openInBrowser, systemImage: "safari") }
                .help(Strings.openInBrowser)
        }
    }
}
