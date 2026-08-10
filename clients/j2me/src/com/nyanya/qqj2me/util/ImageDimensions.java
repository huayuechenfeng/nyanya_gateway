package com.nyanya.qqj2me.util;

/** Header-only image dimension probe; it never invokes the platform decoder. */
public final class ImageDimensions {
    public static final String PNG = "PNG";
    public static final String GIF = "GIF";
    public static final String JPEG = "JPEG";
    public static final String WEBP = "WebP";

    public final int width;
    public final int height;
    public final String format;

    private ImageDimensions(int imageWidth, int imageHeight, String imageFormat) {
        width = imageWidth;
        height = imageHeight;
        format = imageFormat;
    }

    public static ImageDimensions parse(byte[] data) {
        if (data == null) return null;
        ImageDimensions value = parsePng(data);
        if (value == null) value = parseGif(data);
        if (value == null) value = parseJpeg(data);
        if (value == null) value = parseWebp(data);
        return value;
    }

    public boolean fitsPixelLimit(int maximumPixels) {
        return maximumPixels > 0 && width > 0 && height > 0
                && width <= maximumPixels / height;
    }

    public int pixelCountOrMaximum() {
        if (width <= 0 || height <= 0 || width > Integer.MAX_VALUE / height) {
            return Integer.MAX_VALUE;
        }
        return width * height;
    }

    private static ImageDimensions parsePng(byte[] data) {
        if (data.length < 24 || (data[0] & 0xff) != 0x89 || data[1] != 0x50
                || data[2] != 0x4e || data[3] != 0x47 || data[4] != 0x0d
                || data[5] != 0x0a || data[6] != 0x1a || data[7] != 0x0a
                || read32(data, 8) != 13 || data[12] != 0x49 || data[13] != 0x48
                || data[14] != 0x44 || data[15] != 0x52) return null;
        return dimensions(read32(data, 16), read32(data, 20), PNG);
    }

    private static ImageDimensions parseGif(byte[] data) {
        if (data.length < 10 || data[0] != 0x47 || data[1] != 0x49 || data[2] != 0x46
                || data[3] != 0x38 || (data[4] != 0x37 && data[4] != 0x39)
                || data[5] != 0x61) return null;
        return dimensions(read16Little(data, 6), read16Little(data, 8), GIF);
    }

    private static ImageDimensions parseJpeg(byte[] data) {
        if (data.length < 4 || (data[0] & 0xff) != 0xff || (data[1] & 0xff) != 0xd8) {
            return null;
        }
        int position = 2;
        while (position < data.length) {
            while (position < data.length && (data[position] & 0xff) == 0xff) position++;
            if (position >= data.length) return null;
            int marker = data[position++] & 0xff;
            if (marker == 0x00) continue;
            if (marker == 0xd9 || marker == 0xda) return null;
            if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
            if (position + 1 >= data.length) return null;
            int length = read16(data, position);
            if (length < 2 || position > data.length - length) return null;
            if (isStartOfFrame(marker)) {
                if (length < 7) return null;
                int height = read16(data, position + 3);
                int width = read16(data, position + 5);
                return dimensions(width, height, JPEG);
            }
            position += length;
        }
        return null;
    }

    private static boolean isStartOfFrame(int marker) {
        return marker == 0xc0 || marker == 0xc1 || marker == 0xc2 || marker == 0xc3
                || marker == 0xc5 || marker == 0xc6 || marker == 0xc7
                || marker == 0xc9 || marker == 0xca || marker == 0xcb
                || marker == 0xcd || marker == 0xce || marker == 0xcf;
    }

    private static ImageDimensions parseWebp(byte[] data) {
        if (data.length < 21 || data[0] != 0x52 || data[1] != 0x49 || data[2] != 0x46
                || data[3] != 0x46 || data[8] != 0x57 || data[9] != 0x45
                || data[10] != 0x42 || data[11] != 0x50) return null;
        if (matches(data, 12, "VP8X") && data.length >= 30) {
            int width = 1 + read24Little(data, 24);
            int height = 1 + read24Little(data, 27);
            return dimensions(width, height, WEBP);
        }
        if (matches(data, 12, "VP8 ") && data.length >= 30
                && (data[23] & 0xff) == 0x9d && data[24] == 0x01 && data[25] == 0x2a) {
            int width = read16Little(data, 26) & 0x3fff;
            int height = read16Little(data, 28) & 0x3fff;
            return dimensions(width, height, WEBP);
        }
        if (matches(data, 12, "VP8L") && data.length >= 25 && data[20] == 0x2f) {
            int b1 = data[21] & 0xff;
            int b2 = data[22] & 0xff;
            int b3 = data[23] & 0xff;
            int b4 = data[24] & 0xff;
            int width = 1 + b1 + ((b2 & 0x3f) << 8);
            int height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
            return dimensions(width, height, WEBP);
        }
        return null;
    }

    private static boolean matches(byte[] data, int offset, String text) {
        if (offset < 0 || offset + text.length() > data.length) return false;
        int i;
        for (i = 0; i < text.length(); i++) {
            if ((data[offset + i] & 0xff) != text.charAt(i)) return false;
        }
        return true;
    }

    private static ImageDimensions dimensions(int width, int height, String format) {
        return width > 0 && height > 0 ? new ImageDimensions(width, height, format) : null;
    }

    private static int read16(byte[] data, int offset) {
        return ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
    }

    private static int read16Little(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8);
    }

    private static int read24Little(byte[] data, int offset) {
        return (data[offset] & 0xff) | ((data[offset + 1] & 0xff) << 8)
                | ((data[offset + 2] & 0xff) << 16);
    }

    private static int read32(byte[] data, int offset) {
        return ((data[offset] & 0xff) << 24) | ((data[offset + 1] & 0xff) << 16)
                | ((data[offset + 2] & 0xff) << 8) | (data[offset + 3] & 0xff);
    }
}
