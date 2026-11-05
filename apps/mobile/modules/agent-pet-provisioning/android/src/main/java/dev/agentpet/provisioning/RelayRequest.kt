package dev.agentpet.provisioning

import expo.modules.kotlin.Promise
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit

internal object RelayRequest {
  private val client = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .callTimeout(12, TimeUnit.SECONDS)
    .connectTimeout(12, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
    .cookieJar(CookieJar.NO_COOKIES).cache(null)
    .build()
  fun send(url: String, method: String, token: String, body: String?, promise: Promise) {
    try {
      val address = URI(url)
      require(address.scheme == "https" && address.host != null && address.rawUserInfo == null)
      require(method in listOf("GET", "POST", "DELETE") && token.toByteArray().size <= 8192)
      require((body?.toByteArray()?.size ?: 0) <= 16384)
      val data = body?.toRequestBody("application/json".toMediaType())
      val request = Request.Builder().url(url).header("Authorization", "Bearer $token")
        .header("Content-Type", "application/json").method(method, data).build()
      client.newCall(request).enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
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
