import CommanderContracts
import Foundation
import MenuBarCore

/// `POST /v1/clients/pair`: autentifikatsiyasiz (bir martalik kod bilan). Token kutilgan prefiksda bo'lishi tekshiriladi.
public enum PairingClient {
    public static func pair(
        _ request: PairingRequest, deviceName: String, transport: any HTTPTransport
    ) async -> Result<ClientPairResponse, PairingFailure> {
        guard let url = CenterURLs.api(center: request.centerURL, path: "/v1/clients/pair") else { return .failure(.network("URL noto'g'ri")) }
        var urlRequest = URLRequest(url: url, timeoutInterval: 20)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            urlRequest.httpBody = try JSONEncoder().encode(request.body(deviceName: deviceName))
            let (data, http) = try await transport.send(urlRequest)
            guard (200..<300).contains(http.statusCode) else { return .failure(PairingFailure.from(status: http.statusCode, body: data)) }
            guard let ok = try? JSONDecoder().decode(ClientPairResponse.self, from: data), ok.token.hasPrefix(CommanderContract.clientTokenPrefix) else {
                return .failure(.server(http.statusCode))
            }
            return .success(ok)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }
}
