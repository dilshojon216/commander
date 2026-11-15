import Foundation
import Darwin

/// Soket serveri: yangi qator bilan ajratilgan JSON. Handshake (har yangi ulanishda): server `challenge{nonce}` yuboradi, klient
/// `auth{nonce, mac}` (HMAC-SHA256, kalit = `run/auth.secret`, har ishga tushishda yangilanadi = "per-boot"), server `ready{mac}`.
/// HMAC ikki tomonlama: markaz soxta imzolovchiga ham ulanmaydi. Maqsad: noto'g'ri jarayon/eski soket aralashmasin;
/// asosiy to'siq: secret fayl ruxsatlari (0600, 0700 katalog) + siyosat + rate limit + audit + LOCK.
public final class SignerServer {
    public static let maxLine = 16 * 1024
    public static let maxConnections = 8
    private let service: SignerService
    private let secret: Data
    private var listeners: [Int32] = []
    private let activeLock = NSLock()
    private var active = 0
    public private(set) var boundTcpPort: UInt16 = 0

    public init(service: SignerService, secret: Data) { self.service = service; self.secret = secret }

    // MARK: tinglash

    /// Faqat loopback (127.0.0.1) qabul qilinadi.
    public func listenTcp(port: UInt16) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SignerError("internal", "socket: \(String(cString: strerror(errno)))") }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard rc == 0, listen(fd, 16) == 0 else { let m = String(cString: strerror(errno)); close(fd); throw SignerError("internal", "bind/listen 127.0.0.1:\(port): \(m)") }
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        boundTcpPort = UInt16(bigEndian: bound.sin_port)
        listeners.append(fd)
        accept(on: fd)
    }

    public func listenUnix(path: String) throws {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SignerError("internal", "socket: \(String(cString: strerror(errno)))") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { close(fd); throw SignerError("internal", "unix socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in for (i, b) in bytes.enumerated() { buf[i] = b } }
        let old = umask(0o177)
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        umask(old)
        guard rc == 0, listen(fd, 16) == 0 else { let m = String(cString: strerror(errno)); close(fd); throw SignerError("internal", "bind/listen \(path): \(m)") }
        chmod(path, 0o600)
        listeners.append(fd)
        accept(on: fd)
    }

    public func stop() { for fd in listeners { shutdown(fd, SHUT_RDWR); close(fd) }; listeners = [] }

    private func accept(on fd: Int32) {
        let t = Thread { [weak self] in
            while true {
                let c = Darwin.accept(fd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                guard let self else { close(c); return }
                self.activeLock.lock(); let over = self.active >= Self.maxConnections; if !over { self.active += 1 }; self.activeLock.unlock()
                if over { close(c); continue }
                let h = Thread { self.serve(c) }
                h.stackSize = 512 * 1024
                h.start()
            }
        }
        t.stackSize = 512 * 1024
        t.start()
    }

    // MARK: ulanish

    private func serve(_ fd: Int32) {
        defer { close(fd); activeLock.lock(); active -= 1; activeLock.unlock() }
        var nosig: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))
        setTimeout(fd, seconds: 5)
        var buffer = Data()
        let sNonce = Enc.b64url(Enc.randomBytes(32))
        guard send(fd, ["v": 1, "t": "challenge", "nonce": sNonce]) else { return }
        guard let first = readLine(fd, &buffer), let a = (try? JSONSerialization.jsonObject(with: first)) as? [String: Any], a["t"] as? String == "auth",
              let cNonce = a["nonce"] as? String, cNonce.count == 43, let mac = a["mac"] as? String, let macData = Enc.fromB64url(mac) else {
            _ = send(fd, ["v": 1, "t": "error", "code": "auth_failed"]); return
        }
        let want = Enc.hmac(key: secret, "COMMANDER-SIGNER-V1:client\n\(sNonce)\n\(cNonce)")
        guard Enc.constantTimeEqual(want, macData) else { _ = send(fd, ["v": 1, "t": "error", "code": "auth_failed"]); return }
        let srv = Enc.b64url(Enc.hmac(key: secret, "COMMANDER-SIGNER-V1:server\n\(sNonce)\n\(cNonce)"))
        guard send(fd, ["v": 1, "t": "ready", "mac": srv]) else { return }
        setTimeout(fd, seconds: 60)
        let peer = Self.peerDescription(fd)
        var served = 0
        while served < 64, let line = readLine(fd, &buffer) {
            served += 1
            guard send(fd, service.handle(line, peer: peer)) else { return }
        }
    }

    static func peerDescription(_ fd: Int32) -> String {
        var addr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let rc = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &len) } }
        if rc == 0, addr.sin_family == sa_family_t(AF_INET) {
            return "tcp:\(String(cString: inet_ntoa(addr.sin_addr))):\(UInt16(bigEndian: addr.sin_port))"
        }
        return "unix"
    }

    private func setTimeout(_ fd: Int32, seconds: Int) {
        var tv = timeval(tv_sec: seconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    private func readLine(_ fd: Int32, _ buffer: inout Data) -> Data? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer.removeSubrange(buffer.startIndex...nl)
                return line.count > Self.maxLine ? nil : Data(line)
            }
            if buffer.count > Self.maxLine { return nil }
            var chunk = [UInt8](repeating: 0, count: 4096)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { if n < 0 && errno == EINTR { continue }; return nil }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    @discardableResult
    private func send(_ fd: Int32, _ obj: [String: Any]) -> Bool {
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]) else { return false }
        data.append(0x0A)
        var off = 0
        while off < data.count {
            let n = data[off...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if n <= 0 { if n < 0 && errno == EINTR { continue }; return false }
            off += n
        }
        return true
    }
}

/// Auth secret: har ishga tushishda yangilanadi, 0600. Fayl INODE'i saqlanadi (Docker bind-mount katalogi yangilanishni ko'radi).
public enum AuthSecret {
    public static func generate(at path: String) throws -> Data {
        let secret = Enc.randomBytes(32)
        let text = Data((Enc.b64url(secret) + "\n").utf8)
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw SignerError("internal", "cannot write auth secret: \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        fchmod(fd, 0o600)
        let n = text.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        guard n == text.count else { throw SignerError("internal", "cannot write auth secret") }
        return secret
    }
}
