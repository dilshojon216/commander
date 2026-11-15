import Foundation

/// Qobiq tugmalarining amallari (ilova qatlami beradi: DashboardUI tarmoq/oynani o'zi bilmaydi).
public struct ShellActions {
    public var refresh: () -> Void
    public var openInBrowser: () -> Void

    public init(refresh: @escaping () -> Void, openInBrowser: @escaping () -> Void) {
        self.refresh = refresh
        self.openInBrowser = openInBrowser
    }
}
