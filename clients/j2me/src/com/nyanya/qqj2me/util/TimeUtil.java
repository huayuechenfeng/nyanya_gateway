package com.nyanya.qqj2me.util;

import java.util.Calendar;
import java.util.Date;

public final class TimeUtil {
    private TimeUtil() {
    }

    public static String format(long epochSeconds) {
        if (epochSeconds <= 0L) return "";
        try {
            Calendar calendar = Calendar.getInstance();
            calendar.setTime(new Date(epochSeconds * 1000L));
            return pad(calendar.get(Calendar.HOUR_OF_DAY)) + ":" + pad(calendar.get(Calendar.MINUTE));
        } catch (Exception e) {
            return "";
        }
    }

    private static String pad(int value) {
        if (value < 10) return "0" + value;
        return String.valueOf(value);
    }
}
