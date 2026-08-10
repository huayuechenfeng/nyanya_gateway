package com.nyanya.qqj2me.model;

public class Contact {
    public String id;
    public String name;
    public String remark;
    public boolean group;

    public Contact() {
        id = "";
        name = "";
        remark = "";
        group = false;
    }

    public String displayName() {
        if (remark != null && remark.length() > 0) return remark;
        if (name != null && name.length() > 0) return name;
        return id;
    }
}
