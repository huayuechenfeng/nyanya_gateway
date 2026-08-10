package com.nyanya.qqj2me.ui;

import com.nyanya.qqj2me.QqMidlet;
import com.nyanya.qqj2me.model.ChatMessage;
import com.nyanya.qqj2me.net.GatewayConnection;
import com.nyanya.qqj2me.net.MessageListener;
import com.nyanya.qqj2me.store.SettingsStore;
import java.util.Vector;
import javax.microedition.lcdui.Alert;
import javax.microedition.lcdui.AlertType;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Form;
import javax.microedition.lcdui.TextField;

public class LoginScreen extends Form implements CommandListener {
    private final QqMidlet midlet;
    private final Display display;
    private final SettingsStore settings;
    private final TextField serverField;
    private final TextField portField;
    private final TextField tokenField;
    private final Command loginCommand = new Command("登录", Command.OK, 1);
    private final Command exitCommand = new Command("退出", Command.EXIT, 2);

    public LoginScreen(QqMidlet midlet, SettingsStore settings) {
        super("J2ME QQ 登录");
        this.midlet = midlet;
        this.display = midlet.getDisplay();
        this.settings = settings;
        serverField = new TextField("网关地址", settings.getServer(), 64, TextField.ANY);
        portField = new TextField("端口", String.valueOf(settings.getPort()), 6, TextField.NUMERIC);
        tokenField = new TextField("设备令牌", settings.getToken(), 64, TextField.ANY);
        append(serverField);
        append(portField);
        append(tokenField);
        addCommand(loginCommand);
        addCommand(exitCommand);
        setCommandListener(this);
    }

    public void commandAction(Command command, Displayable displayable) {
        if (command == loginCommand) {
            doLogin();
        } else if (command == exitCommand) {
            midlet.exit();
        }
    }

    private void doLogin() {
        final String server = serverField.getString().trim();
        int port = 14000;
        try {
            port = Integer.parseInt(portField.getString().trim());
        } catch (NumberFormatException e) {
            // keep default
        }
        final String token = tokenField.getString().trim();
        String device = settings.getDevice();
        if (device == null || device.length() == 0) {
            device = "j2me-1";
        }
        settings.setServer(server);
        settings.setPort(port);
        settings.setToken(token);
        settings.save();

        final Alert connecting = new Alert("连接中", "正在连接 " + server + ":" + port, null, AlertType.INFO);
        connecting.setTimeout(Alert.FOREVER);
        display.setCurrent(connecting);

        final GatewayConnection connection = new GatewayConnection(server, port, device, token);
        connection.setListener(new MessageListener() {
            public void onAuthResult(boolean ok, long serverTime, int offlineCount, String message) {
                if (ok) {
                    display.callSerially(new Runnable() {
                        public void run() {
                            midlet.onLoginSuccess(connection);
                        }
                    });
                } else {
                    final String reason = message == null ? "登录失败" : message;
                    display.callSerially(new Runnable() {
                        public void run() {
                            midlet.showLogin(reason);
                        }
                    });
                }
            }

            public void onMessage(ChatMessage message) {
                // 登录阶段忽略
            }

            public void onNotice(String text, long time) {
                // 登录阶段忽略
            }

            public void onContacts(Vector friends, Vector groups) {
                // 登录阶段忽略
            }

            public void onDisconnected(String reason) {
                final String text = reason == null ? "连接断开" : reason;
                display.callSerially(new Runnable() {
                    public void run() {
                        if (!connection.isAuthed()) {
                            midlet.showLogin(text);
                        }
                    }
                });
            }

            public void onSendResult(boolean ok, String messageId) {
                // 登录阶段忽略
            }

            public void onError(String message) {
                final String text = message == null ? "错误" : message;
                display.callSerially(new Runnable() {
                    public void run() {
                        if (!connection.isAuthed()) {
                            midlet.showLogin(text);
                        }
                    }
                });
            }
        });
        connection.connect();
    }
}
