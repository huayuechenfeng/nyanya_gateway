package com.nyanya.qqj2me.net;

import com.nyanya.qqj2me.model.ChatMessage;
import com.nyanya.qqj2me.model.Contact;
import com.nyanya.qqj2me.util.Json;
import com.nyanya.qqj2me.util.Utf8;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.Hashtable;
import java.util.Vector;
import javax.microedition.io.Connector;
import javax.microedition.io.SocketConnection;

public class GatewayConnection {
    private final String host;
    private final int port;
    private final String token;
    private final String device;
    private MessageListener listener;
    private SocketConnection socket;
    private DataInputStream input;
    private DataOutputStream output;
    private volatile boolean running;
    private volatile boolean authed;
    private int seq;
    private int heartbeatMs = 30000;

    public GatewayConnection(String host, int port, String device, String token) {
        this.host = host;
        this.port = port;
        this.device = device;
        this.token = token;
    }

    public void setListener(MessageListener listener) {
        this.listener = listener;
    }

    public boolean isAuthed() {
        return authed;
    }

    public synchronized void connect() {
        if (running) return;
        running = true;
        seq = 0;
        Thread thread = new Thread(new Runnable() {
            public void run() {
                runLoop();
            }
        });
        thread.start();
    }

    public synchronized void close() {
        running = false;
        closeQuietly();
    }

    public void sendText(String chatType, String peer, String text) {
        StringBuffer json = new StringBuffer(64 + text.length() * 2);
        json.append("{\"chatType\":").append(Json.quote(chatType));
        json.append(",\"peer\":").append(Json.quote(peer));
        json.append(",\"text\":").append(Json.quote(text)).append('}');
        try {
            send(FrameCodec.TYPE_SEND_TEXT, json.toString());
        } catch (IOException e) {
            closeQuietly();
        }
    }

    public void fetchContacts() {
        try {
            send(FrameCodec.TYPE_FETCH_CONTACTS, "{}");
        } catch (IOException e) {
            closeQuietly();
        }
    }

    public void sendReadAck(String peer) {
        try {
            send(FrameCodec.TYPE_READ_ACK, "{\"peer\":" + Json.quote(peer) + "}");
        } catch (IOException e) {
            // ignore
        }
    }

    private void runLoop() {
        int backoffMs = 1000;
        while (running) {
            try {
                openSocket();
                backoffMs = 1000;
                doAuthAndRead();
            } catch (IOException e) {
                closeQuietly();
                if (running && listener != null) {
                    listener.onDisconnected(e.getMessage() == null ? "网络错误" : e.getMessage());
                }
            } catch (Throwable t) {
                closeQuietly();
                if (running && listener != null) {
                    listener.onDisconnected(t.getMessage() == null ? "未知错误" : t.getMessage());
                }
            }
            if (!running) break;
            try {
                Thread.sleep(backoffMs);
            } catch (InterruptedException e) {
                break;
            }
            if (backoffMs < 30000) backoffMs *= 2;
        }
    }

    private void openSocket() throws IOException {
        socket = (SocketConnection) Connector.open("socket://" + host + ":" + port);
        socket.setSocketOption(SocketConnection.KEEPALIVE, 1);
        socket.setSocketOption(SocketConnection.DELAY, 0);
        input = socket.openDataInputStream();
        output = socket.openDataOutputStream();
    }

    private void doAuthAndRead() throws IOException {
        StringBuffer auth = new StringBuffer(64);
        auth.append("{\"device\":").append(Json.quote(device));
        auth.append(",\"token\":").append(Json.quote(token));
        auth.append(",\"protocolVersion\":").append(FrameCodec.PROTOCOL_VERSION);
        auth.append(",\"capabilities\":").append(FrameCodec.AUTH_CAPABILITIES_JSON).append('}');
        send(FrameCodec.TYPE_AUTH, auth.toString());
        byte[] header = new byte[FrameCodec.HEADER_SIZE];
        while (running) {
            input.readFully(header);
            int magic = ((header[0] & 0xff) << 8) | (header[1] & 0xff);
            int version = header[2] & 0xff;
            int type = header[3] & 0xff;
            int frameSeq = FrameCodec.readInt(header, 4);
            int length = FrameCodec.readInt(header, 8);
            if (magic != FrameCodec.MAGIC || version != FrameCodec.VERSION) {
                throw new IOException("帧头错误");
            }
            if (length < 0 || length > FrameCodec.MAX_PAYLOAD) {
                throw new IOException("帧过长");
            }
            byte[] payload = new byte[length];
            input.readFully(payload);
            String json = length == 0 ? "" : Utf8.decode(payload);
            handleFrame(type, frameSeq, json);
        }
    }

    private void handleFrame(int type, int frameSeq, String json) throws IOException {
        if (type == FrameCodec.TYPE_AUTH_OK) {
            Hashtable obj = Json.object(Json.parse(json));
            if (obj != null) {
                Object protocol = obj.get("protocolVersion");
                if (protocol != null && toLong(protocol) != FrameCodec.PROTOCOL_VERSION) {
                    throw new IOException("协议版本不兼容");
                }
                Object hb = obj.get("heartbeatMs");
                if (hb instanceof Integer) heartbeatMs = ((Integer) hb).intValue();
                else if (hb instanceof Long) heartbeatMs = (int) ((Long) hb).longValue();
                else if (hb instanceof String) {
                    try {
                        heartbeatMs = Integer.parseInt((String) hb);
                    } catch (NumberFormatException e) {
                        // keep default
                    }
                }
            }
            authed = true;
            startHeartbeat();
            if (listener != null) listener.onAuthResult(true, 0L, 0, null);
            return;
        }
        if (type == FrameCodec.TYPE_AUTH_FAIL) {
            Hashtable obj = Json.object(Json.parse(json));
            String message = obj == null ? null : Json.string(obj.get("message"));
            if (listener != null) listener.onAuthResult(false, 0L, 0, message == null ? "登录失败" : message);
            throw new IOException("auth failed");
        }
        if (type == FrameCodec.TYPE_MSG_PUSH) {
            Hashtable obj = Json.object(Json.parse(json));
            if (obj != null && listener != null) {
                ChatMessage message = parseChatMessage(obj);
                if (message.text != null && message.text.length() > 0) {
                    listener.onMessage(message);
                }
            }
            return;
        }
        if (type == FrameCodec.TYPE_NOTICE) {
            Hashtable obj = Json.object(Json.parse(json));
            if (obj != null && listener != null) {
                listener.onNotice(Json.string(obj.get("text")), toLong(obj.get("time")));
            }
            return;
        }
        if (type == FrameCodec.TYPE_CONTACTS_SYNC) {
            Hashtable obj = Json.object(Json.parse(json));
            if (obj != null && listener != null) {
                Vector friends = new Vector();
                Vector groups = new Vector();
                Vector friendArray = Json.array(obj.get("friends"));
                if (friendArray != null) {
                    int i;
                    for (i = 0; i < friendArray.size(); i++) {
                        Hashtable item = Json.object(friendArray.elementAt(i));
                        if (item == null) continue;
                        Contact contact = new Contact();
                        contact.id = Json.string(item.get("id"));
                        contact.name = Json.string(item.get("name"));
                        contact.remark = Json.string(item.get("remark"));
                        contact.group = false;
                        friends.addElement(contact);
                    }
                }
                Vector groupArray = Json.array(obj.get("groups"));
                if (groupArray != null) {
                    int i;
                    for (i = 0; i < groupArray.size(); i++) {
                        Hashtable item = Json.object(groupArray.elementAt(i));
                        if (item == null) continue;
                        Contact contact = new Contact();
                        contact.id = Json.string(item.get("id"));
                        contact.name = Json.string(item.get("name"));
                        contact.group = true;
                        groups.addElement(contact);
                    }
                }
                listener.onContacts(friends, groups);
            }
            return;
        }
        if (type == FrameCodec.TYPE_SEND_RESULT) {
            Hashtable obj = Json.object(Json.parse(json));
            boolean ok = false;
            String messageId = "";
            if (obj != null) {
                Object okValue = obj.get("ok");
                ok = okValue instanceof Boolean && ((Boolean) okValue).booleanValue();
                messageId = Json.string(obj.get("messageId"));
            }
            if (listener != null) listener.onSendResult(ok, messageId);
            return;
        }
        if (type == FrameCodec.TYPE_KICK) {
            if (listener != null) listener.onDisconnected("账号在其他设备登录");
            throw new IOException("kicked");
        }
        if (type == FrameCodec.TYPE_ERROR) {
            Hashtable obj = Json.object(Json.parse(json));
            String message = obj == null ? "错误" : Json.string(obj.get("message"));
            if (listener != null) listener.onError(message == null ? "错误" : message);
            return;
        }
        // PONG / HISTORY_PAGE 暂不处理
    }

    private ChatMessage parseChatMessage(Hashtable obj) {
        ChatMessage message = new ChatMessage();
        message.chatType = Json.string(obj.get("chatType"));
        if (message.chatType == null) message.chatType = "private";
        message.peer = Json.string(obj.get("peer"));
        message.peerName = Json.string(obj.get("senderName"));
        message.text = Json.string(obj.get("text"));
        message.time = toLong(obj.get("time"));
        message.messageId = Json.string(obj.get("messageId"));
        message.incoming = true;
        if (message.peer == null) message.peer = "";
        if (message.peerName == null) message.peerName = message.peer;
        if (message.text == null) message.text = "";
        if (message.messageId == null) message.messageId = "";
        return message;
    }

    private long toLong(Object value) {
        if (value instanceof Long) return ((Long) value).longValue();
        if (value instanceof Integer) return ((Integer) value).longValue();
        if (value instanceof String) {
            try {
                return Long.parseLong((String) value);
            } catch (NumberFormatException e) {
                return 0L;
            }
        }
        return 0L;
    }

    private void send(int type, String json) throws IOException {
        synchronized (this) {
            if (output == null) throw new IOException("未连接");
            byte[] frame = FrameCodec.encodeJson(type, ++seq, json);
            output.write(frame);
            output.flush();
        }
    }

    private void sendPing() throws IOException {
        send(FrameCodec.TYPE_PING, "{}");
    }

    private void startHeartbeat() {
        Thread thread = new Thread(new Runnable() {
            public void run() {
                while (running && authed) {
                    try {
                        Thread.sleep(heartbeatMs);
                    } catch (InterruptedException e) {
                        break;
                    }
                    if (!running || !authed) break;
                    try {
                        sendPing();
                    } catch (IOException e) {
                        closeQuietly();
                        break;
                    }
                }
            }
        });
        thread.start();
    }

    private void closeQuietly() {
        authed = false;
        try {
            if (output != null) output.close();
        } catch (IOException e) {
            // ignore
        }
        try {
            if (input != null) input.close();
        } catch (IOException e) {
            // ignore
        }
        try {
            if (socket != null) socket.close();
        } catch (IOException e) {
            // ignore
        }
        output = null;
        input = null;
        socket = null;
    }
}
