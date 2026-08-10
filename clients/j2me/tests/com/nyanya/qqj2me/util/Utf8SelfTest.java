package com.nyanya.qqj2me.util;

public class Utf8SelfTest {
    public static void main(String[] args) throws Exception {
        check(Utf8.encode("hello").length == 5, "ascii length");
        String chinese = "你好，QQ 2026！";
        check(Utf8.decode(Utf8.encode(chinese)).equals(chinese), "chinese roundtrip");
        String emoji = "A\uD83D\uDE00B";
        check(Utf8.decode(Utf8.encode(emoji)).equals(emoji), "surrogate roundtrip");
        System.out.println("Utf8SelfTest OK");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new RuntimeException("Utf8SelfTest failed: " + message);
    }
}
