import Foundation
import ExpoModulesCore

// A per-request session enforces redirect rejection below JavaScript's fetch/XHR layer.
final class RelayRequest: NSObject, URLSessionDataDelegate {
  private var promise: Promise?
  private var payload = Data()
  private var status = 0
  private var session: URLSession?
  init(url: String, method: String, token: String, body: String?, promise: Promise) {
    self.promise = promise
    super.init()
    guard let address = URL(string: url), address.scheme == "https", address.host != nil,
          address.user == nil, ["GET", "POST", "DELETE"].contains(method),
          token.utf8.count <= 8192, (body?.utf8.count ?? 0) <= 16384 else {
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
