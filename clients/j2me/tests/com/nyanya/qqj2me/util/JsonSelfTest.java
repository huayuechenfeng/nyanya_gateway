package com.nyanya.qqj2me.util;

import java.util.Hashtable;
import java.util.Vector;

public class JsonSelfTest {
    public static void main(String[] args) throws Exception {
        String source = "{\"a\":\"\\u4f60\\u597d\",\"b\":[1,2,\"x\"],\"c\":true,\"d\":null}";
        Hashtable table = Json.object(Json.parse(source));
        check(table != null, "parse object");
        check(Json.string(table.get("a")).equals("你好"), "unicode escape");
        Vector array = Json.array(table.get("b"));
        check(array != null && array.size() == 3, "parse array");
        check(Json.quote("a\"b\\c\n").indexOf("\\\"") > 0, "quote escapes");
        System.out.println("JsonSelfTest OK");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new RuntimeException("JsonSelfTest failed: " + message);
    }
}
