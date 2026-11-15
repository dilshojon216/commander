import DashboardCore
import SwiftUI

/// Hali native ekrani yo'q marshrut (o'tish davri): web ko'rinishda yoki brauzerda ochish. Faza 4 da bu holat yo'qolishi shart.
public struct NativePlaceholderView: View {
    private let route: Route
    private let openWebView: () -> Void
    private let openBrowser: () -> Void

    public init(route: Route, openWebView: @escaping () -> Void, openBrowser: @escaping () -> Void) {
        self.route = route
        self.openWebView = openWebView
        self.openBrowser = openBrowser
    }

    public var body: some View {
        VStack(spacing: 14) {
            Image(systemName: route.section.symbol)
                .font(.system(size: 40, weight: .regular))
                .foregroundStyle(Theme.faint)
                .accessibilityHidden(true)
            Text(route.title).font(.system(size: 20, weight: .bold))
            if route.webPath != nil {
                Text(Strings.notNativeYet).foregroundStyle(Theme.muted)
                HStack {
                    Button(Strings.openInWebView, action: openWebView).controlSize(.large)
                    Button(Strings.openInBrowser, action: openBrowser).controlSize(.large)
                }
            } else {
                Text(Strings.comingSoon).foregroundStyle(Theme.muted)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
