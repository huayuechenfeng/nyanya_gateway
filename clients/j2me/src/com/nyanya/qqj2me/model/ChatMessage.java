package com.nyanya.qqj2me.model;

public class ChatMessage {
    public String chatType;
    public String peer;
    public String peerName;
    public String text;
    public long time;
    public boolean incoming;
    public String messageId;

    public ChatMessage() {
        chatType = "private";
        peer = "";
        peerName = "";
        text = "";
        time = 0L;
        incoming = true;
        messageId = "";
    }
}
