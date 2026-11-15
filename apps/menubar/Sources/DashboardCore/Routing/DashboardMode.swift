import Foundation
import MenuBarCore

/// Dashboard oynasi turi: o'tish davrida ikkalasi ham bor (web — zaxira; native tayyor bo'lgach asosiy, so'ng web olib tashlanadi).
public enum DashboardMode: String, CaseIterable, Sendable, Equatable {
    case native
    case web

    public var title: String {
        switch self {
        case .native: "Native (yangi)"
        case .web: "Web (hozirgi)"
        }
    }
}

/// Marshrutni qaysi oynada ochish (sof qaror; oynalarni ilova qatlami ochadi).
public enum DashboardOpener {
    public enum Destination: Equatable, Sendable {
        /// Native oyna shu marshrutda (ekrani hali bo'lmasa "web ko'rinishda ochish" sahifasi chiqadi).
        case nativeWindow(Route)
        /// Web oyna, eski chuqur havola turi (`DashboardTarget`): ochiq sahifa bosh sahifa so'ralganda almashmaydi.
        case webTarget(DashboardTarget)
        /// Web oyna, to'g'ridan-to'g'ri yo'l (eski turga mos kelmaydigan sahifalar).
        case webPath(String)
    }

    public static func destination(mode: DashboardMode, route: Route) -> Destination {
        switch mode {
        case .native:
            return .nativeWindow(route)
        case .web:
            if let target = route.dashboardTarget { return .webTarget(target) }
            // Web'da yo'q sahifalar (mashina qo'shish ustasi, Boshqaruv): bosh sahifa.
            return route.webPath.map(Destination.webPath) ?? .webTarget(.overview)
        }
    }
}
