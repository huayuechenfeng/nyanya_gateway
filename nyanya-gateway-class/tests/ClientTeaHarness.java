import java.lang.reflect.Method;

/**
 * Runs the TEA codec embedded in an original QQ client JAR for protocol
 * compatibility checks. The codec class is intentionally selected at runtime
 * because its obfuscated name differs between client builds.
 */
public final class ClientTeaHarness {
    private ClientTeaHarness() {
    }

    private static byte[] fromHex(String value) {
        if ((value.length() & 1) != 0) {
            throw new IllegalArgumentException("hex input must have an even length");
        }
        byte[] output = new byte[value.length() / 2];
        for (int i = 0; i < output.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16);
            int low = Character.digit(value.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) {
                throw new IllegalArgumentException("invalid hex input");
            }
            output[i] = (byte) ((high << 4) | low);
        }
        return output;
    }

    private static String toHex(byte[] value) {
        StringBuilder output = new StringBuilder(value.length * 2);
        for (byte item : value) {
            output.append(Character.forDigit((item >>> 4) & 0x0f, 16));
            output.append(Character.forDigit(item & 0x0f, 16));
        }
        return output.toString();
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            throw new IllegalArgumentException(
                "usage: ClientTeaHarness <codec-class> <encrypt|decrypt> <input-hex> <key-hex>");
        }

        String methodName;
        if ("encrypt".equals(args[1])) {
            methodName = "b";
        } else if ("decrypt".equals(args[1])) {
            methodName = "a";
        } else {
            throw new IllegalArgumentException("unknown operation: " + args[1]);
        }

        Class<?> codecClass = Class.forName(args[0]);
        Object codec = codecClass.getDeclaredConstructor().newInstance();
        Method method = codecClass.getMethod(methodName, byte[].class, byte[].class);
        byte[] output = (byte[]) method.invoke(codec, fromHex(args[2]), fromHex(args[3]));
        System.out.println(toHex(output));
    }
}
