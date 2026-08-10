package com.nyanya.qqj2me.util;

public final class ImageReferenceParser {
    private ImageReferenceParser() {
    }

    public static String firstImageSource(String text) {
        if (text == null) return null;
        int marker = text.indexOf("![");
        while (marker >= 0) {
            int closeLabel = text.indexOf("](", marker + 2);
            if (closeLabel >= 0) {
                int closeUrl = text.indexOf(')', closeLabel + 2);
                if (closeUrl > closeLabel + 2) {
                    String value = clean(text.substring(closeLabel + 2, closeUrl));
                    if (isSupported(value)) return value;
                }
            }
            marker = text.indexOf("![", marker + 2);
        }

        int data = text.indexOf("data:image/");
        if (data >= 0) return scanBare(text, data);
        return null;
    }

    private static String scanBare(String text, int start) {
        int end = start;
        while (end < text.length()) {
            char ch = text.charAt(end);
            if (ch == ' ' || ch == '\r' || ch == '\n' || ch == '\t'
                    || ch == '"' || ch == '\'' || ch == ')') break;
            end++;
        }
        return clean(text.substring(start, end));
    }

    private static String clean(String value) {
        value = value.trim();
        if (value.length() > 1 && value.charAt(0) == '<' && value.charAt(value.length() - 1) == '>') {
            value = value.substring(1, value.length() - 1).trim();
        }
        int title = value.indexOf(" \"");
        if (title > 0) value = value.substring(0, title);
        return value;
    }

    private static boolean isSupported(String value) {
        String lower = value.toLowerCase();
        return lower.startsWith("http://") || lower.startsWith("https://")
                || lower.startsWith("data:image/");
    }
}
