package com.nyanya.qqj2me.util;

/** Small CLDC-compatible CRC-32 implementation (polynomial 0xEDB88320). */
public final class Crc32 {
    private Crc32() {
    }

    public static int compute(byte[] data) {
        return compute(data, 0, data == null ? 0 : data.length);
    }

    public static int compute(byte[] data, int offset, int length) {
        int crc = 0xffffffff;
        int end = offset + length;
        int i;
        int bit;
        for (i = offset; i < end; i++) {
            crc ^= data[i] & 0xff;
            for (bit = 0; bit < 8; bit++) {
                if ((crc & 1) != 0) {
                    crc = (crc >>> 1) ^ 0xedb88320;
                } else {
                    crc >>>= 1;
                }
            }
        }
        return crc ^ 0xffffffff;
    }

    public static String hex(int value) {
        char[] digits = "0123456789ABCDEF".toCharArray();
        char[] result = new char[8];
        int i;
        for (i = 7; i >= 0; i--) {
            result[i] = digits[value & 15];
            value >>>= 4;
        }
        return new String(result);
    }
}
