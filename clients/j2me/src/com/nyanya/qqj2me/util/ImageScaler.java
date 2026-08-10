package com.nyanya.qqj2me.util;

import javax.microedition.lcdui.Image;

public final class ImageScaler {
    private ImageScaler() {
    }

    public static Image fit(Image source, int maximumWidth, int maximumHeight) {
        int sourceWidth = source.getWidth();
        int sourceHeight = source.getHeight();
        if (sourceWidth <= maximumWidth && sourceHeight <= maximumHeight) return source;
        int width = maximumWidth;
        int height = (sourceHeight * width) / sourceWidth;
        if (height > maximumHeight) {
            height = maximumHeight;
            width = (sourceWidth * height) / sourceHeight;
        }
        if (width < 1) width = 1;
        if (height < 1) height = 1;
        int[] sourceRgb = new int[sourceWidth * sourceHeight];
        int[] targetRgb = new int[width * height];
        source.getRGB(sourceRgb, 0, sourceWidth, 0, 0, sourceWidth, sourceHeight);
        int y;
        for (y = 0; y < height; y++) {
            int sourceY = (y * sourceHeight) / height;
            int x;
            for (x = 0; x < width; x++) {
                targetRgb[y * width + x] = sourceRgb[sourceY * sourceWidth + (x * sourceWidth) / width];
            }
        }
        return Image.createRGBImage(targetRgb, width, height, true);
    }
}
