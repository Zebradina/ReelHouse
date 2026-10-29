package com.reelhouse.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URL;
import java.util.HashSet;
import java.util.Set;

/**
 * First screen: find a ReelHouse server and hand it to {@link BrowserActivity}.
 *
 * The remembered server is always shown first so a TV that stays on the same
 * network is one OK press from the library, and discovery still runs in case
 * the address changed.
 */
public class ConnectActivity extends Activity {

    private LinearLayout servers;
    private TextView status;
    private final Set<String> shown = new HashSet<>();
    private boolean scanning;
    private boolean destroyed;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_connect);

        servers = findViewById(R.id.servers);
        status = findViewById(R.id.status);
        findViewById(R.id.rescan).setOnClickListener(v -> startScan());
        findViewById(R.id.enter_address).setOnClickListener(v -> promptForAddress());

        startScan();
    }

    private void startScan() {
        if (scanning) return;
        scanning = true;

        servers.removeAllViews();
        shown.clear();
        status.setText(R.string.searching);

        String saved = ServerStore.url(this);
        if (saved != null) {
            addServer(getString(R.string.continue_with, hostOf(saved)), saved);
        }

        Discovery.scan(new Discovery.Listener() {
            @Override
            public void onFound(Discovery.Server server) {
                if (destroyed) return;
                // The saved entry is already on screen under a friendlier label.
                if (server.url.equals(ServerStore.url(ConnectActivity.this))) return;
                addServer(server.name + "  ·  " + hostOf(server.url), server.url);
            }

            @Override
            public void onFinished() {
                if (destroyed) return;
                scanning = false;
                if (servers.getChildCount() == 0) {
                    status.setText(R.string.no_servers);
                    findViewById(R.id.enter_address).requestFocus();
                } else {
                    status.setText(getResources().getQuantityString(
                            R.plurals.found_count, servers.getChildCount(), servers.getChildCount()));
                    servers.getChildAt(0).requestFocus();
                }
            }
        });
    }

    private void addServer(String label, String url) {
        if (!shown.add(url)) return;

        Button button = new Button(this, null, 0, R.style.ServerButton);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(v -> open(url));
        // A style cannot size a programmatically built view, so ask for the
        // full width here: rows that line up are much easier to track on a TV.
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(12);
        servers.addView(button, params);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void open(String url) {
        Intent intent = new Intent(this, BrowserActivity.class);
        intent.putExtra(BrowserActivity.EXTRA_URL, url);
        startActivity(intent);
    }

    private void promptForAddress() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.address_hint);
        input.setText(ServerStore.url(this) == null ? "" : hostOf(ServerStore.url(this)));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.enter_address)
                .setView(input)
                .setPositiveButton(R.string.connect_action, null)
                .setNegativeButton(R.string.cancel, null)
                .create();

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String url = normalise(input.getText().toString());
                    if (url == null) {
                        input.setError(getString(R.string.address_hint));
                        return;
                    }
                    dialog.dismiss();
                    verifyThenOpen(url);
                }));
        dialog.show();
        input.requestFocus();
    }

    /** Turns "192.168.1.20", "192.168.1.20:8090" or a full URL into a base URL. */
    private String normalise(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        try {
            URL parsed = new URL(value);
            if (parsed.getHost() == null || parsed.getHost().isEmpty()) return null;
            // A bare address means "the default ReelHouse port".
            if (parsed.getPort() == -1) value = value + ":8090";
            return value;
        } catch (Exception err) {
            return null;
        }
    }

    private void verifyThenOpen(String url) {
        status.setText(getString(R.string.checking, hostOf(url)));
        new Thread(() -> {
            String version = Discovery.reachableVersion(url);
            runOnUiThread(() -> {
                if (version == null) {
                    status.setText(R.string.searching);
                    Toast.makeText(this, getString(R.string.cannot_reach, hostOf(url)), Toast.LENGTH_LONG).show();
                    startScan();
                    return;
                }
                ServerStore.save(this, url, hostOf(url));
                open(url);
            });
        }, "reelhouse-verify").start();
    }

    /** "http://192.168.1.20:8090" -> "192.168.1.20:8090" for display. */
    private static String hostOf(String url) {
        String value = url.replace("http://", "").replace("https://", "");
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Coming back from the browser: rescan when the remembered server is not
        // the one on screen, otherwise a newly typed address would be hidden
        // behind the old one until the app restarted.
        String saved = ServerStore.url(this);
        if (!scanning && (shown.isEmpty() || (saved != null && !shown.contains(saved)))) startScan();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        super.onDestroy();
        servers = null;
    }
}
