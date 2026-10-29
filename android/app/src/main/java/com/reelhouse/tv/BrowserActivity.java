package com.reelhouse.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Runs the ReelHouse web app inside a WebView.
 *
 * Reusing the web app means the TV gets the same library, guide, Discover tab
 * and player as the desktop, but it needs two additions: a small injected shim
 * so a D-pad can move between cards and press them, and a WebChromeClient that
 * lets the HTML5 player go fullscreen.
 */
public class BrowserActivity extends Activity {

    static final String EXTRA_URL = "url";

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean errorDialogShown;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_browser);

        root = findViewById(R.id.root);
        web = findViewById(R.id.web);

        String baseUrl = getIntent().getStringExtra(EXTRA_URL);
        if (baseUrl == null) {
            finish();
            return;
        }

        configureWebView();
        immersive();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                injectShim(view);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showUnreachable();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });

        web.loadUrl(baseUrl + "/");
        web.requestFocus();
    }

    private void configureWebView() {
        web.setBackgroundColor(Color.BLACK);
        web.setKeepScreenOn(true);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The player starts HLS by itself; a "user gesture" on a TV is a click
        // the WebView does not always treat as one.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " ReelHouseTV/" + BuildConfig.VERSION_NAME);
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /** Adds focus handling for a remote — see assets/tv-shim.js. */
    private void injectShim(WebView view) {
        try (InputStream in = getAssets().open("tv-shim.js")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            view.evaluateJavascript(out.toString(StandardCharsets.UTF_8.name()), null);
        } catch (Exception err) {
            // The app still works without the shim; anchors are focusable anyway.
            Toast.makeText(this, "TV controls unavailable: " + err.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void showUnreachable() {
        if (errorDialogShown) return;
        errorDialogShown = true;
        String url = web.getUrl();
        new AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setMessage("ReelHouse could not be reached at " + url + ".\n\nIs it still running, and is network access on in Settings?")
                .setPositiveButton("Try again", (dialog, which) -> {
                    errorDialogShown = false;
                    web.reload();
                })
                .setNegativeButton("Change server", (dialog, which) -> {
                    ServerStore.clear(this);
                    finish();
                })
                .setOnCancelListener(dialog -> errorDialogShown = false)
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) {
                // Leaving fullscreen video before leaving the page.
                if (customViewCallback != null) customViewCallback.onCustomViewHidden();
                return true;
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
