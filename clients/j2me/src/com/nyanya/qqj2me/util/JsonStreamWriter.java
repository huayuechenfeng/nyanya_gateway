package com.nyanya.qqj2me.util;

import java.io.IOException;
import java.io.OutputStream;

/**
 * Small JSON/UTF-8 writer used twice: once without an OutputStream to obtain
 * Content-Length, then once to emit the request directly to the connection.
 */
public final class JsonStreamWriter {
    private static final byte[] BASE64 =
            Utf8.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final OutputStream output;
    private final byte[] buffer;
    private int buffered;
    private int size;

    public JsonStreamWriter(OutputStream target) {
        output = target;
        buffer = target == null ? null : new byte[512];
    }

    public int size() {
        return size;
    }

    public void raw(String ascii) throws IOException {
        int i;
        for (i = 0; i < ascii.length(); i++) write(ascii.charAt(i) & 0x7f);
    }

    public void quoted(String value) throws IOException {
        if (value == null) value = "";
        write('"');
        int i;
        for (i = 0; i < value.length(); i++) {
            int ch = value.charAt(i);
            if (ch == '"') raw("\\\"");
            else if (ch == '\\') raw("\\\\");
            else if (ch == '\b') raw("\\b");
            else if (ch == '\f') raw("\\f");
            else if (ch == '\n') raw("\\n");
            else if (ch == '\r') raw("\\r");
            else if (ch == '\t') raw("\\t");
            else if (ch < 0x20) {
                raw("\\u00");
                write(HEX[(ch >>> 4) & 15]);
                write(HEX[ch & 15]);
            } else if (ch < 0x80) {
                write(ch);
            } else if (ch < 0x800) {
                write(0xc0 | (ch >>> 6));
                write(0x80 | (ch & 0x3f));
            } else if (ch >= 0xd800 && ch <= 0xdbff) {
                if (i + 1 < value.length()) {
                    int low = value.charAt(i + 1);
                    if (low >= 0xdc00 && low <= 0xdfff) {
                        int point = 0x10000 + ((ch - 0xd800) << 10) + low - 0xdc00;
                        write(0xf0 | (point >>> 18));
                        write(0x80 | ((point >>> 12) & 0x3f));
                        write(0x80 | ((point >>> 6) & 0x3f));
                        write(0x80 | (point & 0x3f));
                        i++;
                    } else writeReplacement();
                } else writeReplacement();
            } else if (ch >= 0xdc00 && ch <= 0xdfff) {
                writeReplacement();
            } else {
                write(0xe0 | (ch >>> 12));
                write(0x80 | ((ch >>> 6) & 0x3f));
                write(0x80 | (ch & 0x3f));
            }
        }
        write('"');
    }

    public void base64(byte[] data) throws IOException {
        if (data == null) return;
        int i;
        for (i = 0; i < data.length; i += 3) {
            int first = data[i] & 0xff;
            int second = i + 1 < data.length ? data[i + 1] & 0xff : 0;
            int third = i + 2 < data.length ? data[i + 2] & 0xff : 0;
            write(BASE64[first >>> 2]);
            write(BASE64[((first & 3) << 4) | (second >>> 4)]);
            write(i + 1 < data.length ? BASE64[((second & 15) << 2) | (third >>> 6)] : '=');
            write(i + 2 < data.length ? BASE64[third & 63] : '=');
        }
    }

    public void finish() throws IOException {
        flushBuffer();
    }

    private void writeReplacement() throws IOException {
        write(0xef);
        write(0xbf);
        write(0xbd);
    }

    private void write(int value) throws IOException {
        if (size == Integer.MAX_VALUE) throw new IOException("JSON 请求过大");
        size++;
        if (output == null) return;
        buffer[buffered++] = (byte) value;
        if (buffered == buffer.length) flushBuffer();
    }

    private void flushBuffer() throws IOException {
        if (output != null && buffered > 0) {
            output.write(buffer, 0, buffered);
            buffered = 0;
        }
    }
}
