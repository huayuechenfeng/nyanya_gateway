package com.nyanya.qqj2me.net;

import com.nyanya.qqj2me.model.ChatMessage;
import java.util.Vector;

public interface MessageListener {
    void onAuthResult(boolean ok, long serverTime, int offlineCount, String message);

    void onMessage(ChatMessage message);

    void onNotice(String text, long time);

    void onContacts(Vector friends, Vector groups);

    void onDisconnected(String reason);

    void onSendResult(boolean ok, String messageId);

    void onError(String message);
}
