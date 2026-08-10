package com.nyanya.qqj2me.store;

import com.nyanya.qqj2me.model.ChatMessage;
import com.nyanya.qqj2me.util.Utf8;
import java.util.Vector;
import javax.microedition.rms.RecordEnumeration;
import javax.microedition.rms.RecordStore;
import javax.microedition.rms.RecordStoreException;

public class ConversationStore {
    private static final String META_STORE = "QQJ2ME_CTX";
    private static final String MSG_PREFIX = "QQJ2ME_MSG_";
    private static final int MAX_CONVERSATIONS = 50;
    private static final int MAX_MESSAGES = 60;
    private static final char SEP = '\u0001';

    public static class ConversationMeta {
        public String peer;
        public String chatType;
        public String name;
        public int unread;
        public String lastText;
        public long lastTime;

        public ConversationMeta() {
            peer = "";
            chatType = "private";
            name = "";
            unread = 0;
            lastText = "";
            lastTime = 0L;
        }
    }

    public Vector getConversations() {
        Vector result = new Vector();
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(META_STORE, false);
            RecordEnumeration enumeration = store.enumerateRecords(null, null, false);
            while (enumeration.hasNextElement()) {
                int id = enumeration.nextRecordId();
                ConversationMeta meta = parseMeta(Utf8.decode(store.getRecord(id)));
                if (meta != null && meta.peer != null && meta.peer.length() > 0) {
                    result.addElement(meta);
                }
            }
            enumeration.destroy();
        } catch (Exception e) {
            // ignore
        } finally {
            closeStore(store);
        }
        sortByTimeDesc(result);
        return result;
    }

    public void appendMessage(ChatMessage message) {
        if (message == null || message.peer == null || message.peer.length() == 0) return;
        appendMeta(message);
        appendMessageRecord(message);
    }

    public Vector getMessages(String peer, int max) {
        if (peer == null || peer.length() == 0) return new Vector();
        Vector result = new Vector();
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(messageStoreName(peer), false);
            RecordEnumeration enumeration = store.enumerateRecords(null, null, false);
            while (enumeration.hasNextElement()) {
                int id = enumeration.nextRecordId();
                ChatMessage message = parseMessage(Utf8.decode(store.getRecord(id)));
                if (message != null) result.addElement(message);
            }
            enumeration.destroy();
        } catch (Exception e) {
            // ignore
        } finally {
            closeStore(store);
        }
        while (result.size() > max && result.size() > 0) {
            result.removeElementAt(0);
        }
        return result;
    }

    public void markRead(String peer) {
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(META_STORE, false);
            RecordEnumeration enumeration = store.enumerateRecords(null, null, false);
            while (enumeration.hasNextElement()) {
                int id = enumeration.nextRecordId();
                ConversationMeta meta = parseMeta(Utf8.decode(store.getRecord(id)));
                if (meta != null && meta.peer.equals(peer)) {
                    meta.unread = 0;
                    byte[] data = Utf8.encode(encodeMeta(meta));
                    store.setRecord(id, data, 0, data.length);
                    break;
                }
            }
            enumeration.destroy();
        } catch (Exception e) {
            // ignore
        } finally {
            closeStore(store);
        }
    }

    private void appendMeta(ChatMessage message) {
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(META_STORE, true);
            int targetId = -1;
            int oldestId = -1;
            long oldestTime = Long.MAX_VALUE;
            ConversationMeta existing = null;
            RecordEnumeration enumeration = store.enumerateRecords(null, null, false);
            while (enumeration.hasNextElement()) {
                int id = enumeration.nextRecordId();
                ConversationMeta meta = parseMeta(Utf8.decode(store.getRecord(id)));
                if (meta == null) continue;
                if (meta.lastTime < oldestTime) {
                    oldestTime = meta.lastTime;
                    oldestId = id;
                }
                if (meta.peer.equals(message.peer)) {
                    targetId = id;
                    existing = meta;
                }
            }
            enumeration.destroy();

            ConversationMeta meta = new ConversationMeta();
            meta.peer = message.peer;
            meta.chatType = message.chatType;
            meta.name = message.peerName == null ? message.peer : message.peerName;
            meta.lastText = message.text == null ? "" : message.text;
            meta.lastTime = message.time;
            if (targetId >= 0) {
                meta.unread = existing == null ? 0 : existing.unread;
                if (message.incoming) {
                    meta.unread = existing == null ? 1 : existing.unread + 1;
                } else {
                    meta.unread = 0;
                }
                byte[] data = Utf8.encode(encodeMeta(meta));
                store.setRecord(targetId, data, 0, data.length);
            } else {
                meta.unread = message.incoming ? 1 : 0;
                byte[] data = Utf8.encode(encodeMeta(meta));
                store.addRecord(data, 0, data.length);
                if (store.getNumRecords() > MAX_CONVERSATIONS && oldestId >= 0) {
                    store.deleteRecord(oldestId);
                }
            }
        } catch (Exception e) {
            // ignore
        } finally {
            closeStore(store);
        }
    }

    private void appendMessageRecord(ChatMessage message) {
        String text = message.text;
        if (text == null) text = "";
        if (text.length() > 512) text = text.substring(0, 512);
        StringBuffer line = new StringBuffer(64 + text.length());
        line.append(message.incoming ? "1" : "0").append(SEP);
        line.append(escape(message.peerName == null ? "" : message.peerName)).append(SEP);
        line.append(message.time).append(SEP);
        line.append(escape(text));
        byte[] data = Utf8.encode(line.toString());
        RecordStore store = null;
        try {
            store = RecordStore.openRecordStore(messageStoreName(message.peer), true);
            store.addRecord(data, 0, data.length);
            if (store.getNumRecords() > MAX_MESSAGES) {
                RecordEnumeration enumeration = store.enumerateRecords(null, null, false);
                int firstId = enumeration.hasNextElement() ? enumeration.nextRecordId() : -1;
                enumeration.destroy();
                if (firstId >= 0) store.deleteRecord(firstId);
            }
        } catch (Exception e) {
            // ignore
        } finally {
            closeStore(store);
        }
    }

    private ConversationMeta parseMeta(String line) {
        if (line == null) return null;
        Vector parts = split(line, SEP);
        if (parts.size() < 6) return null;
        ConversationMeta meta = new ConversationMeta();
        meta.peer = (String) parts.elementAt(0);
        meta.chatType = (String) parts.elementAt(1);
        meta.name = unescape((String) parts.elementAt(2));
        try {
            meta.unread = Integer.parseInt((String) parts.elementAt(3));
        } catch (NumberFormatException e) {
            meta.unread = 0;
        }
        meta.lastText = unescape((String) parts.elementAt(4));
        try {
            meta.lastTime = Long.parseLong((String) parts.elementAt(5));
        } catch (NumberFormatException e) {
            meta.lastTime = 0L;
        }
        return meta;
    }

    private String encodeMeta(ConversationMeta meta) {
        StringBuffer line = new StringBuffer(64 + meta.lastText.length());
        line.append(meta.peer).append(SEP);
        line.append(meta.chatType).append(SEP);
        line.append(escape(meta.name)).append(SEP);
        line.append(meta.unread).append(SEP);
        line.append(escape(meta.lastText)).append(SEP);
        line.append(meta.lastTime);
        return line.toString();
    }

    private ChatMessage parseMessage(String line) {
        if (line == null) return null;
        Vector parts = split(line, SEP);
        if (parts.size() < 4) return null;
        ChatMessage message = new ChatMessage();
        message.incoming = ((String) parts.elementAt(0)).equals("1");
        message.peerName = unescape((String) parts.elementAt(1));
        try {
            message.time = Long.parseLong((String) parts.elementAt(2));
        } catch (NumberFormatException e) {
            message.time = 0L;
        }
        message.text = unescape((String) parts.elementAt(3));
        return message;
    }

    private Vector split(String line, char separator) {
        Vector result = new Vector();
        int start = 0;
        while (start <= line.length()) {
            int index = line.indexOf(separator, start);
            if (index < 0) {
                result.addElement(line.substring(start));
                break;
            }
            result.addElement(line.substring(start, index));
            start = index + 1;
        }
        return result;
    }

    private String escape(String value) {
        if (value == null) return "";
        StringBuffer out = new StringBuffer(value.length());
        int i;
        for (i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == SEP) out.append('\u0002');
            else out.append(ch);
        }
        return out.toString();
    }

    private String unescape(String value) {
        if (value == null) return "";
        StringBuffer out = new StringBuffer(value.length());
        int i;
        for (i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\u0002') out.append(SEP);
            else out.append(ch);
        }
        return out.toString();
    }

    private String messageStoreName(String peer) {
        String name = MSG_PREFIX + peer;
        if (name.length() > 32) name = name.substring(0, 32);
        return name;
    }

    private void sortByTimeDesc(Vector list) {
        int i;
        for (i = 1; i < list.size(); i++) {
            ConversationMeta current = (ConversationMeta) list.elementAt(i);
            int j = i - 1;
            while (j >= 0) {
                ConversationMeta previous = (ConversationMeta) list.elementAt(j);
                if (previous.lastTime >= current.lastTime) break;
                list.setElementAt(previous, j + 1);
                j--;
            }
            list.setElementAt(current, j + 1);
        }
    }

    private void closeStore(RecordStore store) {
        if (store == null) return;
        try {
            store.closeRecordStore();
        } catch (RecordStoreException e) {
            // ignore
        }
    }
}
