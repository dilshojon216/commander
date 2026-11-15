import Foundation
import Observation

/// Dashboard oynasining joriy sahifasi va tarixi (orqaga/oldinga: ⌘[ / ⌘]). Brauzer tarixiga o'xshaydi: yangi sahifaga o'tilsa
/// "oldinga" steki tozalanadi; bir xil sahifaga qayta o'tish tarixni to'ldirmaydi.
@MainActor
@Observable
public final class NavigationModel {
    public static let maxHistory = 100

    public private(set) var current: Route
    public private(set) var backStack: [Route] = []
    public private(set) var forwardStack: [Route] = []

    public init(start: Route = .overview) {
        current = start
    }

    public var canGoBack: Bool { !backStack.isEmpty }
    public var canGoForward: Bool { !forwardStack.isEmpty }
    public var selectedSection: SidebarSection { current.section }

    public func navigate(to route: Route) {
        guard route != current else { return }
        backStack.append(current)
        if backStack.count > Self.maxHistory { backStack.removeFirst(backStack.count - Self.maxHistory) }
        forwardStack.removeAll()
        current = route
    }

    /// Yon menyudan bo'lim tanlash: bo'limning bosh sahifasiga (allaqachon shu bo'limda bo'lsa ham bosh sahifaga qaytadi).
    public func select(_ section: SidebarSection) {
        navigate(to: section.root)
    }

    @discardableResult
    public func goBack() -> Bool {
        guard let previous = backStack.popLast() else { return false }
        forwardStack.append(current)
        current = previous
        return true
    }

    @discardableResult
    public func goForward() -> Bool {
        guard let next = forwardStack.popLast() else { return false }
        backStack.append(current)
        current = next
        return true
    }
}
