import AppKit
import DashboardUI
import MenuBarCore
import SwiftUI
import WebKit

/// WKNavigationDelegate / WKUIDelegate va diagnostika (DashboardWindow.swift dan ajratilgan).
extension DashboardWindowController {
    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        // targetFrame == nil: target=_blank / window.open — yangi oyna ochilmaydi.
        let newWindow = navigationAction.targetFrame == nil
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        DebugLog.write("dash nav path=\(url?.path ?? "-") type=\(navigationAction.navigationType.rawValue) main=\(isMain) new=\(newWindow)")
        switch DashboardNavigationPolicy.decide(url, base: settings.dashboardURL, isMainFrame: isMain) {
        case .allow:
            if newWindow, let url { webView.load(URLRequest(url: url)); return .cancel }
            return .allow
        case .openExternally:
            if let url { NSWorkspace.shared.open(url) }
            return .cancel
        case .cancel:
            if let url { log.notice("dashboard navigation blocked scheme=\(url.scheme ?? "-", privacy: .public)") }
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DebugLog.write("dash finish path=\(webView.url?.path ?? "-")")
        hideDown()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func handleFailure(_ error: Error) {
        let ns = error as NSError
        DebugLog.write("dash fail domain=\(ns.domain) code=\(ns.code)")
        // Bekor qilingan / siyosat to'xtatgan yuklanish xato emas.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        guard ns.domain == NSURLErrorDomain else { return }
        let url = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView?.url ?? DashboardTarget.overview.url(base: settings.dashboardURL)
        if let url { showDown(url: url, error: error) }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open: ichki manzil shu oynada, tashqi manzil brauzerda; yangi WKWebView yaratilmaydi.
        switch DashboardNavigationPolicy.decide(navigationAction.request.url, base: settings.dashboardURL, isMainFrame: true) {
        case .allow: if let u = navigationAction.request.url { webView.load(URLRequest(url: u)) }
        case .openExternally: if let u = navigationAction.request.url { NSWorkspace.shared.open(u) }
        case .cancel: break
        }
        return nil
    }

    // MARK: diagnostika

    /// Bosilgan nuqtadagi element, sahifa yo'li va yig'ilgan JS xatolari (faqat `debugLog` yoqilganda).
    func probe(_ e: NSEvent) {
        guard DebugLog.enabled, let webView, e.window === window else { return }
        let pt = webView.convert(e.locationInWindow, from: nil)
        let zoom = webView.pageZoom
        let x = Int(pt.x / zoom), y = Int((webView.isFlipped ? pt.y : webView.bounds.height - pt.y) / zoom)
        let js = """
        (function(){var el=document.elementFromPoint(\(x),\(y));var d=function(n){if(!n)return'null';var a=n.closest&&n.closest('a');
        return n.tagName.toLowerCase()+(n.id?'#'+n.id:'')+'.'+String(n.className||'').slice(0,60)+(a?' a='+a.getAttribute('href'):'');};
        return JSON.stringify({path:location.pathname,el:d(el),ready:document.readyState,errs:(window.__cmdDbg||[]).slice(-5)});})()
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            webView.evaluateJavaScript(js) { result, error in
                DebugLog.write("dash probe at=\(x),\(y) \(result as? String ?? "err=\(String(describing: error))")")
            }
        }
    }
}
