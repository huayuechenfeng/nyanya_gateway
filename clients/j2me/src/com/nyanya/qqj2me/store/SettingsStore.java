package com.nyanya.qqj2me.store;

import com.nyanya.qqj2me.util.Utf8;
import java.util.Random;
import javax.microedition.rms.RecordStore;
import javax.microedition.rms.RecordStoreException;

public class SettingsStore {
    private static final String STORE = "QQJ2ME_CFG";
    private static final Random RANDOM = new Random();
    private String server = "127.0.0.1";
    private int port = 14000;
    private String token = "";
    private String device = null;

    public void load() {
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(STORE, false);
            if (store.getNumRecords() > 0) {
                String text = Utf8.decode(store.getRecord(1));
                parseLines(text);
            }
        } catch (Exception e) {
            // 首次启动无存储
        } finally {
            closeStore(store);
        }
        ensureDevice();
    }

    private void ensureDevice() {
        // 每台手机生成唯一设备 ID 并持久化，避免多个客户端用同一 ID 互相踢下线
        if (device == null || device.length() == 0 || device.equals("j2me-1")) {
            device = "j2me-" + (100000 + RANDOM.nextInt(900000));
        }
    }

    public void save() {
        StringBuffer text = new StringBuffer(128);
        text.append("server=").append(server).append('\n');
        text.append("port=").append(port).append('\n');
        text.append("token=").append(token).append('\n');
        text.append("device=").append(device).append('\n');
        byte[] data = Utf8.encode(text.toString());
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(STORE, true);
            if (store.getNumRecords() > 0) {
                store.setRecord(1, data, 0, data.length);
            } else {
                store.addRecord(data, 0, data.length);
            }
        } catch (RecordStoreException e) {
            // ignore
        } finally {
            closeStore(store);
        }
    }

    private void parseLines(String text) {
        int start = 0;
        while (start < text.length()) {
            int end = text.indexOf('\n', start);
            if (end < 0) end = text.length();
            String line = text.substring(start, end).trim();
            int eq = line.indexOf('=');
            if (eq > 0) {
                String key = line.substring(0, eq).trim();
                String value = line.substring(eq + 1).trim();
                if (key.equals("server")) server = value;
                else if (key.equals("port")) {
                    try {
                        port = Integer.parseInt(value);
                    } catch (NumberFormatException e) {
                        // keep default
                    }
                } else if (key.equals("token")) token = value;
                else if (key.equals("device")) device = value;
            }
            start = end + 1;
        }
    }

    private void closeStore(RecordStore store) {
        if (store == null) return;
        try {
            store.closeRecordStore();
        } catch (RecordStoreException e) {
            // ignore
        }
    }

    public String getServer() {
        return server;
    }

    public void setServer(String server) {
        this.server = server;
    }

    public int getPort() {
        return port;
    }

    public void setPort(int port) {
        this.port = port;
    }

    public String getToken() {
        return token;
    }

    public void setToken(String token) {
        this.token = token;
    }

    public String getDevice() {
        if (device == null || device.length() == 0 || device.equals("j2me-1")) {
            device = "j2me-" + (100000 + RANDOM.nextInt(900000));
        }
        return device;
    }

    public void setDevice(String device) {
        this.device = device;
    }
}
