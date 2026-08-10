package com.nyanya.qqj2me.util;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

public final class Base64 {
    private static final char[] ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private Base64() {
    }

    public static String encode(byte[] data) {
        if (data == null || data.length == 0) return "";
        StringBuffer out = new StringBuffer(((data.length + 2) / 3) * 4);
        int i;
        for (i = 0; i < data.length; i += 3) {
            int first = data[i] & 0xff;
            int second = i + 1 < data.length ? data[i + 1] & 0xff : 0;
            int third = i + 2 < data.length ? data[i + 2] & 0xff : 0;
            out.append(ALPHABET[first >>> 2]);
            out.append(ALPHABET[((first & 3) << 4) | (second >>> 4)]);
            out.append(i + 1 < data.length ? ALPHABET[((second & 15) << 2) | (third >>> 6)] : '=');
            out.append(i + 2 < data.length ? ALPHABET[third & 63] : '=');
        }
        return out.toString();
    }

    public static byte[] decode(String text) throws IOException {
        if (text == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream((text.length() * 3) / 4);
        int[] block = new int[4];
        int count = 0;
        int i;
        for (i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t') continue;
            int value = decodeChar(ch);
            if (value < -1) throw new IOException("Base64 数据非法");
            block[count++] = value;
            if (count == 4) {
                writeBlock(out, block);
                count = 0;
            }
        }
        if (count != 0) throw new IOException("Base64 数据长度非法");
        return out.toByteArray();
    }

    private static int decodeChar(char ch) {
        if (ch >= 'A' && ch <= 'Z') return ch - 'A';
        if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
        if (ch >= '0' && ch <= '9') return ch - '0' + 52;
        if (ch == '+') return 62;
        if (ch == '/') return 63;
        if (ch == '=') return -1;
        return -2;
    }

    private static void writeBlock(ByteArrayOutputStream out, int[] block) throws IOException {
        if (block[0] < 0 || block[1] < 0) throw new IOException("Base64 填充非法");
        out.write((block[0] << 2) | (block[1] >>> 4));
        if (block[2] >= 0) {
            out.write(((block[1] & 15) << 4) | (block[2] >>> 2));
            if (block[3] >= 0) out.write(((block[2] & 3) << 6) | block[3]);
        } else if (block[3] >= 0) {
            throw new IOException("Base64 填充非法");
        }
    }
}
