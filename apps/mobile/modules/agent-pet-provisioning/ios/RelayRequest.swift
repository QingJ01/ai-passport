import Foundation
import CryptoKit
import ExpoModulesCore

// A per-request session enforces redirect rejection below JavaScript's fetch/XHR layer.
// With a pin, the server is accepted if and only if the SHA-256 of its leaf certificate DER equals the pin;
// OS trust and hostname are not consulted for that request. Without a pin, normal OS trust applies.
final class RelayRequest: NSObject, URLSessionDataDelegate {
  private var promise: Promise?
  private var payload = Data()
  private var status = 0
  private var session: URLSession?
  private let pin: Data?
  private var pinMismatch = false
  init(url: String, method: String, token: String, body: String?, pin: String?, promise: Promise) {
    self.promise = promise
    self.pin = pin.flatMap(RelayRequest.decodePin)
    super.init()
    guard let address = URL(string: url), address.scheme == "https", address.host != nil,
          address.user == nil, ["GET", "POST", "DELETE"].contains(method),
          token.utf8.count <= 8192, (body?.utf8.count ?? 0) <= 16384,
          pin == nil || self.pin != nil else {
      promise.reject("REQUEST", "Invalid secure service request"); self.promise = nil; return
    }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 12
    config.timeoutIntervalForResource = 12
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    config.urlCache = nil
    config.httpShouldSetCookies = false
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.session = session
    var request = URLRequest(url: address)
    request.httpMethod = method
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body.map { Data($0.utf8) }
    session.dataTask(with: request).resume()
  }
  private static func decodePin(_ hex: String) -> Data? {
    let bytes = Array(hex.utf8)
    guard bytes.count == 64 else { return nil }
    var out = Data(capacity: 32)
    var index = 0
    while index < 64 {
      guard let hi = nibble(bytes[index]), let lo = nibble(bytes[index + 1]) else { return nil }
      out.append(hi << 4 | lo)
      index += 2
    }
    return out
  }
  private static func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case 48...57: return c - 48
    case 97...102: return c - 87
    default: return nil
    }
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      completionHandler(pin == nil ? .performDefaultHandling : .cancelAuthenticationChallenge, nil); return
    }
    guard let pin = pin else { completionHandler(.performDefaultHandling, nil); return }
    guard let trust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first else {
      pinMismatch = true
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    let digest = Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data))
    // Constant-time comparison over the fixed 32-byte digests.
    var diff: UInt8 = 0
    for (a, b) in zip(digest, pin) { diff |= a ^ b }
    if digest.count == pin.count && diff == 0 {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      pinMismatch = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.expectedContentLength <= 262144 else {
      completionHandler(.cancel); return
    }
    status = response.statusCode
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard payload.count + data.count <= 262144 else { dataTask.cancel(); return }
    payload.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let promise = promise {
      if error == nil, let body = String(data: payload, encoding: .utf8) {
        promise.resolve(["status": status, "body": body])
      } else if pinMismatch {
        promise.reject("PIN", "The computer's certificate fingerprint does not match the scanned pairing code.")
      } else {
        promise.reject("NETWORK", "HTTPS request failed. Check the service hostname, certificate trust and connection.")
      }
    }
    promise = nil
    payload.removeAll(keepingCapacity: false)
    self.session = nil
    session.finishTasksAndInvalidate()
  }
}
