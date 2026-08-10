package com.nyanya.qqj2me.net;

import com.nyanya.qqj2me.util.Utf8;

public final class FrameCodec {
    public static final int MAGIC = 0x4a51;
    public static final int VERSION = 1;
    public static final int PROTOCOL_VERSION = 1;
    public static final int HEADER_SIZE = 12;
    public static final int MAX_PAYLOAD = 65536;

    public static final String CAPABILITY_TEXT = "text";
    public static final String CAPABILITY_CONTACTS = "contacts";
    public static final String CAPABILITY_NOTICE = "notice";
    public static final String CAPABILITY_OFFLINE = "offline";
    public static final String AUTH_CAPABILITIES_JSON =
            "[\"text\",\"contacts\",\"notice\",\"offline\"]";

    public static final int TYPE_AUTH = 1;
    public static final int TYPE_PING = 2;
    public static final int TYPE_PONG = 3;
    public static final int TYPE_SEND_TEXT = 10;
    public static final int TYPE_FETCH_CONTACTS = 11;
    public static final int TYPE_FETCH_HISTORY = 12;
    public static final int TYPE_READ_ACK = 13;
    public static final int TYPE_AUTH_OK = 20;
    public static final int TYPE_AUTH_FAIL = 21;
    public static final int TYPE_MSG_PUSH = 30;
    public static final int TYPE_CONTACTS_SYNC = 31;
    public static final int TYPE_HISTORY_PAGE = 32;
    public static final int TYPE_KICK = 33;
    public static final int TYPE_NOTICE = 34;
    public static final int TYPE_ERROR = 40;
    public static final int TYPE_SEND_RESULT = 41;

    private FrameCodec() {
    }

    public static byte[] encode(int type, int seq, byte[] payload) {
        if (payload == null) payload = new byte[0];
        byte[] out = new byte[HEADER_SIZE + payload.length];
        out[0] = (byte) 0x4a;
        out[1] = (byte) 0x51;
        out[2] = (byte) VERSION;
        out[3] = (byte) type;
        writeInt(out, 4, seq);
        writeInt(out, 8, payload.length);
        System.arraycopy(payload, 0, out, HEADER_SIZE, payload.length);
        return out;
    }

    public static byte[] encodeJson(int type, int seq, String json) {
        return encode(type, seq, Utf8.encode(json == null ? "" : json));
    }

    public static int readInt(byte[] data, int offset) {
        return ((data[offset] & 0xff) << 24)
                | ((data[offset + 1] & 0xff) << 16)
                | ((data[offset + 2] & 0xff) << 8)
                | (data[offset + 3] & 0xff);
    }

    private static void writeInt(byte[] out, int offset, int value) {
        out[offset] = (byte) (value >>> 24);
        out[offset + 1] = (byte) (value >>> 16);
        out[offset + 2] = (byte) (value >>> 8);
        out[offset + 3] = (byte) value;
    }
}
