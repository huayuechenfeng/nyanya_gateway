package com.nyanya.qqj2me.util;

import java.io.ByteArrayOutputStream;

public final class Utf8 {
    private Utf8() {
    }

    public static byte[] encode(String value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(value.length());
        int i;
        for (i = 0; i < value.length(); i++) {
            int ch = value.charAt(i);
            if (ch < 0x80) {
                out.write(ch);
            } else if (ch < 0x800) {
                out.write(0xc0 | (ch >> 6));
                out.write(0x80 | (ch & 0x3f));
            } else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < value.length()) {
                int low = value.charAt(i + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    int codePoint = 0x10000 + ((ch - 0xd800) << 10) + (low - 0xdc00);
                    out.write(0xf0 | (codePoint >> 18));
                    out.write(0x80 | ((codePoint >> 12) & 0x3f));
                    out.write(0x80 | ((codePoint >> 6) & 0x3f));
                    out.write(0x80 | (codePoint & 0x3f));
                    i++;
                } else {
                    writeReplacement(out);
                }
            } else if (ch >= 0xdc00 && ch <= 0xdfff) {
                writeReplacement(out);
            } else {
                out.write(0xe0 | (ch >> 12));
                out.write(0x80 | ((ch >> 6) & 0x3f));
                out.write(0x80 | (ch & 0x3f));
            }
        }
        return out.toByteArray();
    }

    public static String decode(byte[] data) {
        return decode(data, 0, data.length);
    }

    public static String decode(byte[] data, int offset, int length) {
        StringBuffer result = new StringBuffer(length);
        int end = offset + length;
        int i = offset;
        while (i < end) {
            int first = data[i++] & 0xff;
            if (first < 0x80) {
                result.append((char) first);
            } else if ((first & 0xe0) == 0xc0 && i < end) {
                int second = data[i++] & 0x3f;
                result.append((char) (((first & 0x1f) << 6) | second));
            } else if ((first & 0xf0) == 0xe0 && i + 1 < end) {
                int second = data[i++] & 0x3f;
                int third = data[i++] & 0x3f;
                result.append((char) (((first & 0x0f) << 12) | (second << 6) | third));
            } else if ((first & 0xf8) == 0xf0 && i + 2 < end) {
                int second = data[i++] & 0x3f;
                int third = data[i++] & 0x3f;
                int fourth = data[i++] & 0x3f;
                int codePoint = ((first & 0x07) << 18) | (second << 12) | (third << 6) | fourth;
                codePoint -= 0x10000;
                result.append((char) (0xd800 | (codePoint >> 10)));
                result.append((char) (0xdc00 | (codePoint & 0x3ff)));
            } else {
                result.append('\ufffd');
            }
        }
        return result.toString();
    }

    private static void writeReplacement(ByteArrayOutputStream out) {
        out.write(0xef);
        out.write(0xbf);
        out.write(0xbd);
    }
}
