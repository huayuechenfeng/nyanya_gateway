package com.nyanya.qqj2me.util;

import java.io.IOException;
import java.util.Hashtable;
import java.util.Vector;

public final class Json {
    private Json() {
    }

    public static Object parse(String source) throws IOException {
        Parser parser = new Parser(source);
        Object value = parser.readValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw new IOException("JSON 尾部存在多余内容");
        }
        return value;
    }

    public static String quote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuffer out = new StringBuffer(value.length() + 16);
        out.append('"');
        int i;
        for (i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        String hex = Integer.toHexString(ch);
                        out.append("\\u");
                        int pad;
                        for (pad = hex.length(); pad < 4; pad++) {
                            out.append('0');
                        }
                        out.append(hex);
                    } else {
                        out.append(ch);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }

    public static String string(Object value) {
        return value instanceof String ? (String) value : null;
    }

    public static Hashtable object(Object value) {
        return value instanceof Hashtable ? (Hashtable) value : null;
    }

    public static Vector array(Object value) {
        return value instanceof Vector ? (Vector) value : null;
    }

    private static final class Parser {
        private final String source;
        private int position;

        Parser(String source) {
            this.source = source == null ? "" : source;
        }

        boolean atEnd() {
            return position >= source.length();
        }

        void skipWhitespace() {
            while (!atEnd()) {
                char ch = source.charAt(position);
                if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') {
                    position++;
                } else {
                    return;
                }
            }
        }

        Object readValue() throws IOException {
            skipWhitespace();
            if (atEnd()) {
                throw error("缺少 JSON 值");
            }
            char ch = source.charAt(position);
            if (ch == '"') return readString();
            if (ch == '{') return readObject();
            if (ch == '[') return readArray();
            if (ch == 't') return readLiteral("true", Boolean.TRUE);
            if (ch == 'f') return readLiteral("false", Boolean.FALSE);
            if (ch == 'n') return readLiteral("null", null);
            if (ch == '-' || (ch >= '0' && ch <= '9')) return readNumber();
            throw error("无法识别的 JSON 值");
        }

        private Hashtable readObject() throws IOException {
            Hashtable object = new Hashtable();
            position++;
            skipWhitespace();
            if (consume('}')) return object;
            while (true) {
                skipWhitespace();
                if (atEnd() || source.charAt(position) != '"') {
                    throw error("对象键必须是字符串");
                }
                String key = readString();
                skipWhitespace();
                require(':');
                Object value = readValue();
                object.put(key, value == null ? NullValue.INSTANCE : value);
                skipWhitespace();
                if (consume('}')) return object;
                require(',');
            }
        }

        private Vector readArray() throws IOException {
            Vector array = new Vector();
            position++;
            skipWhitespace();
            if (consume(']')) return array;
            while (true) {
                Object value = readValue();
                array.addElement(value == null ? NullValue.INSTANCE : value);
                skipWhitespace();
                if (consume(']')) return array;
                require(',');
            }
        }

        private String readString() throws IOException {
            require('"');
            StringBuffer out = new StringBuffer();
            while (!atEnd()) {
                char ch = source.charAt(position++);
                if (ch == '"') return out.toString();
                if (ch == '\\') {
                    if (atEnd()) throw error("字符串转义不完整");
                    char escaped = source.charAt(position++);
                    switch (escaped) {
                        case '"': out.append('"'); break;
                        case '\\': out.append('\\'); break;
                        case '/': out.append('/'); break;
                        case 'b': out.append('\b'); break;
                        case 'f': out.append('\f'); break;
                        case 'n': out.append('\n'); break;
                        case 'r': out.append('\r'); break;
                        case 't': out.append('\t'); break;
                        case 'u': out.append(readUnicode()); break;
                        default: throw error("未知字符串转义");
                    }
                } else {
                    out.append(ch);
                }
            }
            throw error("字符串未结束");
        }

        private char readUnicode() throws IOException {
            if (position + 4 > source.length()) throw error("Unicode 转义不完整");
            int value = 0;
            int i;
            for (i = 0; i < 4; i++) {
                char ch = source.charAt(position++);
                int digit = Character.digit(ch, 16);
                if (digit < 0) throw error("Unicode 转义非法");
                value = (value << 4) | digit;
            }
            return (char) value;
        }

        private String readNumber() throws IOException {
            int start = position;
            if (source.charAt(position) == '-') position++;
            while (!atEnd() && isDigit(source.charAt(position))) position++;
            if (!atEnd() && source.charAt(position) == '.') {
                position++;
                while (!atEnd() && isDigit(source.charAt(position))) position++;
            }
            if (!atEnd()) {
                char ch = source.charAt(position);
                if (ch == 'e' || ch == 'E') {
                    position++;
                    if (!atEnd() && (source.charAt(position) == '+' || source.charAt(position) == '-')) position++;
                    while (!atEnd() && isDigit(source.charAt(position))) position++;
                }
            }
            if (position == start) throw error("数字非法");
            return source.substring(start, position);
        }

        private Object readLiteral(String literal, Object value) throws IOException {
            if (position + literal.length() > source.length()
                    || !source.substring(position, position + literal.length()).equals(literal)) {
                throw error("常量非法");
            }
            position += literal.length();
            return value;
        }

        private boolean consume(char expected) {
            if (!atEnd() && source.charAt(position) == expected) {
                position++;
                return true;
            }
            return false;
        }

        private void require(char expected) throws IOException {
            if (!consume(expected)) throw error("需要字符 " + expected);
        }

        private boolean isDigit(char ch) {
            return ch >= '0' && ch <= '9';
        }

        private IOException error(String message) {
            return new IOException(message + "（位置 " + position + "）");
        }
    }

    private static final class NullValue {
        static final NullValue INSTANCE = new NullValue();
        private NullValue() {
        }
    }
}
