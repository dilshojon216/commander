import AppKit
import CommanderContracts
import DashboardCore
import Foundation
import MenuBarCore
import SwiftUI

/// Panel va dashboard oynalarini ochish (native/web), qo'lda yangilash.
extension AppModel {
    // MARK: panel

    func panelAppeared() {
        panelVisible = true
        state.acknowledgeDone()
        popup.dismissAll()
    }

    func panelDisappeared() {
        panelVisible = false
        showSettings = false
    }

    func openPanel() {
        popup.dismissAll()
        if !panelVisible { panelOpener?() }
    }

    /// Ilova ichidagi "Commander" oynasi (WKWebView). Dock ikonkasi oyna ochiq paytda ko'rinadi.
    func openDashboard(_ target: DashboardTarget = .overview) {
        open(Route(target: target))
    }

    /// Marshrutni sozlamadagi oyna turida ochadi (`dashboardMode`): native oyna yoki web oyna.
    func open(_ route: Route) {
        popup.dismissAll()
        panelCloser?()
        switch DashboardOpener.destination(mode: settings.dashboardMode, route: route) {
        case .nativeWindow(let target): nativeDashboard.show(target)
        case .webTarget(let target): dashboardWindow.show(target)
        case .webPath(let path): dashboardWindow.show(webPath: path)
        }
    }

    /// Ikkilamchi: tizim brauzerida.
    func openDashboardInBrowser() {
        NSWorkspace.shared.open(settings.dashboardURL)
    }

    /// Marshrutning web sahifasini tizim brauzerida ochadi (web'da yo'q sahifalar uchun bosh sahifa).
    func openInBrowser(_ route: Route) {
        var components = URLComponents(url: settings.dashboardURL, resolvingAgainstBaseURL: false)
        components?.path = route.webPath ?? "/"
        if let url = components?.url { NSWorkspace.shared.open(url) }
    }

    /// Native ekrani hali yo'q marshrutni web ko'rinish oynasida ochadi (o'tish davri).
    func openInWebView(_ route: Route) {
        popup.dismissAll()
        panelCloser?()
        if let path = route.webPath { dashboardWindow.show(webPath: path) } else { dashboardWindow.show(.overview) }
    }

    /// Qo'lda yangilash (⌘R): REST snapshot qayta olinadi.
    func refresh() {
        Task { await loadSnapshot() }
    }
}
