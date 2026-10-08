package com.syl.bridge;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 把 AccessibilityNodeInfo 树序列化成 JSON(结构与 uiautomator dump 对齐,便于复用解析逻辑)。
 */
public class Dumper {

    public static JSONObject nodeToJson(AccessibilityNodeInfo n) {
        JSONObject o = new JSONObject();
        try {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            o.put("text", n.getText() == null ? "" : n.getText().toString());
            o.put("contentDesc", n.getContentDescription() == null ? "" : n.getContentDescription().toString());
            o.put("resourceId", n.getViewIdResourceName() == null ? "" : n.getViewIdResourceName());
            o.put("className", n.getClassName() == null ? "" : n.getClassName().toString());
            o.put("packageName", n.getPackageName() == null ? "" : n.getPackageName().toString());
            o.put("clickable", n.isClickable());
            o.put("focusable", n.isFocusable());
            o.put("enabled", n.isEnabled());
            o.put("checkable", n.isCheckable());
            o.put("checked", n.isChecked());
            o.put("selected", n.isSelected());
            o.put("scrollable", n.isScrollable());
            o.put("editable", n.isEditable());
            o.put("bounds", "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]");
            o.put("x", r.left);
            o.put("y", r.top);
            o.put("x2", r.right);
            o.put("y2", r.bottom);
        } catch (Exception ignored) {
        }
        return o;
    }

    /** 递归收集所有节点(扁平数组),深度限制避免栈溢出 */
    public static void collect(AccessibilityNodeInfo n, JSONArray out, int depth) {
        if (n == null || depth > 60) return;
        out.put(nodeToJson(n));
        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            AccessibilityNodeInfo c = null;
            try {
                c = n.getChild(i);
                collect(c, out, depth + 1);
            } catch (Exception ignored) {
            }
        }
    }

    public static String dumpTree(AccessibilityNodeInfo root, String pageActivity) {
        JSONObject top = new JSONObject();
        try {
            top.put("ok", true);
            top.put("serviceConnected", true);
            top.put("activity", pageActivity == null ? "" : pageActivity);
            JSONArray arr = new JSONArray();
            if (root != null) collect(root, arr, 0);
            top.put("nodes", arr);
            top.put("count", arr.length());
        } catch (Exception e) {
            try { top.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
        }
        return top.toString();
    }

    /** 按 resource-id 找节点(取短 id 匹配) */
    public static List<AccessibilityNodeInfo> findById(AccessibilityNodeInfo root, String shortId) {
        List<AccessibilityNodeInfo> res = new ArrayList<>();
        findByIdRec(root, shortId, res, 0);
        return res;
    }

    private static void findByIdRec(AccessibilityNodeInfo n, String shortId, List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 60) return;
        String rid = n.getViewIdResourceName();
        if (rid != null && rid.endsWith("/" + shortId)) out.add(n);
        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            try { findByIdRec(n.getChild(i), shortId, out, depth + 1); } catch (Exception ignored) {}
        }
    }

    /** 按文本找节点 */
    public static List<AccessibilityNodeInfo> findByText(AccessibilityNodeInfo root, String text, boolean exact) {
        List<AccessibilityNodeInfo> res = new ArrayList<>();
        findByTextRec(root, text, exact, res, 0);
        return res;
    }

    private static void findByTextRec(AccessibilityNodeInfo n, String text, boolean exact,
                                      List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 60) return;
        CharSequence t = n.getText();
        if (t != null) {
            String s = t.toString();
            if (exact ? s.equals(text) : s.contains(text)) out.add(n);
        }
        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            try { findByTextRec(n.getChild(i), text, exact, out, depth + 1); } catch (Exception ignored) {}
        }
    }
}
