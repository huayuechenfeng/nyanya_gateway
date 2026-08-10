package com.nyanya.qqj2me.ui;

import com.nyanya.qqj2me.QqMidlet;
import com.nyanya.qqj2me.model.ChatMessage;
import com.nyanya.qqj2me.net.GatewayConnection;
import com.nyanya.qqj2me.store.ConversationStore;
import com.nyanya.qqj2me.util.TimeUtil;
import java.util.Vector;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.TextBox;
import javax.microedition.lcdui.TextField;

public class ChatScreen extends Canvas implements CommandListener {
    private static final int TITLE_H = 18;
    private static final int BAR_H = 16;

    private final QqMidlet midlet;
    private final Display display;
    private final GatewayConnection connection;
    private final ConversationStore store;
    private final String chatType;
    private final String peer;
    private final String peerName;
    private final Command sendCommand = new Command("发送", Command.OK, 1);
    private final Command backCommand = new Command("返回", Command.BACK, 2);
    private Vector messages = new Vector();
    private int scrollY;
    private TextBox inputBox;

    public ChatScreen(QqMidlet midlet, GatewayConnection connection,
                      ConversationStore store, String chatType, String peer, String peerName) {
        this.midlet = midlet;
        this.display = midlet.getDisplay();
        this.connection = connection;
        this.store = store;
        this.chatType = chatType;
        this.peer = peer;
        this.peerName = peerName;
        messages = store.getMessages(peer, 60);
        addCommand(sendCommand);
        addCommand(backCommand);
        setCommandListener(this);
    }

    public boolean matches(String peerId) {
        return peer.equals(peerId);
    }

    public void onNewMessage(ChatMessage message) {
        messages.addElement(message);
        repaint();
    }

    public void commandAction(Command command, Displayable displayable) {
        if (command == sendCommand && displayable == this) {
            openInput();
        } else if (command == backCommand && displayable == this) {
            midlet.backToMain();
        } else if (displayable == inputBox) {
            if (command.getCommandType() == Command.OK) {
                String text = inputBox.getString().trim();
                if (text.length() > 0) {
                    sendText(text);
                }
            }
            inputBox = null;
            display.setCurrent(this);
        }
    }

    private void openInput() {
        inputBox = new TextBox("发送给 " + peerName, "", 500, TextField.ANY);
        inputBox.addCommand(new Command("发送", Command.OK, 1));
        inputBox.addCommand(new Command("取消", Command.CANCEL, 2));
        inputBox.setCommandListener(this);
        display.setCurrent(inputBox);
    }

    private void sendText(String text) {
        ChatMessage message = new ChatMessage();
        message.chatType = chatType;
        message.peer = peer;
        message.peerName = "我";
        message.text = text;
        message.time = System.currentTimeMillis() / 1000L;
        message.incoming = false;
        connection.sendText(chatType, peer, text);
        store.appendMessage(message);
        messages.addElement(message);
        repaint();
    }

    protected void keyPressed(int keyCode) {
        int action = getGameAction(keyCode);
        int maxScroll = computeMaxScroll();
        if (action == Canvas.UP && scrollY > 0) {
            scrollY -= 12;
            if (scrollY < 0) scrollY = 0;
            repaint();
        } else if (action == Canvas.DOWN && scrollY < maxScroll) {
            scrollY += 12;
            if (scrollY > maxScroll) scrollY = maxScroll;
            repaint();
        } else if (action == Canvas.FIRE) {
            openInput();
        }
    }

    protected void paint(Graphics g) {
        int width = getWidth();
        int height = getHeight();
        g.setColor(0xF2F2F2);
        g.fillRect(0, 0, width, height);
        paintTitle(g, width);

        int top = TITLE_H + 2;
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        g.setFont(font);
        int lineHeight = font.getHeight() + 2;
        int maxTextWidth = width - 24;
        int y = top - scrollY;
        int i;
        for (i = 0; i < messages.size(); i++) {
            ChatMessage message = (ChatMessage) messages.elementAt(i);
            Vector lines = wrap(message.text, maxTextWidth, font);
            int bubbleHeight = lines.size() * lineHeight + 10;
            int x = message.incoming ? 3 : width - 3 - (maxTextWidth + 12);
            int bubbleWidth = maxTextWidth + 12;
            if (!message.incoming && bubbleWidth > width - 20) bubbleWidth = width - 20;
            g.setColor(message.incoming ? 0xFFFFFF : 0xAEE3FF);
            g.fillRoundRect(x, y, bubbleWidth, bubbleHeight, 8, 8);
            g.setColor(message.incoming ? 0xBBBBBB : 0x7FC4F0);
            g.drawRoundRect(x, y, bubbleWidth, bubbleHeight, 8, 8);
            g.setColor(0x000000);
            int textY = y + 5;
            int j;
            for (j = 0; j < lines.size(); j++) {
                g.drawString((String) lines.elementAt(j), x + 6, textY, Graphics.TOP | Graphics.LEFT);
                textY += lineHeight;
            }
            String time = TimeUtil.format(message.time);
            if (time.length() > 0) {
                g.setColor(0x888888);
                g.drawString(time, x + bubbleWidth - 4, y + bubbleHeight - 3, Graphics.TOP | Graphics.RIGHT);
            }
            y += bubbleHeight + 4;
        }
        if (messages.size() == 0) {
            g.setColor(0x888888);
            g.drawString("暂无消息，按 发送 开始聊天", width / 2, top + 10, Graphics.TOP | Graphics.HCENTER);
        }
        paintBars(g, width, height);
    }

    private void paintTitle(Graphics g, int width) {
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL);
        g.setFont(font);
        g.setColor(0x2E6FD8);
        g.fillRect(0, 0, width, TITLE_H);
        g.setColor(0xFFFFFF);
        g.drawString(peerName, 3, (TITLE_H - font.getHeight()) / 2, Graphics.TOP | Graphics.LEFT);
    }

    private void paintBars(Graphics g, int width, int height) {
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL);
        g.setFont(font);
        g.setColor(0xE0E0E0);
        g.fillRect(0, height - BAR_H, width, BAR_H);
        g.setColor(0x333333);
        g.drawString("发送", 3, height - BAR_H + 2, Graphics.TOP | Graphics.LEFT);
        g.drawString("返回", width - 3, height - BAR_H + 2, Graphics.TOP | Graphics.RIGHT);
    }

    private Vector wrap(String text, int maxWidth, Font font) {
        Vector lines = new Vector();
        if (text == null || text.length() == 0) {
            lines.addElement("");
            return lines;
        }
        StringBuffer line = new StringBuffer();
        int i;
        for (i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (ch == '\n') {
                lines.addElement(line.toString());
                line.setLength(0);
                continue;
            }
            String candidate = line.toString() + ch;
            if (font.stringWidth(candidate) > maxWidth && line.length() > 0) {
                lines.addElement(line.toString());
                line.setLength(0);
            }
            line.append(ch);
        }
        if (line.length() > 0 || lines.size() == 0) {
            lines.addElement(line.toString());
        }
        return lines;
    }

    private int computeMaxScroll() {
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        int lineHeight = font.getHeight() + 2;
        int maxTextWidth = getWidth() - 24;
        int total = 0;
        int i;
        for (i = 0; i < messages.size(); i++) {
            ChatMessage message = (ChatMessage) messages.elementAt(i);
            Vector lines = wrap(message.text, maxTextWidth, font);
            total += lines.size() * lineHeight + 14;
        }
        int viewHeight = getHeight() - TITLE_H - BAR_H - 4;
        int max = total - viewHeight;
        return max < 0 ? 0 : max;
    }
}
