package cc.cch.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.Menu
import android.view.MenuItem
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout

// Thin WebView shell around the CCH web dashboard. The dashboard (login,
// sessions, transcript, resume) is the product; this activity only provides
// server-URL persistence and navigation chrome.
class MainActivity : Activity() {

    private lateinit var webView: WebView

    private val prefs by lazy { getSharedPreferences("cch", MODE_PRIVATE) }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        // 10.0.2.2 is the emulator's alias for the host machine's loopback.
        private const val DEFAULT_URL = "http://10.0.2.2:3005"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // socket.io / localStorage
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        webView.webViewClient = object : WebViewClient() {
            // Keep all navigation inside the app shell.
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = false
        }
        // Enable chrome://inspect debugging for debug builds.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val url = prefs.getString(KEY_SERVER_URL, null)
        if (url.isNullOrBlank()) {
            promptServerUrl(DEFAULT_URL)
        } else {
            webView.loadUrl(url)
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Server")
        menu.add(0, 2, 1, "Reload")
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1 -> promptServerUrl(prefs.getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL)
            2 -> webView.reload()
        }
        return true
    }

    private fun promptServerUrl(current: String) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(current)
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle("Server address")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Connect") { _, _ ->
                var url = input.text.toString().trim()
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    url = "http://$url"
                }
                prefs.edit().putString(KEY_SERVER_URL, url).apply()
                webView.loadUrl(url)
            }
            .show()
    }

    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }
}
