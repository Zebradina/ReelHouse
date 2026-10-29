package com.reelhouse.tv;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Finds ReelHouse servers on the local network.
 *
 * Broadcasts {@code REELHOUSE/1 DISCOVER} to UDP 8090-8093 (the server also
 * shifts its port when 8090 is taken) and collects the JSON replies. Every
 * candidate address is then confirmed with GET /api/status, so a stale reply,
 * a different app on that port, or an address that is not reachable from this
 * device is dropped instead of offering the user a dead server.
 */
final class Discovery {

    static final class Server {
        final String url;
        final String name;
        final String version;

        Server(String url, String name, String version) {
            this.url = url;
            this.name = name;
            this.version = version;
        }
    }

    interface Listener {
        void onFound(Server server);

        void onFinished();
    }

    private static final String PROBE = "REELHOUSE/1 DISCOVER";
    private static final int[] PORTS = {8090, 8091, 8092, 8093};
    private static final int REPLY_WINDOW_MS = 1600;
    private static final int CONNECT_TIMEOUT_MS = 1500;

    private Discovery() {
    }

    /** Starts a scan on a background thread and reports back on the main one. */
    static void scan(Listener listener) {
        Thread thread = new Thread(() -> {
            Handler main = new Handler(Looper.getMainLooper());
            Set<String> seen = new HashSet<>();
            DatagramSocket socket = null;

            try {
                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(250);

                byte[] probe = PROBE.getBytes(StandardCharsets.UTF_8);
                for (InetAddress target : broadcastAddresses()) {
                    for (int port : PORTS) {
                        try {
                            socket.send(new DatagramPacket(probe, probe.length, target, port));
                        } catch (Exception ignored) {
                            // One unreachable broadcast address is not fatal.
                        }
                    }
                }

                long deadline = System.currentTimeMillis() + REPLY_WINDOW_MS;
                byte[] buffer = new byte[2048];
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try {
                        socket.receive(packet);
                    } catch (SocketTimeoutException timeout) {
                        continue;
                    }
                    String json = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8);
                    for (Server candidate : parse(json)) {
                        if (!seen.add(candidate.url)) continue;
                        Server verified = verify(candidate);
                        if (verified != null) main.post(() -> listener.onFound(verified));
                    }
                }
            } catch (Exception ignored) {
                // Reported as "nothing found"; the user can type an address.
            } finally {
                if (socket != null) socket.close();
                main.post(listener::onFinished);
            }
        }, "reelhouse-discovery");

        thread.setDaemon(true);
        thread.start();
    }

    private static List<InetAddress> broadcastAddresses() {
        List<InetAddress> addresses = new ArrayList<>();
        try {
            // The limited broadcast covers most home routers...
            addresses.add(InetAddress.getByName("255.255.255.255"));
            // ...and the per-interface broadcast covers the ones that drop it.
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress entry : nif.getInterfaceAddresses()) {
                    InetAddress broadcast = entry.getBroadcast();
                    if (broadcast != null) addresses.add(broadcast);
                }
            }
        } catch (Exception ignored) {
            // Fall through with whatever was collected.
        }
        return addresses;
    }

    /** One reply can name several addresses; each becomes its own candidate. */
    private static List<Server> parse(String json) {
        List<Server> servers = new ArrayList<>();
        try {
            JSONObject object = new JSONObject(json);
            if (!"ReelHouse".equals(object.optString("app"))) return servers;
            int port = object.optInt("port", 8090);
            String name = object.optString("name", "ReelHouse");
            String version = object.optString("version", "");
            JSONArray addresses = object.optJSONArray("addresses");
            if (addresses == null) return servers;
            for (int i = 0; i < addresses.length(); i += 1) {
                String host = addresses.optString(i, "");
                if (host.isEmpty()) continue;
                servers.add(new Server("http://" + host + ":" + port, name, version));
            }
        } catch (Exception ignored) {
            // Not our reply.
        }
        return servers;
    }

    /** Confirms the candidate really is a ReelHouse server this device can reach. */
    private static Server verify(Server candidate) {
        String version = reachableVersion(candidate.url);
        return version == null ? null : new Server(candidate.url, candidate.name, version);
    }

    /**
     * The server's version if {@code baseUrl} answers as ReelHouse, else null.
     * Used both to vet discovered servers and to check an address typed by hand.
     */
    static String reachableVersion(String baseUrl) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(baseUrl + "/api/status");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(CONNECT_TIMEOUT_MS);
            connection.setUseCaches(false);
            if (connection.getResponseCode() != 200) return null;

            StringBuilder body = new StringBuilder();
            try (InputStream in = connection.getInputStream()) {
                byte[] chunk = new byte[4096];
                int read;
                while ((read = in.read(chunk)) > 0) body.append(new String(chunk, 0, read, StandardCharsets.UTF_8));
            }
            JSONObject status = new JSONObject(body.toString());
            if (!"ReelHouse".equals(status.optString("app"))) return null;
            return status.optString("version", "");
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
