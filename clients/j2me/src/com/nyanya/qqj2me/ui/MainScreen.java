package com.nyanya.qqj2me.ui;

import com.nyanya.qqj2me.QqMidlet;
import com.nyanya.qqj2me.model.ChatMessage;
import com.nyanya.qqj2me.model.Contact;
import com.nyanya.qqj2me.net.GatewayConnection;
import com.nyanya.qqj2me.net.MessageListener;
import com.nyanya.qqj2me.store.ConversationStore;
import com.nyanya.qqj2me.store.SettingsStore;
import com.nyanya.qqj2me.util.TimeUtil;
import java.util.Vector;
import javax.microedition.lcdui.Alert;
import javax.microedition.lcdui.AlertType;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Font;
import javax.microedition.lcdui.Graphics;

public class MainScreen extends Canvas implements CommandListener, MessageListener {
    private static final int TITLE_H = 18;
    private static final int TAB_H = 20;
    private static final int BAR_H = 16;

    private final QqMidlet midlet;
    private final Display display;
    private final GatewayConnection connection;
    private final ConversationStore store;
    private final SettingsStore settings;
    private final String[] tabs = {"消息", "好友", "群", "设置"};
    private final Command selectCommand = new Command("选择", Command.OK, 1);
    private final Command backCommand = new Command("返回", Command.BACK, 2);
    private int tab;
    private int selected;
    private boolean online;
    private String statusText = "连接中...";
    private Vector friends = new Vector();
    private Vector groups = new Vector();
    private ChatScreen chatScreen;

    public MainScreen(QqMidlet midlet, GatewayConnection connection,
                      ConversationStore store, SettingsStore settings) {
        this.midlet = midlet;
        this.display = midlet.getDisplay();
        this.connection = connection;
        this.store = store;
        this.settings = settings;
        addCommand(selectCommand);
        addCommand(backCommand);
        setCommandListener(this);
        connection.setListener(this);
        online = connection.isAuthed();
        if (online) {
            statusText = "在线";
        }
        connection.fetchContacts();
    }

    public void close() {
        connection.close();
    }

    public void commandAction(Command command, Displayable displayable) {
        if (command == selectCommand) {
            openSelected();
        } else if (command == backCommand) {
            midlet.exit();
        }
    }

    protected void keyPressed(int keyCode) {
        int action = getGameAction(keyCode);
        if (action == Canvas.UP) {
            if (selected > 0) {
                selected--;
                repaint();
            }
        } else if (action == Canvas.DOWN) {
            if (selected < itemCount() - 1) {
                selected++;
                repaint();
            }
        } else if (action == Canvas.LEFT) {
            if (tab > 0) {
                tab--;
                selected = 0;
                repaint();
            }
        } else if (action == Canvas.RIGHT) {
            if (tab < tabs.length - 1) {
                tab++;
                selected = 0;
                repaint();
            }
        } else if (action == Canvas.FIRE) {
            openSelected();
        }
    }

    private int itemCount() {
        if (tab == 0) return store.getConversations().size();
        if (tab == 1) return friends.size();
        if (tab == 2) return groups.size();
        return 5;
    }

    private void openSelected() {
        if (tab == 0) {
            Vector conversations = store.getConversations();
            if (selected < 0 || selected >= conversations.size()) return;
            ConversationStore.ConversationMeta meta =
                    (ConversationStore.ConversationMeta) conversations.elementAt(selected);
            store.markRead(meta.peer);
            connection.sendReadAck(meta.peer);
            openChat(meta.chatType, meta.peer, meta.name);
        } else if (tab == 1) {
            if (selected < 0 || selected >= friends.size()) return;
            Contact contact = (Contact) friends.elementAt(selected);
            openChat("private", contact.id, contact.displayName());
        } else if (tab == 2) {
            if (selected < 0 || selected >= groups.size()) return;
            Contact contact = (Contact) groups.elementAt(selected);
            openChat("group", contact.id, contact.displayName());
        }
    }

    private void openChat(String chatType, String peer, String name) {
        chatScreen = new ChatScreen(midlet, connection, store, chatType, peer, name);
        display.setCurrent(chatScreen);
    }

    public void onNewMessage(ChatMessage message) {
        if (chatScreen != null && chatScreen.matches(message.peer)) {
            chatScreen.onNewMessage(message);
        } else {
            repaint();
        }
    }

    protected void paint(Graphics g) {
        int width = getWidth();
        int height = getHeight();
        g.setColor(0xFFFFFF);
        g.fillRect(0, 0, width, height);
        paintTitle(g, width);
        paintTabs(g, width);
        paintList(g, width, height);
        paintBars(g, width, height);
    }

    private void paintTitle(Graphics g, int width) {
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL);
        g.setFont(font);
        g.setColor(0x2E6FD8);
        g.fillRect(0, 0, width, TITLE_H);
        g.setColor(0xFFFFFF);
        g.drawString("J2ME QQ", 3, (TITLE_H - font.getHeight()) / 2, Graphics.TOP | Graphics.LEFT);
        String status = online ? "在线" : statusText;
        g.drawString(status, width - 3, (TITLE_H - font.getHeight()) / 2, Graphics.TOP | Graphics.RIGHT);
    }

    private void paintTabs(Graphics g, int width) {
        int tabWidth = width / tabs.length;
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        g.setFont(font);
        int i;
        for (i = 0; i < tabs.length; i++) {
            int x = i * tabWidth;
            if (i == tab) {
                g.setColor(0xDDECFF);
                g.fillRect(x, TITLE_H, tabWidth, TAB_H);
            }
            g.setColor(0x333333);
            g.drawString(tabs[i], x + tabWidth / 2, TITLE_H + (TAB_H - font.getHeight()) / 2,
                    Graphics.TOP | Graphics.HCENTER);
            g.drawLine(x + tabWidth - 1, TITLE_H, x + tabWidth - 1, TITLE_H + TAB_H);
        }
        g.setColor(0xCCCCCC);
        g.drawLine(0, TITLE_H + TAB_H, width, TITLE_H + TAB_H);
    }

    private void paintList(Graphics g, int width, int height) {
        int top = TITLE_H + TAB_H + 2;
        int bottom = height - BAR_H;
        Font nameFont = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL);
        Font textFont = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        Font timeFont = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_PLAIN, Font.SIZE_SMALL);
        g.setFont(textFont);
        if (tab == 0) {
            Vector conversations = store.getConversations();
            int y = top;
            int i;
            for (i = 0; i < conversations.size() && y + 34 <= bottom; i++) {
                ConversationStore.ConversationMeta meta =
                        (ConversationStore.ConversationMeta) conversations.elementAt(i);
                if (i == selected) {
                    g.setColor(0xDDECFF);
                    g.fillRect(0, y, width, 34);
                }
                g.setFont(nameFont);
                g.setColor(0x000000);
                String name = meta.name == null || meta.name.length() == 0 ? meta.peer : meta.name;
                g.drawString(name, 4, y + 1, Graphics.TOP | Graphics.LEFT);
                g.setFont(timeFont);
                g.setColor(0x888888);
                g.drawString(TimeUtil.format(meta.lastTime), width - 4, y + 1, Graphics.TOP | Graphics.RIGHT);
                g.setFont(textFont);
                g.setColor(0x444444);
                g.drawString(truncate(meta.lastText, width - 44, textFont), 4, y + 18, Graphics.TOP | Graphics.LEFT);
                if (meta.unread > 0) {
                    String badge = meta.unread > 99 ? "99+" : String.valueOf(meta.unread);
                    int badgeWidth = textFont.stringWidth(badge) + 6;
                    g.setColor(0xE53935);
                    g.fillRoundRect(width - badgeWidth - 4, y + 18, badgeWidth, 14, 7, 7);
                    g.setColor(0xFFFFFF);
                    g.drawString(badge, width - badgeWidth / 2 - 4, y + 19, Graphics.TOP | Graphics.HCENTER);
                }
                g.setColor(0xE0E0E0);
                g.drawLine(0, y + 33, width, y + 33);
                y += 34;
            }
            if (conversations.size() == 0) {
                g.setColor(0x888888);
                g.drawString("暂无会话", width / 2, top + 8, Graphics.TOP | Graphics.HCENTER);
            }
        } else if (tab == 1 || tab == 2) {
            Vector list = tab == 1 ? friends : groups;
            int y = top;
            int i;
            for (i = 0; i < list.size() && y + 26 <= bottom; i++) {
                Contact contact = (Contact) list.elementAt(i);
                if (i == selected) {
                    g.setColor(0xDDECFF);
                    g.fillRect(0, y, width, 26);
                }
                g.setFont(nameFont);
                g.setColor(0x000000);
                g.drawString(contact.displayName(), 4, y + 2, Graphics.TOP | Graphics.LEFT);
                g.setFont(textFont);
                g.setColor(0x888888);
                g.drawString(contact.id, width - 4, y + 2, Graphics.TOP | Graphics.RIGHT);
                g.setColor(0xE0E0E0);
                g.drawLine(0, y + 25, width, y + 25);
                y += 26;
            }
            if (list.size() == 0) {
                g.setColor(0x888888);
                g.drawString("列表为空（检查网关与 NapCat）", width / 2, top + 8, Graphics.TOP | Graphics.HCENTER);
            }
        } else {
            g.setColor(0x000000);
            int y = top;
            g.drawString("服务器: " + settings.getServer() + ":" + settings.getPort(), 4, y, Graphics.TOP | Graphics.LEFT);
            y += 16;
            g.drawString("设备: " + settings.getDevice(), 4, y, Graphics.TOP | Graphics.LEFT);
            y += 16;
            g.drawString("状态: " + (online ? "在线" : statusText), 4, y, Graphics.TOP | Graphics.LEFT);
            y += 16;
            g.setColor(0x888888);
            g.drawString("令牌保存在本机 RMS", 4, y, Graphics.TOP | Graphics.LEFT);
        }
    }

    private void paintBars(Graphics g, int width, int height) {
        Font font = Font.getFont(Font.FACE_SYSTEM, Font.STYLE_BOLD, Font.SIZE_SMALL);
        g.setFont(font);
        g.setColor(0xE0E0E0);
        g.fillRect(0, height - BAR_H, width, BAR_H);
        g.setColor(0x333333);
        g.drawString("选择", 3, height - BAR_H + 2, Graphics.TOP | Graphics.LEFT);
        g.drawString("返回", width - 3, height - BAR_H + 2, Graphics.TOP | Graphics.RIGHT);
    }

    private String truncate(String text, int maxWidth, Font font) {
        if (text == null) return "";
        if (font.stringWidth(text) <= maxWidth) return text;
        StringBuffer out = new StringBuffer();
        int i;
        for (i = 0; i < text.length(); i++) {
            String candidate = out.toString() + text.charAt(i);
            if (font.stringWidth(candidate) > maxWidth - font.stringWidth("…")) break;
            out.append(text.charAt(i));
        }
        out.append('…');
        return out.toString();
    }

    public void onAuthResult(boolean ok, long serverTime, int offlineCount, String message) {
        final boolean success = ok;
        display.callSerially(new Runnable() {
            public void run() {
                online = success;
                statusText = success ? "在线" : "登录失败";
                repaint();
            }
        });
    }

    public void onMessage(final ChatMessage message) {
        store.appendMessage(message);
        display.callSerially(new Runnable() {
            public void run() {
                onNewMessage(message);
            }
        });
    }

    public void onNotice(final String text, final long time) {
        display.callSerially(new Runnable() {
            public void run() {
                statusText = "通知";
                ChatMessage notice = new ChatMessage();
                notice.chatType = "private";
                notice.peer = "system";
                notice.peerName = "系统通知";
                notice.text = text;
                notice.time = time;
                notice.incoming = true;
                store.appendMessage(notice);
                repaint();
            }
        });
    }

    public void onContacts(final Vector friendList, final Vector groupList) {
        display.callSerially(new Runnable() {
            public void run() {
                friends = friendList == null ? new Vector() : friendList;
                groups = groupList == null ? new Vector() : groupList;
                if (selected >= itemCount()) selected = 0;
                repaint();
            }
        });
    }

    public void onDisconnected(final String reason) {
        display.callSerially(new Runnable() {
            public void run() {
                online = false;
                statusText = "已断开，自动重连中";
                repaint();
            }
        });
    }

    public void onSendResult(boolean ok, String messageId) {
        // 发送结果由聊天页本地乐观显示；失败时通过 onError 弹窗提示
    }

    public void onError(final String message) {
        display.callSerially(new Runnable() {
            public void run() {
                String reason = message == null || message.length() == 0 ? "未知错误" : message;
                Alert alert = new Alert("操作失败", reason, null, AlertType.ERROR);
                alert.setTimeout(2500);
                Displayable current = display.getCurrent();
                if (current == null) current = MainScreen.this;
                display.setCurrent(alert, current);
            }
        });
    }
}
