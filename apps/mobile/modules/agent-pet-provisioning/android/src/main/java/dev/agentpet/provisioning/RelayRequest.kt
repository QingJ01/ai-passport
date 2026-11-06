package dev.agentpet.provisioning

import expo.modules.kotlin.Promise
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

internal object RelayRequest {
  private val client = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .callTimeout(12, TimeUnit.SECONDS)
    .connectTimeout(12, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
    .cookieJar(CookieJar.NO_COOKIES).cache(null)
    .build()

  private class PinMismatch : CertificateException("Leaf certificate fingerprint mismatch")

  // Accepts the server if and only if SHA-256(leaf certificate DER) equals the pin.
  // System trust anchors and hostname are deliberately not consulted for pinned requests.
  private class LeafPinTrustManager(private val pin: ByteArray) : X509TrustManager {
    @Volatile var mismatched = false
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      throw CertificateException("Client certificates are not accepted")
    }
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull()
      val digest = leaf?.let { MessageDigest.getInstance("SHA-256").digest(it.encoded) }
      if (digest == null || !MessageDigest.isEqual(digest, pin)) { mismatched = true; throw PinMismatch() }
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
  }

  private fun decodePin(hex: String): ByteArray {
    require(hex.length == 64 && hex.all { it in '0'..'9' || it in 'a'..'f' })
    return ByteArray(32) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
  }

  private fun pinnedClient(trust: LeafPinTrustManager): OkHttpClient {
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trust), null)
    // The pin replaces hostname identity: the QR binds this exact certificate, reached by .local name or LAN IP.
    return client.newBuilder()
      .sslSocketFactory(context.socketFactory, trust)
      .hostnameVerifier { _, _ -> true }
      .build()
  }

  private fun isPinFailure(e: Throwable?): Boolean {
    var cause = e
    var depth = 0
    while (cause != null && depth < 8) {
      if (cause is PinMismatch) return true
      cause = cause.cause
      depth++
    }
    return false
  }

  fun send(url: String, method: String, token: String, body: String?, pin: String?, promise: Promise) {
    try {
      val address = URI(url)
      require(address.scheme == "https" && address.host != null && address.rawUserInfo == null)
      require(method in listOf("GET", "POST", "DELETE") && token.toByteArray().size <= 8192)
      require((body?.toByteArray()?.size ?: 0) <= 16384)
      val trust = pin?.let { LeafPinTrustManager(decodePin(it)) }
      val http = if (trust == null) client else pinnedClient(trust)
      val data = body?.toRequestBody("application/json".toMediaType())
      val request = Request.Builder().url(url).header("Authorization", "Bearer $token")
        .header("Content-Type", "application/json").method(method, data).build()
      http.newCall(request).enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          if (trust?.mismatched == true || isPinFailure(e))
            promise.reject("PIN", "The computer's certificate fingerprint does not match the scanned pairing code.", null)
          else
            promise.reject("NETWORK", "HTTPS request failed. Check the service hostname, certificate trust and connection.", null)
        }
        override fun onResponse(call: Call, response: Response) {
          response.use {
            try {
              require((response.body?.contentLength() ?: 0) <= 262144)
              val output = ByteArrayOutputStream()
              response.body?.byteStream()?.use { stream ->
                val buffer = ByteArray(8192)
                while (true) {
                  val count = stream.read(buffer)
                  if (count < 0) break
                  require(output.size() + count <= 262144)
                  output.write(buffer, 0, count)
                }
              }
              promise.resolve(mapOf("status" to response.code, "body" to output.toString("UTF-8")))
            } catch (e: Exception) { promise.reject("NETWORK", "Invalid or oversized service response", null) }
          }
        }
      })
    } catch (e: Exception) { promise.reject("REQUEST", "Invalid secure service request", null) }
  }
}
