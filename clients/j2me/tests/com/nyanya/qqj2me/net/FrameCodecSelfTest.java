package com.nyanya.qqj2me.net;

import com.nyanya.qqj2me.util.Utf8;
import java.io.BufferedReader;
import java.io.FileReader;
import java.util.StringTokenizer;

public class FrameCodecSelfTest {
    public static void main(String[] args) throws Exception {
        String json = "{\"text\":\"你好\"}";
        byte[] frame = FrameCodec.encodeJson(FrameCodec.TYPE_SEND_TEXT, 7, json);
        check(frame.length == 12 + Utf8.encode(json).length, "frame length");
        int magic = ((frame[0] & 0xff) << 8) | (frame[1] & 0xff);
        check(magic == FrameCodec.MAGIC, "magic");
        check(frame[2] == 1, "version");
        check(frame[3] == FrameCodec.TYPE_SEND_TEXT, "type");
        check(FrameCodec.readInt(frame, 4) == 7, "seq");
        check(FrameCodec.readInt(frame, 8) == Utf8.encode(json).length, "len");
        check(Utf8.decode(frame, 12, frame.length - 12).equals(json), "payload roundtrip");
        check(FrameCodec.PROTOCOL_VERSION == 1, "semantic protocol version");
        check(FrameCodec.AUTH_CAPABILITIES_JSON.equals(
                "[\"text\",\"contacts\",\"notice\",\"offline\"]"),
                "J2ME capability declaration");
        if (args.length != 1) {
            throw new RuntimeException("FrameCodecSelfTest requires the shared v1 vector path");
        }
        checkGoldenVectors(args[0]);
        System.out.println("FrameCodecSelfTest OK");
    }

    private static void checkGoldenVectors(String filename) throws Exception {
        BufferedReader reader = new BufferedReader(new FileReader(filename));
        int count = 0;
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.length() == 0 || line.charAt(0) == '#') continue;
                StringTokenizer fields = new StringTokenizer(line, "\t");
                String name = fields.nextToken();
                int type = Integer.parseInt(fields.nextToken());
                int seq = Integer.parseInt(fields.nextToken());
                byte[] payload = fromHex(fields.nextToken());
                byte[] expected = fromHex(fields.nextToken());
                byte[] actual = FrameCodec.encode(type, seq, payload);
                check(equalBytes(actual, expected), "golden vector " + name);
                count++;
            }
        } finally {
            reader.close();
        }
        check(count == 2, "golden vector count");
    }

    private static byte[] fromHex(String value) {
        byte[] output = new byte[value.length() / 2];
        for (int i = 0; i < output.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16);
            int low = Character.digit(value.charAt(i * 2 + 1), 16);
            output[i] = (byte) ((high << 4) | low);
        }
        return output;
    }

    private static boolean equalBytes(byte[] left, byte[] right) {
        if (left.length != right.length) return false;
        for (int i = 0; i < left.length; i++) {
            if (left[i] != right[i]) return false;
        }
        return true;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new RuntimeException("FrameCodecSelfTest failed: " + message);
    }
}
