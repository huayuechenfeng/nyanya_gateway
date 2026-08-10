package com.nyanya.qqj2me.net;

import com.nyanya.qqj2me.util.Utf8;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

final class ByteLineReader {
    private final InputStream input;
    private final int maximumLineBytes;
    private final byte[] buffer = new byte[512];
    private int position;
    private int length;

    ByteLineReader(InputStream input, int limit) {
        this.input = input;
        maximumLineBytes = limit < 65536 ? 65536 : limit;
    }

    String readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(128);
        boolean readAny = false;
        while (true) {
            int value = readByte();
            if (value < 0) {
                if (!readAny) return null;
                return Utf8.decode(line.toByteArray());
            }
            readAny = true;
            if (value == '\n') {
                return Utf8.decode(line.toByteArray());
            }
            if (value != '\r') {
                if (line.size() >= maximumLineBytes) {
                    throw new IOException("服务器返回的单行数据过长");
                }
                line.write(value);
            }
        }
    }

    private int readByte() throws IOException {
        if (position >= length) {
            length = input.read(buffer);
            position = 0;
            if (length < 0) return -1;
        }
        return buffer[position++] & 0xff;
    }
}
