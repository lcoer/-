package com.syl.bridge;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.util.List;

/**
 * SYL Bridge - 无障碍服务
 *
 * 用途:双鱼部落房间页有大量持续动效,系统 uiautomator dump 永远等不到 idle,
 *       导致读不到控件树。本 Service 通过 getRootInActiveWindow() 直接取节点树,
 *       绕开 idle 等待。仅本机调试使用,不联网、不上传数据。
 *
 * 指令方式(adb 广播):
 *   am broadcast -a com.syl.bridge.CMD --es cmd dump    --es out /sdcard/syl_ui.json
 *   am broadcast -a com.syl.bridge.CMD --es cmd tap     --es id iv_send
 *   am broadcast -a com.syl.bridge.CMD --es cmd tapxy   --ei x 100 --ei y 200
 *   am broadcast -a com.syl.bridge.CMD --es cmd text    --es id input_message --es value "你好"
 *   am broadcast -a com.syl.bridge.CMD --es cmd clicktext --es value "欢迎"
 */
public class SylAccessibilityService extends AccessibilityService {

    private static final String TAG = "SYLBridge";
    public static final String ACTION_CMD = "com.syl.bridge.CMD";
    // 输出目录:用应用内部私有目录(应用有完全写权限)。
    // 主机侧读法:adb shell run-as com.syl.bridge cat /data/data/com.syl.bridge/files/syl_ui.json
    // (因为 app 设为 debuggable=true,run-as 可用)
    public static final String OUT_DIR = "/data/data/com.syl.bridge/files";
    public static final String OUT_DEFAULT = OUT_DIR + "/syl_ui.json";

    private static SylAccessibilityService sInstance;

    public static SylAccessibilityService get() { return sInstance; }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        Log.i(TAG, "无障碍服务已连接 filesDir=" + filesDir());
        writeFile(OUT_DIR + "/ready.txt", "ready " + System.currentTimeMillis());
    }

    /** 供 Receiver 调用:拿到本服务的私有目录绝对路径 */
    public String getFilesDirPath() { return filesDir(); }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 不需要事件驱动,全部按需查询
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        sInstance = null;
        return super.onUnbind(intent);
    }

    // ================= 指令入口 =================
    public String handle(String cmd, String id, String value, int x, int y, String out, String requestId) {
        try {
            if ("dump".equals(cmd)) return doDump(out, requestId);
            if ("tap".equals(cmd)) return doTapId(id);
            if ("tapxy".equals(cmd)) return doTap(x, y);
            if ("text".equals(cmd)) return doSetText(id, value);
            if ("settextb64".equals(cmd)) return doSetTextB64(id, value);
            if ("appendtext".equals(cmd)) return doAppendText(id, value);
            if ("clicktext".equals(cmd)) return doClickText(value);
            if ("longclick".equals(cmd)) return doLongClickId(id);
            if ("ping".equals(cmd)) return "{\"ok\":true,\"connected\":true}";
            return "{\"ok\":false,\"error\":\"unknown cmd " + cmd + "\"}";
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"" + esc(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    private String doDump(String outPath, String requestId) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        String act = "";
        try {
            AccessibilityNodeInfo wi = getWindows() != null && getWindows().size() > 0
                    ? getWindows().get(0).getRoot() : null;
            if (wi != null) root = root != null ? root : wi;
        } catch (Exception ignored) {}
        org.json.JSONObject tree = new org.json.JSONObject(Dumper.dumpTree(root, act));
        tree.put("requestId", requestId).put("protocolVersion", CommandReceiver.PROTOCOL_VERSION);
        String json = tree.toString();
        boolean ok = CommandReceiver.writeAtomic(new File(outPath), json);
        return "{\"ok\":" + ok + ",\"out\":\"" + esc(outPath) + "\",\"rootNull\":" + (root == null) + "}";
    }

    private String doTapId(String id) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> list = Dumper.findById(root, id);
        if (list.isEmpty()) return "{\"ok\":false,\"error\":\"NOT_FOUND " + esc(id) + "\"}";
        AccessibilityNodeInfo target = null;
        for (AccessibilityNodeInfo n : list) if (n.isClickable()) { target = n; break; }
        if (target == null) target = list.get(0);
        return tapNode(target, id);
    }

    private String tapNode(AccessibilityNodeInfo node, String tag) {
        // 优先 ACTION_CLICK
        AccessibilityNodeInfo cur = node;
        for (int i = 0; i < 4 && cur != null; i++) {
            if (cur.isClickable()) {
                boolean ok = cur.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                return "{\"ok\":" + ok + ",\"via\":\"ACTION_CLICK\",\"tag\":\"" + esc(tag) + "\"}";
            }
            cur = cur.getParent();
        }
        // 退回坐标点击
        android.graphics.Rect r = new android.graphics.Rect();
        node.getBoundsInScreen(r);
        return doTap(r.centerX(), r.centerY());
    }

    private String doTap(int x, int y) {
        if (android.os.Build.VERSION.SDK_INT >= 24) {
            Path p = new Path();
            p.moveTo(x, y);
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(p, 0, 60);
            GestureDescription gd = new GestureDescription.Builder().addStroke(stroke).build();
            boolean ok = dispatchGesture(gd, null, null);
            return "{\"ok\":" + ok + ",\"via\":\"gesture\",\"x\":" + x + ",\"y\":" + y + "}";
        }
        return "{\"ok\":false,\"error\":\"gesture unsupported\"}";
    }

    private String doSetTextB64(String id, String b64) {
        try {
            byte[] raw = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            String value = new String(raw, "UTF-8");
            return doSetText(id, value);
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"B64_DECODE_FAILED\"}";
        }
    }

    private String doLongClickId(String id) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> list = Dumper.findById(root, id);
        if (list.isEmpty()) return "{\"ok\":false,\"error\":\"NOT_FOUND " + esc(id) + "\"}";
        AccessibilityNodeInfo cur = list.get(0);
        for (int i = 0; i < 4 && cur != null; i++) {
            if (cur.isLongClickable()) {
                boolean ok = cur.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK);
                if (ok) return "{\"ok\":true,\"via\":\"ACTION_LONG_CLICK\"}";
            }
            cur = cur.getParent();
        }
        return "{\"ok\":false,\"error\":\"NOT_LONG_CLICKABLE\"}";
    }

    private String doSetText(String id, String value) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> list = Dumper.findById(root, id);
        if (list.isEmpty()) return "{\"ok\":false,\"error\":\"NOT_FOUND " + esc(id) + "\"}";
        AccessibilityNodeInfo target = list.get(0);
        // 先聚焦
        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        return "{\"ok\":" + ok + ",\"via\":\"ACTION_SET_TEXT\"}";
    }

    private String doAppendText(String id, String value) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> list = Dumper.findById(root, id);
        if (list.isEmpty()) return "{\"ok\":false,\"error\":\"NOT_FOUND " + esc(id) + "\"}";
        AccessibilityNodeInfo target = list.get(0);
        CharSequence cur = target.getText();
        String merged = (cur == null ? "" : cur.toString()) + value;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        return "{\"ok\":" + ok + ",\"text\":\"" + esc(merged) + "\"}";
    }

    private String doClickText(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<AccessibilityNodeInfo> list = Dumper.findByText(root, text, false);
        if (list.isEmpty()) return "{\"ok\":false,\"error\":\"NOT_FOUND_TEXT " + esc(text) + "\"}";
        return tapNode(list.get(0), text);
    }

    // ================= 工具 =================
    private String filesDir() {
        // getFilesDir() 才是 100% 正确的应用私有目录
        try {
            java.io.File d = getFilesDir();
            if (d != null) {
                if (!d.exists()) d.mkdirs();
                return d.getAbsolutePath();
            }
        } catch (Exception ignored) {}
        return OUT_DIR;
    }

    private boolean writeFile(String path, String content) {
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(f, false);
            fos.write(content.getBytes("UTF-8"));
            fos.flush();
            fos.close();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "写文件失败 " + path + " : " + e.getMessage());
            return false;
        }
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }
}
