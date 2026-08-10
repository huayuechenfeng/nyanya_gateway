package com.nyanya.qqj2me;

import com.nyanya.qqj2me.net.GatewayConnection;
import com.nyanya.qqj2me.store.ConversationStore;
import com.nyanya.qqj2me.store.SettingsStore;
import com.nyanya.qqj2me.ui.LoginScreen;
import com.nyanya.qqj2me.ui.MainScreen;
import javax.microedition.lcdui.Alert;
import javax.microedition.lcdui.AlertType;
import javax.microedition.lcdui.Display;
import javax.microedition.midlet.MIDlet;

public class QqMidlet extends MIDlet {
    private Display display;
    private SettingsStore settings;
    private ConversationStore conversations;
    private LoginScreen loginScreen;
    private MainScreen mainScreen;
    private boolean initialized;

    public void startApp() {
        if (!initialized) {
            display = Display.getDisplay(this);
            settings = new SettingsStore();
            settings.load();
            conversations = new ConversationStore();
            loginScreen = new LoginScreen(this, settings);
            initialized = true;
        }
        if (mainScreen != null) {
            // 恢复前台时回到主界面，不再踢回登录页
            display.setCurrent(mainScreen);
        } else {
            display.setCurrent(loginScreen);
        }
    }

    public void pauseApp() {
        // 保持连接
    }

    public void destroyApp(boolean unconditional) {
        if (mainScreen != null) {
            mainScreen.close();
            mainScreen = null;
        }
    }

    public Display getDisplay() {
        return display;
    }

    public SettingsStore getSettings() {
        return settings;
    }

    public ConversationStore getConversations() {
        return conversations;
    }

    public void onLoginSuccess(GatewayConnection connection) {
        mainScreen = new MainScreen(this, connection, conversations, settings);
        display.setCurrent(mainScreen);
    }

    public void backToMain() {
        if (mainScreen != null) {
            display.setCurrent(mainScreen);
        } else {
            display.setCurrent(loginScreen);
        }
    }

    public void showLogin(String message) {
        if (message != null && message.length() > 0) {
            Alert alert = new Alert("提示", message, null, AlertType.ERROR);
            alert.setTimeout(3000);
            display.setCurrent(alert, loginScreen);
        } else {
            display.setCurrent(loginScreen);
        }
    }

    public void exit() {
        destroyApp(false);
        notifyDestroyed();
    }
}
