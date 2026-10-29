package com.reelhouse.tv;

import android.content.Context;
import android.content.SharedPreferences;

/** Remembers the last server so the TV does not have to search every time. */
final class ServerStore {

    private static final String PREFS = "reelhouse";
    private static final String KEY_URL = "server_url";
    private static final String KEY_NAME = "server_name";

    private ServerStore() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String url(Context context) {
        return prefs(context).getString(KEY_URL, null);
    }

    static String name(Context context) {
        return prefs(context).getString(KEY_NAME, null);
    }

    static void save(Context context, String url, String name) {
        prefs(context).edit().putString(KEY_URL, url).putString(KEY_NAME, name).apply();
    }

    static void clear(Context context) {
        prefs(context).edit().remove(KEY_URL).remove(KEY_NAME).apply();
    }
}
